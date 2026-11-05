import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPool } from "../support/connection-budget.js";
import { runHostileSuite } from "../../src/demo/hostile.js";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { useBackend } from "../support/deps.js";
import { postgresHostileEnvironment } from "../support/hostile-env.js";
import { asAdmin, createTestDatabase, type TestDatabase } from "../support/pg.js";
import { seedWorld } from "../support/seed.js";

describe("the hostile conversation suite, on PostgreSQL with the real roles and policies", () => {
  let db: TestDatabase;
  let pg: PostgresDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
    pg = openPool({ url: db.appUrl, poolMax: 10 });
    useBackend({ create: () => pg, addTimeOff: async () => undefined });
  });
  afterAll(async () => {
    useBackend(undefined);
    await pg.close();
    await db.drop();
  });

  it("holds for every scenario", async () => {
    const results = await runHostileSuite(postgresHostileEnvironment(db));
    expect(results).toHaveLength(16);
    for (const r of results) {
      expect({ id: r.id, failures: r.failures, skipped: r.skipped }).toEqual({ id: r.id, failures: [], skipped: false });
    }
  });
});
