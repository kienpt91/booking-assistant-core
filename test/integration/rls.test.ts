import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, createTestDatabase, describeDb, failure, withClaims, type Claims, type TestDatabase } from "../support/pg.js";
import { insertAppointment, seedWorld, uid, W } from "../support/seed.js";

const clientA1: Claims = { role: "booking_client", salonId: W.salonA, clientId: W.clientA1 };
const clientA2: Claims = { role: "booking_client", salonId: W.salonA, clientId: W.clientA2 };
const clientB1: Claims = { role: "booking_client", salonId: W.salonB, clientId: W.clientB1 };
const staffA: Claims = { role: "booking_staff", salonId: W.salonA, staffId: W.staffA1 };
const staffB: Claims = { role: "booking_staff", salonId: W.salonB, staffId: W.staffB1 };
const systemA: Claims = { role: "booking_system", salonId: W.salonA };

const TABLES = [
  "salons", "staff", "services", "staff_services", "working_hours", "time_off", "salon_channels", "clients", "client_pii",
  "appointments", "pending_actions", "idempotency_keys", "inbound_messages", "outbox_messages", "conversation_turns", "audit_log",
];

describeDb("row level security: who can see and change what", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, async (c) => {
      await seedWorld(c);
      // A1 and A2 each have an appointment at salon A, B1 one at salon B
      await insertAppointment(c, { id: uid(1), client: W.clientA1, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" });
      await insertAppointment(c, { id: uid(2), client: W.clientA2, staff: W.staffA2, start: "2026-11-10T11:00:00Z", end: "2026-11-10T11:30:00Z" });
      await insertAppointment(c, { id: uid(3), salon: W.salonB, staff: W.staffB1, client: W.clientB1, service: W.cutB, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" });
      await c.query(
        `INSERT INTO conversation_turns (salon_id, client_id, role, body, created_at) VALUES ($1, $2, 'client', 'hello', now()), ($1, $3, 'client', 'hi', now())`,
        [W.salonA, W.clientA1, W.clientA2],
      );
      await c.query(
        `INSERT INTO outbox_messages (id, salon_id, client_id, dedupe_key, recipient_enc, body, next_attempt_at, created_at) VALUES ($1, $2, $3, 'k1', 'v1:x', 'hello', now(), now())`,
        [uid(50), W.salonA, W.clientA1],
      );
      await c.query(
        `INSERT INTO audit_log (id, salon_id, client_id, occurred_at, event) VALUES ($1, $2, $3, now(), 'tool_call'), ($4, $2, $5, now(), 'tool_call')`,
        [uid(60), W.salonA, W.clientA1, uid(61), W.clientA2],
      );
    });
  });
  afterAll(async () => {
    await db.drop();
  });

  const rows = async (claims: Claims, sql: string, params: unknown[] = []) => withClaims(db, claims, async (c) => (await c.query(sql, params)).rows);
  const ids = (list: { id: string }[]) => list.map((r) => r.id).sort();

  describe("the roles", () => {
    it("are not superusers, cannot bypass row level security and own nothing", async () => {
      const r = await asAdmin(db, (c) =>
        c.query(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ('booking_app', 'booking_client', 'booking_staff', 'booking_system')`),
      );
      expect(r.rows).toHaveLength(4);
      for (const role of r.rows) expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
      expect(r.rows.filter((x) => x.rolcanlogin).map((x) => x.rolname)).toEqual(["booking_app"]);
      const owned = await asAdmin(db, (c) => c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname LIKE 'booking_%'`));
      expect(owned.rows[0]?.n).toBe(0);
    });

    it("force row level security on every table, the owner included", async () => {
      const r = await asAdmin(db, (c) =>
        c.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations' ORDER BY relname`),
      );
      expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
      for (const t of r.rows) expect(t, t.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it("cannot be left for a role the login role is not a member of", async () => {
      const f = await failure(() => withClaims(db, clientA1, (c) => c.query("SET ROLE postgres")));
      expect(f?.code).toBe("42501");
    });
  });

  describe("without an identity", () => {
    it.each(TABLES.filter((t) => t !== "schema_migrations" && t !== "salon_channels"))("%s returns nothing, for every role that may read it", async (table) => {
      const roles = await asAdmin(db, (c) =>
        c.query<{ r: string }>(`SELECT r FROM unnest(ARRAY['booking_client','booking_staff','booking_system']) r WHERE has_table_privilege(r, $1, 'SELECT')`, [table]),
      );
      for (const { r } of roles.rows) {
        const count = await rows({ role: r as Claims["role"] }, `SELECT count(*)::int AS n FROM ${table}`);
        expect(count[0]?.n, `${r} on ${table}`).toBe(0);
      }
    });

    it("refuses a claim that is not a uuid instead of reading around it", async () => {
      const f = await failure(() => rows({ role: "booking_client", salonId: "not-a-uuid", clientId: W.clientA1 }, "SELECT * FROM appointments"));
      expect(f?.code).toBe("22P02");
    });
  });

  describe("a client", () => {
    it("sees only their own appointments, clients row and personal data", async () => {
      expect(ids(await rows(clientA1, "SELECT id FROM appointments"))).toEqual([uid(1)]);
      expect(ids(await rows(clientA2, "SELECT id FROM appointments"))).toEqual([uid(2)]);
      expect(await rows(clientA1, "SELECT id FROM clients")).toEqual([{ id: W.clientA1 }]);
      expect((await rows(clientA1, "SELECT client_id FROM client_pii")).map((r) => r.client_id)).toEqual([W.clientA1]);
      expect((await rows(clientA1, "SELECT id FROM salons")).map((r) => r.id)).toEqual([W.salonA]);
    });

    it("cannot read another client's appointment by naming its id", async () => {
      expect(await rows(clientA1, "SELECT id FROM appointments WHERE id = $1", [uid(2)])).toEqual([]);
      expect(await rows(clientA1, "SELECT id FROM appointments WHERE client_id = $1", [W.clientA2])).toEqual([]);
      expect(await rows(clientA1, "SELECT client_id FROM client_pii WHERE client_id = $1", [W.clientA2])).toEqual([]);
    });

    it("cannot read another salon's rows even with that salon's id in the query", async () => {
      expect(await rows(clientA1, "SELECT id FROM appointments WHERE salon_id = $1", [W.salonB])).toEqual([]);
      expect(await rows(clientA1, "SELECT id FROM staff WHERE salon_id = $1", [W.salonB])).toEqual([]);
      expect(await rows(clientB1, "SELECT id FROM services WHERE salon_id = $1", [W.salonA])).toEqual([]);
    });

    it("cannot change or lock another client's appointment: the statement touches no row", async () => {
      const upd = await withClaims(db, clientA1, (c) => c.query(`UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [uid(2)]));
      expect(upd.rowCount).toBe(0);
      const lock = await rows(clientA1, "SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [uid(2)]);
      expect(lock).toEqual([]);
      const still = await asAdmin(db, (c) => c.query("SELECT status FROM appointments WHERE id = $1", [uid(2)]));
      expect(still.rows[0]?.status).toBe("booked");
    });

    it("can change their own appointment", async () => {
      const upd = await withClaims(db, clientA1, (c) => c.query(`UPDATE appointments SET notes = 'window seat' WHERE id = $1`, [uid(1)]));
      expect(upd.rowCount).toBe(1);
    });

    it("cannot create an appointment for another client or another salon", async () => {
      const insert = (client: string, salon: string, staff: string, service: string, id: string) => (c: import("pg").Client) =>
        c.query(
          `INSERT INTO appointments (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'booked', '2026-11-12T10:00:00Z', '2026-11-12T10:30:00Z', 0, '2026-11-12T10:30:00Z', now(), now())`,
          [id, salon, staff, client, service],
        );
      // the row-level policy refuses these (a missing grant would say "permission denied for table")
      expect(await failure(() => withClaims(db, clientA1, insert(W.clientA2, W.salonA, W.staffA1, W.cut, uid(70))))).toMatchObject({ code: "42501", message: expect.stringContaining("row-level security") });
      expect(await failure(() => withClaims(db, clientA1, insert(W.clientB1, W.salonB, W.staffB1, W.cutB, uid(71))))).toMatchObject({ code: "42501", message: expect.stringContaining("row-level security") });
      expect(await failure(() => withClaims(db, clientA1, insert(W.clientA1, W.salonA, W.staffA1, W.cut, uid(72))))).toBeUndefined();
    });

    it("cannot hand an appointment to somebody else, move it across salons, or write a status only staff may set", async () => {
      // identity columns are not updatable at all (column grant); a status the client may not set is refused by the policy
      expect(await failure(() => withClaims(db, clientA1, (c) => c.query(`UPDATE appointments SET client_id = $2 WHERE id = $1`, [uid(1), W.clientA2])))).toMatchObject({ code: "42501", message: expect.stringContaining("permission denied") });
      expect(await failure(() => withClaims(db, clientA1, (c) => c.query(`UPDATE appointments SET salon_id = $2 WHERE id = $1`, [uid(1), W.salonB])))).toMatchObject({ code: "42501", message: expect.stringContaining("permission denied") });
      expect(await failure(() => withClaims(db, clientA1, (c) => c.query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [uid(1)])))).toMatchObject({ code: "42501", message: expect.stringContaining("row-level security") });
    });

    it("cannot delete anything, read the outbox or the inbox, or touch the catalog", async () => {
      expect((await failure(() => rows(clientA1, "DELETE FROM appointments WHERE id = $1", [uid(1)])))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "SELECT * FROM outbox_messages")))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "SELECT * FROM inbound_messages")))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "UPDATE services SET name = 'free' WHERE id = $1", [W.cut])))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "SELECT * FROM working_hours")))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "SELECT * FROM salon_channels")))?.code).toBe("42501");
    });

    it("sees only their own conversation and audit entries, and cannot rewrite or remove the audit trail", async () => {
      expect((await rows(clientA1, "SELECT body FROM conversation_turns")).map((r) => r.body)).toEqual(["hello"]);
      expect(ids(await rows(clientA1, "SELECT id FROM audit_log"))).toEqual([uid(60)]);
      expect((await failure(() => rows(clientA1, "UPDATE audit_log SET event = 'x'")))?.code).toBe("42501");
      expect((await failure(() => rows(clientA1, "DELETE FROM audit_log")))?.code).toBe("42501");
      const forged = await failure(() =>
        rows(clientA1, `INSERT INTO audit_log (id, salon_id, client_id, occurred_at, event) VALUES ($1, $2, $3, now(), 'tool_call')`, [uid(80), W.salonA, W.clientA2]),
      );
      expect(forged?.code).toBe("42501");
    });

    it("cannot reuse another client's idempotency key to read its answer", async () => {
      await asAdmin(db, (c) =>
        c.query(`INSERT INTO idempotency_keys (salon_id, actor_id, key, request_digest, response, created_at) VALUES ($1, $2, 'k', 'd', '{"secret":true}', now())`, [W.salonA, W.clientA2]),
      );
      expect(await rows(clientA1, "SELECT * FROM idempotency_keys WHERE key = 'k'")).toEqual([]);
      expect(await rows(clientA2, "SELECT * FROM idempotency_keys WHERE key = 'k'")).toHaveLength(1);
    });
  });

  describe("staff", () => {
    it("see their whole salon and nothing of another", async () => {
      expect(ids(await rows(staffA, "SELECT id FROM appointments"))).toEqual([uid(1), uid(2)]);
      expect(ids(await rows(staffB, "SELECT id FROM appointments"))).toEqual([uid(3)]);
      expect((await rows(staffA, "SELECT client_id FROM client_pii")).map((r) => r.client_id).sort()).toEqual([W.clientA1, W.clientA2]);
    });

    it("can cancel an appointment of their salon but not of another", async () => {
      const own = await withClaims(db, staffA, (c) => c.query(`UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [uid(2)]));
      expect(own.rowCount).toBe(1);
      const other = await withClaims(db, staffA, (c) => c.query(`UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [uid(3)]));
      expect(other.rowCount).toBe(0);
    });

    it("cannot write rows into another salon's catalog", async () => {
      const f = await failure(() => rows(staffA, `INSERT INTO staff (id, salon_id, name) VALUES ($1, $2, 'intruder')`, [uid(90), W.salonB]));
      expect(f?.code).toBe("42501");
    });
  });

  describe("the system role", () => {
    it("reads a whole salon, including who is busy, and the channel directory", async () => {
      expect(ids(await rows(systemA, "SELECT id FROM appointments"))).toEqual([uid(1), uid(2)]);
      expect(await rows({ role: "booking_system" }, "SELECT channel, address FROM salon_channels ORDER BY address")).toEqual([
        { channel: "chat", address: "salon-a" },
        { channel: "chat", address: "salon-b" },
      ]);
    });

    it("cannot create or delete appointments, and can only release or cancel", async () => {
      const create = await failure(() =>
        rows(systemA, `INSERT INTO appointments (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'booked', '2026-11-12T10:00:00Z', '2026-11-12T10:30:00Z', 0, '2026-11-12T10:30:00Z', now(), now())`, [uid(91), W.salonA, W.staffA1, W.clientA1, W.cut]),
      );
      expect(create?.code).toBe("42501");
      expect((await failure(() => rows(systemA, "DELETE FROM appointments")))?.code).toBe("42501");
    });

    it("works inside one salon only", async () => {
      expect(await rows({ role: "booking_system", salonId: W.salonB }, "SELECT id FROM appointments WHERE client_id = $1", [W.clientA1])).toEqual([]);
      const upd = await withClaims(db, { role: "booking_system", salonId: W.salonB }, (c) => c.query(`UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [uid(1)]));
      expect(upd.rowCount).toBe(0);
    });

    it("keeps the outbox to itself", async () => {
      expect(await rows(systemA, "SELECT id FROM outbox_messages")).toHaveLength(1);
      expect(await rows({ role: "booking_system", salonId: W.salonB }, "SELECT id FROM outbox_messages")).toEqual([]);
    });
  });
});
