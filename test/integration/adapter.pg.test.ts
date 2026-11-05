import { describe, expect, it } from "vitest";
import { aad } from "../../src/application/aad.js";
import { turnRow } from "../support/messages.js";
import { book, listMyAppointments } from "../../src/application/booking.js";
import { eraseClient, eraseClientByPhone } from "../../src/application/clients.js";
import { replyJson, ScriptedModel, toolJson } from "../../src/application/assistant/fake-model.js";
import { applyRetention, releaseExpiredHolds } from "../../src/application/messaging.js";
import type { ClientActor } from "../../src/domain/actor.js";
import { BookingError } from "../../src/domain/errors.js";
import type { AppointmentId, ClientId, SalonId, ServiceId, StaffId } from "../../src/domain/ids.js";
import { normalizePhone, type E164 } from "../../src/domain/phone.js";
import { DAY, MINUTE } from "../../src/domain/time/instant.js";
import { Chat, PHONES } from "../support/chat.js";
import { at, newClient, testWorld } from "../support/deps.js";
import { usePostgresBackend } from "../support/pg-backend.js";
import { W } from "../support/seed.js";

const salonA = W.salonA as SalonId;
const cut = W.cut as ServiceId;
const staff1 = W.staffA1 as StaffId;
const system = { kind: "system", salonId: salonA } as const;
const TUE = "2026-11-10";
const backend = usePostgresBackend();

const slot = (hour: string) => ({ serviceId: cut, staffId: staff1, startsAt: at(TUE, hour) });

describe("isolation through the adapter", () => {
  it("a client cannot find, lock, change or list another client's appointment, whatever id they use", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const mine = await book(deps, a, slot("10:00"));
    if (!mine.ok) throw new Error("setup");
    const id = mine.value.id;
    await deps.db.transaction(b, async (tx) => {
      expect(await tx.appointments.find(id)).toBeUndefined();
      expect(await tx.appointments.lock(id)).toBeUndefined();
      expect(await tx.appointments.upcoming(deps.clock.now(), 10)).toEqual([]);
      await expect(tx.appointments.setStatus(id, "cancelled", deps.clock.now())).rejects.toMatchObject({ code: "not_found" });
      await expect(tx.appointments.reschedule(id, { staffId: staff1, startsAt: at(TUE, "12:00"), endsAt: at(TUE, "12:30"), bufferMinutes: 0, now: deps.clock.now() })).rejects.toMatchObject({ code: "not_found" });
      expect(await tx.clients.get(a.clientId)).toBeUndefined();
      expect(await tx.clients.getPii(a.clientId)).toBeUndefined();
    });
    expect((await listMyAppointments(deps, a))[0]?.id).toBe(id);
  });

  it("a staff member of another salon sees nothing of this salon", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const mine = await book(deps, a, slot("10:00"));
    if (!mine.ok) throw new Error("setup");
    const other = { kind: "staff", salonId: W.salonB as SalonId, staffId: W.staffB1 as StaffId } as const;
    await deps.db.transaction(other, async (tx) => {
      expect(await tx.appointments.find(mine.value.id)).toBeUndefined();
      expect(await tx.clients.get(a.clientId)).toBeUndefined();
      expect(await tx.catalog.getService(cut)).toBeUndefined();
      expect(await tx.catalog.getSalon()).toMatchObject({ name: "Salon B" });
    });
  });

  it("the operations that belong to the system role refuse every other actor before reaching the database", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    await deps.db.transaction(a, async (tx) => {
      await expect(tx.appointments.busy([staff1], { start: 0, end: 1 }, 0)).rejects.toThrow("system actor");
      await expect(tx.appointments.releaseExpiredHolds(0)).rejects.toThrow("system actor");
      await expect(tx.appointments.cancelFuture(a.clientId, 0)).rejects.toThrow("system actor");
      await expect(tx.clients.findByPhoneKey("x")).rejects.toThrow("system actor");
      await expect(tx.inbox.claim("chat", "m", 0, 1)).rejects.toThrow("system actor");
      await expect(tx.outbox.claimDue(0, 1, 1)).rejects.toThrow("system actor");
      await expect(tx.maintenance.purge({ conversationBefore: 0, outboxBefore: 0, inboxBefore: 0, idempotencyBefore: 0, pendingBefore: 0, auditBefore: 0 })).rejects.toThrow("system actor");
    });
    await deps.db.transaction(system, async (tx) => {
      await expect(tx.pending.findActive(0)).rejects.toThrow("client actor");
    });
  });

  it("even if the application forgot, the database refuses a client writing an audit entry for someone else", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const entry = { id: "e9000000-0000-4000-8000-000000000001", clientId: b.clientId, occurredAt: 1, messageId: null, step: 0, event: "tool_call" as const, tool: null, decision: null, reasons: [], args: null, outcome: null };
    await expect(deps.db.transaction(a, (tx) => tx.audit.append(entry))).rejects.toMatchObject({ code: "42501" });
  });

  it("a request without its identity claims sees nothing: the role switch alone is not enough", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    await book(deps, a, slot("10:00"));
    const forged = { kind: "client", salonId: salonA, clientId: "c1000000-0000-4000-8000-00000000ffff" as ClientId } as const;
    expect(await listMyAppointments(deps, forged)).toEqual([]);
  });
});

