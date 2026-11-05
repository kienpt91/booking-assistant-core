import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, describeDb, asAdmin, failure, MIGRATIONS, type TestDatabase } from "../support/pg.js";
import { insertAppointment, seedWorld, uid, W } from "../support/seed.js";
import { migrate } from "../../src/infrastructure/postgres/migrate.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describeDb("schema: the database refuses what the rules forbid", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await asAdmin(db, (c) => c.query("DELETE FROM appointments"));
  });

  const run = (fn: Parameters<typeof asAdmin>[1]) => asAdmin(db, fn);

  describe("double booking (exclusion constraint appointments_staff_no_overlap)", () => {
    it("refuses the same slot for the same staff member, whoever asks", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      const f = await failure(() => run((c) => insertAppointment(c, { id: uid(2), client: W.clientA2, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })));
      expect(f).toMatchObject({ code: "23P01", constraint: "appointments_staff_no_overlap" });
    });

    it("refuses a partial overlap on either side", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      for (const [start, end] of [
        ["2026-11-10T10:15:00Z", "2026-11-10T10:45:00Z"],
        ["2026-11-10T09:45:00Z", "2026-11-10T10:15:00Z"],
        ["2026-11-10T09:00:00Z", "2026-11-10T11:00:00Z"],
      ] as const) {
        const f = await failure(() => run((c) => insertAppointment(c, { id: uid(9), client: W.clientA2, start, end })));
        expect(f?.constraint).toBe("appointments_staff_no_overlap");
      }
    });

    it("lets back-to-back appointments touch, and keeps the buffer free", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z", buffer: 10 }));
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(2), client: W.clientA2, start: "2026-11-10T10:30:00Z", end: "2026-11-10T11:00:00Z" })))).toMatchObject({ constraint: "appointments_staff_no_overlap" });
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(3), client: W.clientA2, start: "2026-11-10T10:40:00Z", end: "2026-11-10T11:10:00Z" })))).toBeUndefined();
      // before the first one: 09:30 to 10:00 with a 10 minute buffer would run into 10:00
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(4), client: W.clientA2, start: "2026-11-10T09:30:00Z", end: "2026-11-10T10:00:00Z", buffer: 10, service: W.cut })))).toMatchObject({ constraint: "appointments_staff_no_overlap" });
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(5), client: W.clientA2, start: "2026-11-10T09:00:00Z", end: "2026-11-10T09:30:00Z", buffer: 10 })))).toBeUndefined();
    });

    it("lets two staff members work at the same time", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(2), staff: W.staffA2, client: W.clientA2, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toBeUndefined();
    });

    it("counts held and booked rows and ignores cancelled, expired and completed ones", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), status: "held", start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(2), client: W.clientA2, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toMatchObject({ code: "23P01" });
      await run((c) => c.query("DELETE FROM appointments"));
      for (const [n, status] of [
        [1, "cancelled"],
        [2, "expired"],
        [3, "completed"],
      ] as const) {
        await run((c) => insertAppointment(c, { id: uid(n), status, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      }
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(4), client: W.clientA2, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toBeUndefined();
    });

    it("refuses an update that moves a booking onto another one, and allows a move within its own time", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      await run((c) => insertAppointment(c, { id: uid(2), client: W.clientA2, start: "2026-11-10T12:00:00Z", end: "2026-11-10T12:30:00Z" }));
      const onto = await failure(() =>
        run((c) => c.query(`UPDATE appointments SET starts_at = '2026-11-10T10:15:00Z', ends_at = '2026-11-10T10:45:00Z', blocked_until = '2026-11-10T10:45:00Z' WHERE id = $1`, [uid(2)])),
      );
      expect(onto).toMatchObject({ code: "23P01", constraint: "appointments_staff_no_overlap" });
      const within = await failure(() =>
        run((c) => c.query(`UPDATE appointments SET starts_at = '2026-11-10T10:15:00Z', ends_at = '2026-11-10T10:45:00Z', blocked_until = '2026-11-10T10:45:00Z' WHERE id = $1`, [uid(1)])),
      );
      expect(within).toBeUndefined();
    });
  });

  describe("one person cannot be in two places (appointments_client_no_overlap)", () => {
    it("refuses overlapping appointments of one client with different staff members", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      const f = await failure(() => run((c) => insertAppointment(c, { id: uid(2), staff: W.staffA2, start: "2026-11-10T10:15:00Z", end: "2026-11-10T10:45:00Z" })));
      expect(f).toMatchObject({ code: "23P01", constraint: "appointments_client_no_overlap" });
    });
  });

  describe("shape of the data", () => {
    it("refuses a row whose blocked_until is not end plus buffer, or that ends before it starts", async () => {
      const wrongBuffer = await failure(() =>
        run((c) =>
          c.query(
            `INSERT INTO appointments (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'booked', '2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', 10, '2026-11-10T10:30:00Z', now(), now())`,
            [uid(1), W.salonA, W.staffA1, W.clientA1, W.cut],
          ),
        ),
      );
      expect(wrongBuffer?.code).toBe("23514");
      const backwards = await failure(() => run((c) => insertAppointment(c, { id: uid(2), start: "2026-11-10T10:30:00Z", end: "2026-11-10T10:00:00Z" })));
      expect(backwards?.code).toBe("23514");
    });

    it("refuses to link rows of two salons", async () => {
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(1), salon: W.salonA, staff: W.staffB1, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toMatchObject({ code: "23503" });
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(2), salon: W.salonA, client: W.clientB1, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toMatchObject({ code: "23503" });
      expect(await failure(() => run((c) => insertAppointment(c, { id: uid(3), salon: W.salonA, service: W.cutB, start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" })))).toMatchObject({ code: "23503" });
    });

    it("keeps one client per phone hash and salon", async () => {
      const f = await failure(() =>
        run((c) => c.query(`INSERT INTO client_pii (client_id, salon_id, phone_hash, phone_enc) VALUES ($1, $2, $3, 'v1:x')`, [W.clientA2, W.salonA, "0".repeat(63) + "1"])),
      );
      expect(f?.code).toBe("23505");
    });

    it("refuses overlapping working hours of one staff member", async () => {
      const f = await failure(() => run((c) => c.query(`INSERT INTO working_hours (salon_id, staff_id, weekday, start_minute, end_minute) VALUES ($1, $2, 1, 600, 700)`, [W.salonA, W.staffA1])));
      expect(f).toMatchObject({ code: "23P01", constraint: "working_hours_no_overlap" });
      const ok = await failure(() => run((c) => c.query(`INSERT INTO working_hours (salon_id, staff_id, weekday, start_minute, end_minute) VALUES ($1, $2, 6, 600, 700)`, [W.salonA, W.staffA1])));
      expect(ok).toBeUndefined();
    });
  });

  describe("the status machine", () => {
    const update = (id: string, set: string) => run((c) => c.query(`UPDATE appointments SET ${set} WHERE id = $1`, [id]));

    it("allows held to booked, booked to cancelled, and refuses the way back", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), status: "held", start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      expect(await failure(() => update(uid(1), "status = 'booked'"))).toBeUndefined();
      expect(await failure(() => update(uid(1), "status = 'held', hold_expires_at = now()"))).toMatchObject({ code: "23514" });
      expect(await failure(() => update(uid(1), "status = 'cancelled', cancelled_at = now()"))).toBeUndefined();
      expect(await failure(() => update(uid(1), "status = 'booked', cancelled_at = NULL"))).toMatchObject({ code: "23514" });
    });

    it("refuses to skip from held to completed and to change who an appointment belongs to", async () => {
      await run((c) => insertAppointment(c, { id: uid(1), status: "held", start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }));
      expect(await failure(() => update(uid(1), "status = 'completed'"))).toMatchObject({ code: "23514" });
      expect(await failure(() => update(uid(1), `client_id = '${W.clientA2}'`))).toMatchObject({ code: "23514" });
    });
  });

  describe("migrations", () => {
    it("run once, are recorded with a checksum and refuse an edited file", async () => {
      const again = await migrate(db.adminUrl, MIGRATIONS);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied.length).toBeGreaterThanOrEqual(6);

      const dir = await mkdtemp(join(tmpdir(), "mig-"));
      try {
        await cp(MIGRATIONS, dir, { recursive: true });
        const first = join(dir, "0001_extensions_and_roles.sql");
        await writeFile(first, `${await readFile(first, "utf8")}\n-- edited\n`);
        await expect(migrate(db.adminUrl, dir)).rejects.toThrow(/was changed after it was applied/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("roll a failing file back completely", async () => {
      const dir = await mkdtemp(join(tmpdir(), "mig-"));
      try {
        await cp(MIGRATIONS, dir, { recursive: true });
        await writeFile(join(dir, "0099_broken.sql"), "CREATE TABLE half_done (id int);\nSELECT 1/0;\n");
        await expect(migrate(db.adminUrl, dir)).rejects.toThrow();
        const left = await asAdmin(db, (c) => c.query("SELECT to_regclass('half_done') AS t"));
        expect(left.rows[0]?.t).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
