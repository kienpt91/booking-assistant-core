/**
 * Every refusal the booking rules can give. The code is the contract; the message is a fixed sentence for the code and
 * never carries a name, a phone number or free text, so an error is safe to log, store and show in a trace.
 */
export const BOOKING_ERROR_MESSAGES = {
  invalid_input: "The request is not valid.",
  not_found: "The appointment, service or staff member does not exist.",
  forbidden: "This action is not allowed.",
  slot_unavailable: "That time is no longer available.",
  client_overlap: "The client already has an appointment at that time.",
  not_on_grid: "That time is not one of the bookable start times.",
  outside_working_hours: "That time is outside the working hours.",
  time_off: "The staff member is not available at that time.",
  in_the_past: "That time is in the past.",
  lead_time: "That time is too soon to book.",
  too_far_ahead: "That time is too far ahead to book.",
  cancellation_window: "It is too late to change this appointment online.",
  not_active: "The appointment is not active.",
  stale: "The appointment changed in the meantime.",
  hold_expired: "The hold on that time has expired.",
  quota_exceeded: "Too many changes today.",
  idempotency_mismatch: "The idempotency key was used for a different request.",
} as const;

export type BookingErrorCode = keyof typeof BOOKING_ERROR_MESSAGES;

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode) {
    super(BOOKING_ERROR_MESSAGES[code]);
    this.name = "BookingError";
    this.code = code;
  }
}

export function isBookingError(value: unknown): value is BookingError {
  return value instanceof BookingError;
}
