import { afterAll, beforeAll, expect, it } from "vitest";
import { book } from "../../src/application/booking.js";
import type { Deps } from "../../src/application/ports.js";
import type { ServiceId, StaffId } from "../../src/domain/ids.js";
import { BarrierDatabase } from "../support/barrier-db.js";
import { openPool } from "../support/connection-budget.js";
import { at, newClient, testWorld, useBackend } from "../support/deps.js";
import { asAdmin, createTestDatabase, describeDb, type TestDatabase } from "../support/pg.js";
import { seedWorld, W } from "../support/seed.js";
import type { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";

const ATTEMPTS = 50;

// The negative control of the concurrency proof, in a file of its own so that it has the pool to itself: the 50 racers of
// concurrency.test.ts and these 50 would not fit in the connections of a default PostgreSQL server at the same time.
describeDb("negative control: the same race on a database whose exclusion constraints were dropped", () => {
  let control: TestDatabase;
  let pg: PostgresDatabase;

  beforeAll(async () => {
    control = await createTestDatabase();
    await asAdmin(control, async (c) => {
      await seedWorld(c);
      await c.query("ALTER TABLE appointments DROP CONSTRAINT appointments_staff_no_overlap, DROP CONSTRAINT appointments_client_no_overlap");
    });
    pg = openPool({ url: control.appUrl, poolMax: ATTEMPTS });
    useBackend({ create: () => pg, addTimeOff: async () => undefined });
  });
  afterAll(async () => {
    useBackend(undefined);
    await pg.close();
    await control.drop();
  });

  it(`${ATTEMPTS} clients at the same moment book the slot ${ATTEMPTS} times: the proof in concurrency.test.ts can fail`, async () => {
    const world = testWorld();
    const clients = await Promise.all(Array.from({ length: ATTEMPTS }, (_, i) => newClient(world.deps, i + 1)));
    const raced: Deps = { ...world.deps, db: new BarrierDatabase(pg, ATTEMPTS) };
    const results = await Promise.all(clients.map((c) => book(raced, c, { serviceId: W.cut as ServiceId, staffId: W.staffA1 as StaffId, startsAt: at("2026-11-10", "10:00") })));
    expect(results.filter((r) => r.ok)).toHaveLength(ATTEMPTS);
    const rows = await asAdmin(control, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM appointments WHERE status = 'booked'")).rows[0]?.n));
    expect(rows).toBe(ATTEMPTS);
  });
});