describe("constraints and savepoints", () => {
  it("maps an exclusion violation to a booking error and leaves the transaction usable", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    await book(deps, a, slot("10:00"));
    const result = await deps.db.transaction(b, async (tx) => {
      let refused: unknown;
      try {
        await tx.appointments.insert({ id: "d0000000-0000-4000-8000-000000000001" as AppointmentId, staffId: staff1, clientId: b.clientId, serviceId: cut, status: "booked", startsAt: at(TUE, "10:00"), endsAt: at(TUE, "10:30"), bufferMinutes: 10, holdExpiresAt: null, notes: null, now: deps.clock.now() });
      } catch (error) {
        refused = error;
      }
      // the same transaction goes on: a booking elsewhere in the day works
      const fine = await tx.appointments.insert({ id: "d0000000-0000-4000-8000-000000000002" as AppointmentId, staffId: staff1, clientId: b.clientId, serviceId: cut, status: "booked", startsAt: at(TUE, "15:00"), endsAt: at(TUE, "15:30"), bufferMinutes: 10, holdExpiresAt: null, notes: null, now: deps.clock.now() });
      return { refused, fine };
    });
    expect(result.refused).toBeInstanceOf(BookingError);
    expect((result.refused as BookingError).code).toBe("slot_unavailable");
    expect(result.fine.startsAt).toBe(at(TUE, "15:00"));
  });

  it("runs a transaction again after a deadlock or serialization failure, a bounded number of times, and not after anything else", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const failing = (code: string) => Object.assign(new Error("simulated"), { code });
    let calls = 0;
    const result = await deps.db.transaction(a, async () => {
      if (++calls < 2) throw failing("40001");
      return "done";
    });
    expect([result, calls]).toEqual(["done", 2]);

    calls = 0;
    await expect(deps.db.transaction(a, async () => { calls++; throw failing("40P01"); })).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(3);

    calls = 0;
    await expect(deps.db.transaction(a, async () => { calls++; throw failing("23505"); })).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });

  it("rolls everything back when the work throws", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    await expect(
      deps.db.transaction(a, async (tx) => {
        await tx.appointments.insert({ id: "d0000000-0000-4000-8000-000000000003" as AppointmentId, staffId: staff1, clientId: a.clientId, serviceId: cut, status: "booked", startsAt: at(TUE, "10:00"), endsAt: at(TUE, "10:30"), bufferMinutes: 10, holdExpiresAt: null, notes: null, now: deps.clock.now() });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await listMyAppointments(deps, a)).toEqual([]);
  });

  it("refuses a salon with a time zone this runtime does not know", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    await backend.admin((c) => c.query("UPDATE salons SET time_zone = 'Mars/Olympus_Mons' WHERE id = $1", [salonA]));
    try {
      await expect(deps.db.transaction(a, (tx) => tx.catalog.getSalon())).rejects.toThrow("time zone");
    } finally {
      await backend.admin((c) => c.query("UPDATE salons SET time_zone = 'Europe/London' WHERE id = $1", [salonA]));
    }
  });

  it("answers the channel directory from the system role, without a salon claim", async () => {
    const { deps } = testWorld();
    expect(await deps.db.channels.salonFor("chat", "salon-a")).toBe(W.salonA);
    expect(await deps.db.channels.salonFor("chat", "salon-b")).toBe(W.salonB);
    expect(await deps.db.channels.salonFor("chat", "nobody")).toBeUndefined();
    expect(await deps.db.channels.salonFor("sms", "salon-a")).toBeUndefined();
    expect((await deps.db.channels.salonsWithChannels()).sort()).toEqual([W.salonA, W.salonB]);
    await deps.db.ping();
  });
});

