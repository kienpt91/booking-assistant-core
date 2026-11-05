// The use case scenarios of test/contract, run on PostgreSQL through the real adapter and the real roles. They are the same
// scenarios the in-memory double passes in test/application/booking.test.ts.
import { afterAll, beforeAll, beforeEach } from "vitest";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { useBackend } from "../support/deps.js";
import { asAdmin, createTestDatabase, type TestDatabase } from "../support/pg.js";
import { seedWorld, W } from "../support/seed.js";
import "../contract/booking.scenarios.js";

let db: TestDatabase;
let pgdb: PostgresDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await asAdmin(db, seedWorld);
  pgdb = new PostgresDatabase({ url: db.appUrl, poolMax: 20 });
  useBackend({
    create: () => pgdb,
    addTimeOff: (_database, staffId, start, end) =>
      asAdmin(db, async (c) => {
        await c.query("INSERT INTO time_off (salon_id, staff_id, during) VALUES ($1, $2, tstzrange($3, $4, '[)'))", [W.salonA, staffId, new Date(start), new Date(end)]);
      }),
  });
});

beforeEach(async () => {
  await asAdmin(db, async (c) => {
    await c.query("TRUNCATE time_off, idempotency_keys, pending_actions, audit_log, outbox_messages, inbound_messages, conversation_turns, appointments, client_pii, clients");
  });
});

afterAll(async () => {
  useBackend(undefined);
  await pgdb.close();
  await db.drop();
});
