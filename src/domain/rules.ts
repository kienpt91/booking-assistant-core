import type { BookingErrorCode } from "./errors.js";
import { isBlocking, type AppointmentStatus } from "./appointment.js";
import type { BookingPolicy } from "./catalog.js";
import { DAY, MINUTE, type Instant } from "./time/instant.js";

/**
 * Who is asking for the change. Staff may book close to the start or cancel inside the window (the owner knows
 * the customer is on the phone); nobody may touch the past.
 */
export type Initiator = "client" | "staff";

export function checkNewStart(policy: BookingPolicy, now: Instant, startsAt: Instant, initiator: Initiator): BookingErrorCode | undefined {
  if (startsAt <= now) return "in_the_past";
  if (initiator === "client") {
    if (startsAt - now < policy.minLeadMinutes * MINUTE) return "lead_time";
    if (startsAt - now > policy.maxAdvanceDays * DAY) return "too_far_ahead";
  }
  return undefined;
}

export interface CancellableView {
  readonly status: AppointmentStatus;
  readonly startsAt: Instant;
}

export function checkCancel(policy: BookingPolicy, now: Instant, appointment: CancellableView, initiator: Initiator): BookingErrorCode | undefined {
  if (!isBlocking(appointment.status)) return "not_active";
  if (appointment.startsAt <= now) return "in_the_past";
  if (initiator === "client" && appointment.startsAt - now < policy.cancelWindowMinutes * MINUTE) return "cancellation_window";
  return undefined;
}

/** Moving is cancelling the old time and booking the new one: both sets of rules apply, and only a confirmed appointment moves. */
export function checkMove(policy: BookingPolicy, now: Instant, appointment: CancellableView, newStartsAt: Instant, initiator: Initiator): BookingErrorCode | undefined {
  if (appointment.status !== "booked") return "not_active";
  return checkCancel(policy, now, appointment, initiator) ?? checkNewStart(policy, now, newStartsAt, initiator);
}