describe("records the audit trail, the conversation and the proposals", () => {
  it("keeps the audit order, counts by filter, and writes a fixed id once", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const entry = (n: number, over: Record<string, unknown> = {}) => ({
      id: `e9000000-0000-4000-8000-00000000000${n}`,
      clientId: a.clientId,
      occurredAt: deps.clock.now(),
      messageId: "m1",
      step: n,
      event: "tool_call" as const,
      tool: "cancel",
      decision: "confirm" as const,
      reasons: ["confirmation_required"],
      args: { appointment_id: "x", phone: "+966501234567" },
      outcome: null,
      ...over,
    });
    await deps.db.transaction(a, async (tx) => {
      await tx.audit.append(entry(1));
      await tx.audit.append(entry(2, { decision: "deny", reasons: ["not_found"] }));
      await tx.audit.append(entry(3, { event: "tool_executed", decision: null, outcome: "ok" }));
      await tx.audit.append(entry(3, { event: "tool_executed", decision: null, outcome: "ok" }));
    });
    const recent = await deps.db.transaction(a, (tx) => tx.audit.recent(10));
    expect(recent.map((e) => e.step)).toEqual([3, 2, 1]);
    const since = deps.clock.now() - DAY;
    await deps.db.transaction(a, async (tx) => {
      expect(await tx.audit.count({ event: "tool_call", tools: ["cancel", "book"], since })).toBe(2);
      expect(await tx.audit.count({ event: "tool_call", tools: ["cancel"], decision: "confirm", since })).toBe(1);
      expect(await tx.audit.count({ event: "tool_executed", tools: ["cancel"], outcome: "ok", since })).toBe(1);
      expect(await tx.audit.count({ event: "tool_executed", tools: ["book"], outcome: "ok", since })).toBe(0);
      expect(await tx.audit.count({ event: "tool_call", tools: ["cancel"], since: deps.clock.now() + 1 })).toBe(0);
    });
    // the stored arguments are what the caller passed: redaction is the caller's job (see the PII scan below)
    expect(recent[2]?.args).toEqual({ appointment_id: "x", phone: "+966501234567" });
  });

  it("keeps a short conversation in order, trimmed to the newest turns", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    await deps.db.transaction(system, async (tx) => {
      for (let i = 0; i < 12; i++) await tx.conversation.append(turnRow(deps, salonA, { clientId: a.clientId, role: i % 2 === 0 ? "client" : "assistant" as "client" | "assistant", text: `turn ${i}`, now: deps.clock.now() + i }));
      await tx.conversation.trim(a.clientId, 10);
    });
    const recent = await deps.db.transaction(a, (tx) => tx.conversation.recent(4));
    expect(recent.map((t) => deps.messageCipher.decrypt(t.bodyEnc, aad.turn(salonA, t.id)))).toEqual(["turn 8", "turn 9", "turn 10", "turn 11"]);
    expect(await deps.db.transaction(a, (tx) => tx.conversation.recent(50))).toHaveLength(10);
  });

  it("allows one active proposal per client, the new one replacing the old, and expires them", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const proposal = (id: string) => ({ id, clientId: a.clientId, tool: "cancel" as const, args: { appointment_id: "x", expected_version: 1 }, argsDigest: "d", holdAppointmentId: null, createdAt: clock.now(), expiresAt: clock.now() + 5 * MINUTE });
    await deps.db.transaction(a, async (tx) => {
      await tx.pending.create(proposal("e8000000-0000-4000-8000-000000000001"));
      await tx.pending.create(proposal("e8000000-0000-4000-8000-000000000002"));
    });
    const active = await deps.db.transaction(a, (tx) => tx.pending.findActive(clock.now()));
    expect(active).toMatchObject({ id: "e8000000-0000-4000-8000-000000000002", tool: "cancel", args: { appointment_id: "x", expected_version: 1 } });
    expect(await deps.db.transaction(a, (tx) => tx.pending.findActive(clock.now() + 6 * MINUTE))).toBeUndefined();
    const resolved = await deps.db.transaction(a, (tx) => tx.pending.resolveActive("declined", clock.now()));
    expect(resolved.map((p) => p.id)).toEqual(["e8000000-0000-4000-8000-000000000002"]);
    expect(await deps.db.transaction(a, (tx) => tx.pending.findActive(clock.now()))).toBeUndefined();
  });

  it("stores a retry key and its answer, and refuses nothing it should return", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    await deps.db.transaction(a, async (tx) => {
      await tx.idempotency.lock("k");
      expect(await tx.idempotency.find("k")).toBeUndefined();
      await tx.idempotency.store("k", "digest-1", { id: "x", n: 1, nested: { ok: true } }, clock.now());
    });
    expect(await deps.db.transaction(a, (tx) => tx.idempotency.find("k"))).toEqual({ requestDigest: "digest-1", response: { id: "x", n: 1, nested: { ok: true } } });
    expect(await deps.db.transaction(await newClient(deps, 2), (tx) => tx.idempotency.find("k"))).toBeUndefined();
  });
});

