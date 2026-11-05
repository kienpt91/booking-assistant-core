import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { book, cancelAppointment, confirmHold, holdSlot, listMyAppointments, moveAppointment } from "../../src/application/booking.js";
import { resolveClient } from "../../src/application/clients.js";
import { dispatchOutbox } from "../../src/application/messaging.js";
import type { Deps } from "../../src/application/ports.js";
import type { Outcome } from "../../src/application/outcome.js";
import type { ClientActor } from "../../src/domain/actor.js";
import type { SalonId, ServiceId, StaffId } from "../../src/domain/ids.js";
import { normalizePhone } from "../../src/domain/phone.js";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { BarrierDatabase } from "../support/barrier-db.js";
import { FakeChannel } from "../support/channel.js";
import { at, newClient, testWorld, useBackend } from "../support/deps.js";
import { asAdmin, createTestDatabase, describeDb, type TestDatabase } from "../support/pg.js";
import { seedWorld, W } from "../support/seed.js";

const cut = W.cut as ServiceId;
const staff1 = W.staffA1 as StaffId;
const salonA = W.salonA as SalonId;
const system = { kind: "system", salonId: salonA } as const;
const TUE = "2026-11-10";
const SLOT = at(TUE, "10:00");
const ATTEMPTS = 50;

