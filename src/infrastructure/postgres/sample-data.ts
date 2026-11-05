import type pg from "pg";

/**
 * Sample data for the tests and the demo: two made-up salons and three made-up clients, with fixed identifiers. It is
 * never loaded into a real database by the application. Replace it with your own salon (docs/adapting.md).
 */
export const W = {
  salonA: "a0000000-0000-4000-8000-000000000001",
  salonB: "b0000000-0000-4000-8000-000000000001",
  staffA1: "5a000000-0000-4000-8000-000000000001",
  staffA2: "5a000000-0000-4000-8000-000000000002",
  staffB1: "5b000000-0000-4000-8000-000000000001",
  cut: "c0000000-0000-4000-8000-0000000000a1",
  color: "c0000000-0000-4000-8000-0000000000a2",
  cutB: "c0000000-0000-4000-8000-0000000000b1",
  clientA1: "c1000000-0000-4000-8000-000000000001",
  clientA2: "c1000000-0000-4000-8000-000000000002",
  clientB1: "c1000000-0000-4000-8000-0000000000b1",
} as const;

const HASH = (n: number): string => n.toString(16).padStart(64, "0");

/**
 * Seeds two salons with staff, services and weekday working hours (09:00 to 17:00 Monday to Friday), and three clients
 * with made-up personal data. Salon A is in London, salon B in Riyadh. Run as the superuser.
 */
export async function seedWorld(c: pg.Client): Promise<void> {
  await c.query(
    `INSERT INTO salons (id, name, time_zone, default_language) VALUES ($1, 'Salon A', 'Europe/London', 'en'), ($2, 'Salon B', 'Asia/Riyadh', 'ar')`,
    [W.salonA, W.salonB],
  );
  await c.query(`INSERT INTO staff (id, salon_id, name) VALUES ($1, $4, 'Staff A1'), ($2, $4, 'Staff A2'), ($3, $5, 'Staff B1')`, [W.staffA1, W.staffA2, W.staffB1, W.salonA, W.salonB]);
  await c.query(
    `INSERT INTO services (id, salon_id, name, duration_minutes, buffer_minutes) VALUES ($1, $4, 'Haircut', 30, 10), ($2, $4, 'Colour', 90, 15), ($3, $5, 'Haircut', 30, 0)`,
    [W.cut, W.color, W.cutB, W.salonA, W.salonB],
  );
  await c.query(
    `INSERT INTO staff_services (salon_id, staff_id, service_id) VALUES ($4, $1, $5), ($4, $1, $6), ($4, $2, $5), ($7, $3, $8)`,
    [W.staffA1, W.staffA2, W.staffB1, W.salonA, W.cut, W.color, W.salonB, W.cutB],
  );
  for (const [salon, staff] of [
    [W.salonA, W.staffA1],
    [W.salonA, W.staffA2],
    [W.salonB, W.staffB1],
  ] as const) {
    for (const weekday of [1, 2, 3, 4, 5]) {
      await c.query(`INSERT INTO working_hours (salon_id, staff_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, 540, 1020)`, [salon, staff, weekday]);
    }
  }
  await c.query(`INSERT INTO salon_channels (channel, address, salon_id) VALUES ('chat', 'salon-a', $1), ('chat', 'salon-b', $2)`, [W.salonA, W.salonB]);
  const now = new Date("2026-11-01T00:00:00Z");
  for (const [n, id, salon] of [
    [1, W.clientA1, W.salonA],
    [2, W.clientA2, W.salonA],
    [3, W.clientB1, W.salonB],
  ] as const) {
    await c.query(`INSERT INTO clients (id, salon_id, created_at) VALUES ($1, $2, $3)`, [id, salon, now]);
    await c.query(`INSERT INTO client_pii (client_id, salon_id, phone_hash, phone_enc, name_enc) VALUES ($1, $2, $3, $4, $5)`, [id, salon, HASH(n), `v1:phone-${n}`, `v1:name-${n}`]);
  }
}