describe("outbox lifecycle", () => {
  it("leases, retries with a delay, gives up, and enqueues once per dedupe key", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const now = clock.now();
    await deps.db.transaction(system, async (tx) => {
      expect(await tx.outbox.enqueue({ id: "e7000000-0000-4000-8000-000000000001", clientId: a.clientId, dedupeKey: "k", recipientEnc: "v2:x", bodyEnc: "v2:hello", now })).toBe(true);
      expect(await tx.outbox.enqueue({ id: "e7000000-0000-4000-8000-000000000002", clientId: a.clientId, dedupeKey: "k", recipientEnc: "v2:x", bodyEnc: "v2:again", now })).toBe(false);
    });
    const first = await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now, 10, MINUTE));
    expect(first).toMatchObject([{ id: "e7000000-0000-4000-8000-000000000001", attempts: 1, bodyEnc: "v2:hello" }]);
    expect(await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now, 10, MINUTE))).toEqual([]); // leased
    await deps.db.transaction(system, (tx) => tx.outbox.markFailed("e7000000-0000-4000-8000-000000000001", now + 30_000));
    expect(await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now + 10_000, 10, MINUTE))).toEqual([]); // not due yet
    const second = await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now + 30_000, 10, MINUTE));
    expect(second[0]?.attempts).toBe(2);
    await deps.db.transaction(system, (tx) => tx.outbox.markFailed("e7000000-0000-4000-8000-000000000001", null));
    expect(await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now + 10 * MINUTE, 10, MINUTE))).toEqual([]);
    const status = await backend.admin((c) => c.query("SELECT status FROM outbox_messages"));
    expect(status.rows).toEqual([{ status: "dead" }]);
  });
});

