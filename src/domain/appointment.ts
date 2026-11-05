import type { AppointmentId, ClientId, SalonId, ServiceId, StaffId } from "./ids.js";
import { MINUTE, type Instant } from "./time/instant.js";

/**
 * held:      reserved for a client who has not confirmed yet; blocks the slot until `holdExpiresAt`
 * booked:    confirmed
 * cancelled: released by the client or the salon
 * expired:   a hold nobody confirmed
 * completed: the visit happened (kept for history)
 */
export type AppointmentStatus = "held" | "booked" | "cancelled" | "expired" | "completed";

/** The statuses that occupy the staff member's time. The database exclusion constraint is built on this list. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = ["held", "booked"];

export function isBlocking(status: AppointmentStatus): boolean {
  return status === "held" || status === "booked";
}

export interface Appointment {
  readonly id: AppointmentId;
  readonly salonId: SalonId;
  readonly staffId: StaffId;
  readonly clientId: ClientId;
  readonly serviceId: ServiceId;
  readonly status: AppointmentStatus;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly bufferMinutes: number;
  /** end of the time the appointment occupies for the staff member: `endsAt` plus the buffer */
  readonly blockedUntil: Instant;
  readonly holdExpiresAt: Instant | null;
  /** free text written by the client: untrusted, capped, removed when the client is erased */
  readonly notes: string | null;
  /** increases on every change; a confirmation that was prepared against an older version is refused */
  readonly version: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly cancelledAt: Instant | null;
}

export function blockedUntil(endsAt: Instant, bufferMinutes: number): Instant {
  return endsAt + bufferMinutes * MINUTE;
}

export const MAX_NOTES_LENGTH = 300;
