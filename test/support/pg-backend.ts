import { afterAll, beforeAll, beforeEach } from "vitest";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { useBackend } from "./deps.js";
import { asAdmin, createTestDatabase, type TestDatabase } from "./pg.js";
import { seedWorld, W } from "./seed.js";

/**
 * Registers hooks that run the shared scenarios of test/contract on a real PostgreSQL: a fresh database with every migration and
 * the sample salons, the application's own login role, and the mutable tables emptied before each test.
 */
export function usePostgresBackend(): void {
  let db: TestDatabase;
  let pg: PostgresDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
    pg = new PostgresDatabase({ url: db.appUrl, poolMax: 20 });
    useBackend({
      create: () => pg,
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
    await pg.close();
    await db.drop();
  });
}
