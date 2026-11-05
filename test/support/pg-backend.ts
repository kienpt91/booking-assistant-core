import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { useBackend } from "./deps.js";
import { asAdmin, createTestDatabase, type TestDatabase } from "./pg.js";
import { seedWorld, W } from "./seed.js";

export interface PostgresBackend {
  /** runs statements as the superuser of the test database: seeding, and looking at what the application roles cannot */
  admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  /** connection string of the application's login role on the test database */
  readonly appUrl: string;
}

/**
 * Registers hooks that run the shared scenarios of test/contract on a real PostgreSQL: a fresh database with every migration and
 * the sample salons, the application's own login role, and the mutable tables emptied before each test.
 */
export function usePostgresBackend(): PostgresBackend {
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

  return {
    admin: (fn) => asAdmin(db, fn),
    get appUrl() {
      return db.appUrl;
    },
  };
}
