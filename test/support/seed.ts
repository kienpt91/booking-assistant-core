import type pg from "pg";
import { W, seedWorld } from "../../src/infrastructure/postgres/sample-data.js";

export { W, seedWorld };


export interface NewRow {
  readonly id: string;
  readonly salon?: string;
  readonly staff?: string;
  readonly client?: string;
  readonly service?: string;
  readonly status?: "held" | "booked" | "cancelled" | "expired" | "completed";
  readonly start: string;
  readonly end: string;
  readonly buffer?: number;
}

/** Inserts an appointment row as the superuser; blocked_until is derived the way the application derives it. */
export async function insertAppointment(c: pg.Client, row: NewRow): Promise<void> {
  const status = row.status ?? "booked";
  const buffer = row.buffer ?? 0;
  const end = new Date(row.end);
  const blocked = new Date(end.getTime() + buffer * 60_000);
  await c.query(
    `INSERT INTO appointments (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, hold_expires_at, created_at, updated_at, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), $12)`,
    [
      row.id,
      row.salon ?? W.salonA,
      row.staff ?? W.staffA1,
      row.client ?? W.clientA1,
      row.service ?? W.cut,
      status,
      row.start,
      row.end,
      buffer,
      blocked,
      status === "held" ? new Date("2100-01-01T00:00:00Z") : null,
      status === "cancelled" ? new Date("2026-11-02T00:00:00Z") : null,
    ],
  );
}

/** A deterministic uuid for test rows. */
export function uid(n: number): string {
  return `d0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