const codes = (results: readonly Outcome<unknown>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = r.ok ? "ok" : r.error.code;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

describeDb("concurrency: what the database guarantees when requests race", () => {
  let db: TestDatabase;
  let pg: PostgresDatabase;
  let control: TestDatabase;
  let controlPg: PostgresDatabase;

  const truncate = (target: TestDatabase) =>
    asAdmin(target, async (c) => {
      await c.query("TRUNCATE time_off, idempotency_keys, pending_actions, audit_log, outbox_messages, inbound_messages, conversation_turns, appointments, client_pii, clients");
    });
  const clientsOf = (deps: Deps, count: number): Promise<ClientActor[]> => Promise.all(Array.from({ length: count }, (_, i) => newClient(deps, i + 1)));
  const rowsAt = async (target: TestDatabase, status: string) =>
    asAdmin(target, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM appointments WHERE status = $1", [status])).rows[0]?.n));

  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
    pg = new PostgresDatabase({ url: db.appUrl, poolMax: 60 });
    useBackend({ create: () => pg, addTimeOff: async () => undefined });
    // a second database in which the exclusion constraints were dropped: the negative control
    control = await createTestDatabase();
    await asAdmin(control, async (c) => {
      await seedWorld(c);
      await c.query("ALTER TABLE appointments DROP CONSTRAINT appointments_staff_no_overlap, DROP CONSTRAINT appointments_client_no_overlap");
    });
    controlPg = new PostgresDatabase({ url: control.appUrl, poolMax: 60 });
  });
  beforeEach(async () => {
    await truncate(db);
    await truncate(control);
  });
  afterAll(async () => {
    useBackend(undefined);
    await pg.close();
    await controlPg.close();
    await db.drop();
    await control.drop();
  });

  describe("booking one slot", () => {
    it(`${ATTEMPTS} clients at the same moment: exactly one booking and ${ATTEMPTS - 1} conflicts, every attempt past its own availability check`, async () => {
      const world = testWorld();
      const clients = await clientsOf(world.deps, ATTEMPTS);
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, ATTEMPTS) };
      const results = await Promise.all(clients.map((c) => book(raced, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(codes(results)).toEqual({ ok: 1, slot_unavailable: ATTEMPTS - 1 });
      expect(await rowsAt(db, "booked")).toBe(1);
    });

    it(`${ATTEMPTS} clients without any synchronisation: still exactly one booking`, async () => {
      const world = testWorld();
      const clients = await clientsOf(world.deps, ATTEMPTS);
      const results = await Promise.all(clients.map((c) => book(world.deps, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(codes(results)).toEqual({ ok: 1, slot_unavailable: ATTEMPTS - 1 });
      expect(await rowsAt(db, "booked")).toBe(1);
    });

    it("with a pool of five connections the attempts queue and the result is the same", async () => {
      const small = new PostgresDatabase({ url: db.appUrl, poolMax: 5 });
      try {
        const world = testWorld();
        const clients = await clientsOf(world.deps, ATTEMPTS);
        const results = await Promise.all(clients.map((c) => book({ ...world.deps, db: small }, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
        expect(codes(results)).toEqual({ ok: 1, slot_unavailable: ATTEMPTS - 1 });
      } finally {
        await small.close();
      }
    });

    it("overlapping, not identical, start times: the buffer is part of what races", async () => {
      const world = testWorld();
      const clients = await clientsOf(world.deps, 20);
      const starts = Array.from({ length: 20 }, (_, i) => at(TUE, "10:00") + i * 15 * 60_000);
      // 10:00, 10:15, ..., 14:45: a 30 minute cut with a 10 minute buffer fits every 45 minutes, so 20 slots at 15 minute steps leave 5 winners at most
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, 20) };
      const results = await Promise.all(clients.map((c, i) => book(raced, c, { serviceId: cut, staffId: staff1, startsAt: starts[i] as number })));
      const winners = await asAdmin(db, async (c) => (await c.query("SELECT starts_at, blocked_until FROM appointments WHERE status = 'booked' ORDER BY starts_at")).rows);
      expect(results.filter((r) => r.ok)).toHaveLength(winners.length);
      for (let i = 1; i < winners.length; i++) expect(winners[i]?.starts_at.getTime()).toBeGreaterThanOrEqual(winners[i - 1]?.blocked_until.getTime());
      expect(winners.length).toBeGreaterThan(1);
      expect(winners.length).toBeLessThan(20);
    });

    it("the control: without the exclusion constraints the same race books the slot many times, so the test above can fail", async () => {
      const world = testWorld();
      const controlDeps: Deps = { ...world.deps, db: controlPg };
      const clients = await clientsOf(controlDeps, ATTEMPTS);
      const raced: Deps = { ...controlDeps, db: new BarrierDatabase(controlPg, ATTEMPTS) };
      const results = await Promise.all(clients.map((c) => book(raced, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(codes(results).ok).toBe(ATTEMPTS);
      expect(await rowsAt(control, "booked")).toBe(ATTEMPTS);
    });

    it("one client pressing the button twenty times: one booking, and with an idempotency key every press gets the same answer", async () => {
      const world = testWorld();
      const me = await newClient(world.deps, 1);
      const plain = await Promise.all(Array.from({ length: 20 }, () => book(world.deps, me, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(plain.filter((r) => r.ok)).toHaveLength(1);
      expect(plain.filter((r) => !r.ok).every((r) => !r.ok && (r.error.code === "slot_unavailable" || r.error.code === "client_overlap"))).toBe(true);

      await truncate(db);
      const me2 = await newClient(world.deps, 2);
      const keyed = await Promise.all(Array.from({ length: 20 }, () => book(world.deps, me2, { serviceId: cut, staffId: staff1, startsAt: SLOT, idempotencyKey: "webhook-msg-17:0" })));
      expect(keyed.every((r) => r.ok)).toBe(true);
      expect(new Set(keyed.map((r) => (r.ok ? r.value.id : ""))).size).toBe(1);
      expect(await rowsAt(db, "booked")).toBe(1);
    });
  });

  describe("holds", () => {
    it(`${ATTEMPTS} clients try to hold one slot: one hold`, async () => {
      const world = testWorld();
      const clients = await clientsOf(world.deps, ATTEMPTS);
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, ATTEMPTS) };
      const results = await Promise.all(clients.map((c) => holdSlot(raced, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(codes(results)).toEqual({ ok: 1, slot_unavailable: ATTEMPTS - 1 });
      expect(await rowsAt(db, "held")).toBe(1);
    });

    it("ten simultaneous confirmations of one hold: one booking, every answer is that booking", async () => {
      const world = testWorld();
      const me = await newClient(world.deps, 1);
      const hold = await holdSlot(world.deps, me, { serviceId: cut, staffId: staff1, startsAt: SLOT });
      if (!hold.ok) throw new Error("unexpected");
      const results = await Promise.all(Array.from({ length: 10 }, () => confirmHold(world.deps, me, hold.value.id)));
      expect(results.every((r) => r.ok && r.value.status === "booked")).toBe(true);
      expect(await rowsAt(db, "booked")).toBe(1);
      expect(await rowsAt(db, "held")).toBe(0);
    });

    it("a hold that ran out is released by the next attempt, even when many arrive together", async () => {
      const world = testWorld();
      const [holder, ...others] = await clientsOf(world.deps, 11);
      await holdSlot(world.deps, holder as ClientActor, { serviceId: cut, staffId: staff1, startsAt: SLOT });
      world.clock.advance(6 * 60_000);
      const results = await Promise.all(others.map((c) => book(world.deps, c, { serviceId: cut, staffId: staff1, startsAt: SLOT })));
      expect(codes(results)).toEqual({ ok: 1, slot_unavailable: 9 });
      expect(await rowsAt(db, "expired")).toBe(1);
    });
  });

  describe("moving and cancelling", () => {
    it("a move racing a cancel of the same appointment, thirty times: never a booking left behind, and the outcomes match their order", async () => {
      const world = testWorld();
      const me = await newClient(world.deps, 1);
      const outcomes: string[] = [];
      for (let i = 0; i < 30; i++) {
        const day = 12 + (i % 2);
        const created = await book(world.deps, me, { serviceId: cut, staffId: staff1, startsAt: at(`2026-11-${day}`, i < 15 ? "10:00" : "14:00") });
        if (!created.ok) throw new Error(`setup failed: ${created.error.code}`);
        const [moved, cancelled] = await Promise.all([
          moveAppointment(world.deps, me, { appointmentId: created.value.id, startsAt: at("2026-11-16", `${String(9 + (i % 7)).padStart(2, "0")}:00`) }),
          cancelAppointment(world.deps, me, { appointmentId: created.value.id }),
        ]);
        expect(cancelled.ok).toBe(true);
        outcomes.push(moved.ok ? "moved-then-cancelled" : `cancelled-first:${moved.error.code}`);
        expect(await rowsAt(db, "booked")).toBe(0);
        await asAdmin(db, async (c) => {
          await c.query("DELETE FROM appointments");
        });
      }
      for (const o of outcomes) expect(["moved-then-cancelled", "cancelled-first:not_active"]).toContain(o);
    });

    it("two clients moving onto the same free slot: one gets it, the other stays where they were", async () => {
      const world = testWorld();
      const [a, b] = await clientsOf(world.deps, 2);
      const x = await book(world.deps, a as ClientActor, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-11", "10:00") });
      const y = await book(world.deps, b as ClientActor, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-11", "14:00") });
      if (!x.ok || !y.ok) throw new Error("setup failed");
      const target = at("2026-11-12", "11:00");
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, 2) };
      const [mx, my] = await Promise.all([
        moveAppointment(raced, a as ClientActor, { appointmentId: x.value.id, startsAt: target }),
        moveAppointment(raced, b as ClientActor, { appointmentId: y.value.id, startsAt: target }),
      ]);
      expect([mx.ok, my.ok].filter(Boolean)).toHaveLength(1);
      const loser = mx.ok ? my : mx;
      expect(!loser.ok && loser.error.code).toBe("slot_unavailable");
      const starts = (await asAdmin(db, async (c) => (await c.query("SELECT starts_at FROM appointments WHERE status = 'booked' ORDER BY starts_at")).rows)).map((r) => r.starts_at.getTime());
      expect(starts).toHaveLength(2);
      expect(starts).toContain(target);
    });

    it("a move onto a slot that another client is booking at the same moment: exactly one of the two gets it", async () => {
      const world = testWorld();
      const [a, b] = await clientsOf(world.deps, 2);
      const mine = await book(world.deps, a as ClientActor, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-11", "10:00") });
      if (!mine.ok) throw new Error("setup failed");
      const target = at("2026-11-12", "11:00");
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, 2) };
      const [moved, booked] = await Promise.all([
        moveAppointment(raced, a as ClientActor, { appointmentId: mine.value.id, startsAt: target }),
        book(raced, b as ClientActor, { serviceId: cut, staffId: staff1, startsAt: target }),
      ]);
      expect([moved.ok, booked.ok].filter(Boolean)).toHaveLength(1);
      expect((await asAdmin(db, async (c) => (await c.query("SELECT 1 FROM appointments WHERE status = 'booked' AND starts_at = $1", [new Date(target)])).rowCount)) ?? 0).toBe(1);
    });

    it("a client is never offered, nor given, two appointments at once by racing requests", async () => {
      const world = testWorld();
      const me = await newClient(world.deps, 1);
      const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, 2) };
      const results = await Promise.all([
        book(raced, me, { serviceId: cut, staffId: staff1, startsAt: SLOT }),
        book(raced, me, { serviceId: cut, staffId: W.staffA2 as StaffId, startsAt: SLOT }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await listMyAppointments(world.deps, me)).toHaveLength(1);
    });
  });

  describe("messages and clients", () => {
    it("twenty first messages from one number create one client", async () => {
      const world = testWorld();
      const phone = normalizePhone("+44 7700 900200");
      if (!phone) throw new Error("bad phone");
      const results = await Promise.all(Array.from({ length: 20 }, () => resolveClient(world.deps, salonA, phone, "Sara")));
      expect(new Set(results.map((r) => r.actor.clientId)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await asAdmin(db, async (c) => (await c.query("SELECT count(*)::int AS n FROM clients")).rows[0]?.n)).toBe(1);
    });

    it("thirty deliveries of one message: one claim, then none until the lease runs out", async () => {
      const world = testWorld();
      const claim = (now: number) => world.deps.db.transaction(system, (tx) => tx.inbox.claim("chat", "wamid-1", now, 60_000));
      const first = await Promise.all(Array.from({ length: 30 }, () => claim(1_000_000)));
      expect(first.filter(Boolean)).toHaveLength(1);
      expect(await claim(1_030_000)).toBe(false);
      expect(await claim(1_060_000)).toBe(true); // the lease ended: a crashed worker's message is taken over
      await world.deps.db.transaction(system, (tx) => tx.inbox.complete("chat", "wamid-1", 1_061_000));
      expect(await claim(9_000_000)).toBe(false); // done stays done
    });

    it("five dispatchers at once send each of forty queued messages exactly once", async () => {
      const world = testWorld();
      const me = await newClient(world.deps, 1);
      await world.deps.db.transaction(system, async (tx) => {
        for (let i = 0; i < 40; i++) {
          await tx.outbox.enqueue({ id: `e1000000-0000-4000-8000-${String(i).padStart(12, "0")}`, clientId: me.clientId, dedupeKey: `k${i}`, recipientEnc: world.deps.cipher.encrypt("+447700900001"), body: `message ${i}`, now: world.clock.now() });
        }
      });
      const channel = new FakeChannel();
      const reports = await Promise.all(Array.from({ length: 5 }, () => dispatchOutbox(world.deps, channel, salonA, { batchSize: 10, leaseMs: 120_000, maxAttempts: 3, backoffMs: 1000 })));
      expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(40);
      expect(new Set(channel.sent.map((m) => m.idempotencyKey)).size).toBe(40);
      expect(channel.sent).toHaveLength(40);
    });
  });
});