describe("personal data", () => {
  it("never reaches the database in the clear: a whole conversation, then a scan of every text column", async () => {
    const world = testWorld();
    const model = new ScriptedModel([
      toolJson("check_availability", { service_id: cut, date_from: TUE }),
      replyJson("Free at 10:00."),
      toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-10T10:00:00+00:00", notes: "window seat" }),
      replyJson("Noted, Sara."),
    ]);
    const chat = new Chat(world.deps, model);
    await chat.send(PHONES.c1, "Hi, I am Sara, my number is +44 7700 900001 and my email is sara.q@example.com", { name: "Sara Quinn" });
    await chat.send(PHONES.c1, "book 10 with a window seat");
    await chat.send(PHONES.c1, "yes");
    await chat.send(PHONES.c1, "thanks Sara");

    const needles = ["7700900001", "7700 900001", "447700900001", "Sara", "Quinn", "sara.q", "example.com"];
    const found: string[] = [];
    await backend.admin(async (c) => {
      const columns = await c.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> 'schema_migrations' AND (data_type IN ('text', 'jsonb') OR udt_name = '_text')`,
      );
      for (const { table_name, column_name } of columns.rows) {
        for (const needle of needles) {
          const hit = await c.query(`SELECT count(*)::int AS n FROM ${table_name} WHERE ${column_name}::text ILIKE $1`, [`%${needle}%`]);
          if (Number(hit.rows[0]?.n) > 0) found.push(`${table_name}.${column_name} contains ${needle}`);
        }
      }
    });
    // every text column was scanned for the number, the e-mail address and the name: none of them is in the clear anywhere
    expect(found).toEqual([]);
    const sealedText = await backend.admin((c) => c.query("SELECT (SELECT bool_and(body_enc ~ '^v2:k1:') FROM outbox_messages) AS outbox, (SELECT bool_and(body_enc ~ '^v2:k1:') FROM conversation_turns) AS turns"));
    expect(sealedText.rows[0]).toEqual({ outbox: true, turns: true });
    const sealed = await backend.admin((c) => c.query("SELECT phone_enc, name_enc, phone_hash FROM client_pii"));
    expect(sealed.rows[0]).toMatchObject({ phone_enc: expect.stringMatching(/^v2:k1:/), name_enc: expect.stringMatching(/^v2:k1:/), phone_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("erases a client: personal data, conversation, queued replies, proposals and stored answers are gone; history keeps its shape", async () => {
    const world = testWorld();
    const { deps } = world;
    const model = new ScriptedModel([toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-10T10:00:00+00:00", notes: "window seat" }), replyJson("ok")]);
    const chat = new Chat(deps, model);
    await chat.send(PHONES.c1, "book 10", { name: "Sara Quinn" });
    await chat.send(PHONES.c1, "yes");
    const other = await newClient(deps, 2, W.salonA, "Other Person");
    await book(deps, other, slot("14:00"));
    const me = (await newClient(deps, 1)) as ClientActor;

    const phone = normalizePhone(PHONES.c1) as E164;
    expect((await eraseClientByPhone(deps, system, phone)).ok).toBe(true);

    const rows = await backend.admin(async (c) => ({
      pii: (await c.query("SELECT client_id FROM client_pii")).rows.map((r) => r.client_id),
      client: (await c.query("SELECT status, erased_at FROM clients WHERE id = $1", [me.clientId])).rows[0],
      notes: (await c.query("SELECT notes, status FROM appointments WHERE client_id = $1", [me.clientId])).rows,
      turns: (await c.query("SELECT count(*)::int AS n FROM conversation_turns WHERE client_id = $1", [me.clientId])).rows[0]?.n,
      outbox: (await c.query("SELECT count(*)::int AS n FROM outbox_messages WHERE client_id = $1", [me.clientId])).rows[0]?.n,
      pending: (await c.query("SELECT count(*)::int AS n FROM pending_actions WHERE client_id = $1", [me.clientId])).rows[0]?.n,
      keys: (await c.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE actor_id = $1", [me.clientId])).rows[0]?.n,
      audit: (await c.query("SELECT count(*)::int AS n FROM audit_log WHERE client_id = $1", [me.clientId])).rows[0]?.n,
      otherNotes: (await c.query("SELECT count(*)::int AS n FROM client_pii WHERE client_id = $1", [other.clientId])).rows[0]?.n,
    }));
    expect(rows.pii).toEqual([other.clientId]);
    expect(rows.client).toMatchObject({ status: "erased" });
    expect(rows.client.erased_at).toBeInstanceOf(Date);
    expect(rows.notes).toEqual([{ notes: null, status: "cancelled" }]);
    expect([rows.turns, rows.outbox, rows.pending, rows.keys]).toEqual([0, 0, 0, 0]);
    expect(rows.audit).toBeGreaterThan(0); // the audit trail stays: it holds no personal data
    expect(rows.otherNotes).toBe(1);
    expect((await eraseClient(deps, system, me.clientId)).ok).toBe(true); // a second erasure is harmless
  });

  it("applies retention to the old rows of one salon only", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    await deps.db.transaction(system, async (tx) => {
      await tx.conversation.append(turnRow(deps, salonA, { clientId: a.clientId, role: "client" as "client" | "assistant", text: "old", now: clock.now() }));
      await tx.inbox.claim("chat", "old", clock.now(), 1000);
      await tx.inbox.complete("chat", "old", 1, clock.now());
    });
    clock.advance(60 * DAY);
    const report = await applyRetention(deps, salonA);
    expect(report).toMatchObject({ conversation: 1, inbox: 1 });
    expect(await backend.admin((c) => c.query("SELECT count(*)::int AS n FROM client_pii"))).toMatchObject({ rows: [{ n: 1 }] });
  });

  it("releases holds that were not confirmed", async () => {
    const world = testWorld();
    const { deps, clock } = world;
    const chat = new Chat(deps, new ScriptedModel([toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-10T10:00:00+00:00" })]));
    await chat.send(PHONES.c1, "book 10");
    clock.advance(6 * MINUTE);
    expect(await releaseExpiredHolds(deps, salonA)).toBe(1);
    expect((await backend.admin((c) => c.query("SELECT status FROM appointments"))).rows).toEqual([{ status: "expired" }]);
  });
});
