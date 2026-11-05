import pg from "pg";
import { expect, it } from "vitest";
import { createDemoDatabase } from "../../src/infrastructure/postgres/demo-database.js";
import { ADMIN_URL, describeDb } from "../support/pg.js";

describeDb("the demo database never touches a role that was there before (review finding)", () => {
  it("leaves an existing booking_app role, its password and its memberships alone, and removes what it made", async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'booking_app') THEN CREATE ROLE booking_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$");
      await admin.query("ALTER ROLE booking_app PASSWORD 'production-password-that-must-survive'");
      const before = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'booking_app'")).rows[0]?.rolpassword;
      const demo = await createDemoDatabase(ADMIN_URL);
      expect(new URL(demo.appUrl).username).toMatch(/^booking_demo_[0-9a-f]{10}$/);
      expect((await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'booking_app'")).rows[0]?.rolpassword).toBe(before);
      await demo.drop();
      const left = await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'booking_demo_%'");
      expect(left.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});
