import type { ClientActor, StaffActor } from "../domain/actor.js";
import { systemOf } from "../domain/actor.js";
import { checkSlot } from "../domain/availability.js";
import { isBlocking, MAX_NOTES_LENGTH, type Appointment } from "../domain/appointment.js";
import { isBookingError } from "../domain/errors.js";
import { asId, type AppointmentId, type ServiceId, type StaffId } from "../domain/ids.js";
import { err } from "../domain/result.js";
import { checkCancel, checkMove } from "../domain/rules.js";
import { DAY, MINUTE, type Instant } from "../domain/time/instant.js";
import { sanitizeUntrusted } from "../domain/untrusted-text.js";
import { idempotent } from "./idempotency.js";
import { refuse, succeed, type Outcome } from "./outcome.js";
import type { Deps } from "./ports.js";
import { loadSlotContext, slotQuery } from "./slots.js";

export interface BookRequest {
  readonly serviceId: ServiceId;
  readonly staffId: StaffId;
  readonly startsAt: Instant;
  readonly notes?: string | undefined;
  /** a retry with the same key returns the first answer instead of booking twice */
  readonly idempotencyKey?: string | undefined;
}

function cleanNotes(notes: string | undefined): string | null {
  if (notes === undefined) return null;
  const text = sanitizeUntrusted(notes, MAX_NOTES_LENGTH).text;
  return text === "" ? null : text;
}

/**
 * Places an appointment for the client. `held` reserves the slot until the client confirms (see `confirmHold`);
 * `booked` books it at once. The slot rules are checked against a fresh read of the calendar, and then the database
 * has the last word: a second appointment for the same time is refused by an exclusion constraint, however many
 * requests race, and comes back as `slot_unavailable`.
 */
async function place(deps: Deps, actor: ClientActor, request: BookRequest, status: "held" | "booked"): Promise<Outcome<Appointment>> {
  if (!Number.isSafeInteger(request.startsAt)) return refuse("invalid_input");
  const now = deps.clock.now();
  const ctx = await deps.db.transaction(systemOf(actor), async (tx) => {
    // an unconfirmed hold that ran out still occupies the time in the database until it is released
    await tx.appointments.releaseExpiredHolds(now);
    return loadSlotContext(tx, now, request.serviceId, [request.staffId], { start: request.startsAt - DAY, end: request.startsAt + 2 * DAY });
  });
  if (!ctx) return refuse("not_found");

  return deps.db.transaction(actor, (tx) =>
    idempotent(tx, deps.hasher, now, request.idempotencyKey, { op: status, serviceId: request.serviceId, staffId: request.staffId, startsAt: request.startsAt, notes: request.notes ?? null }, async () => {
      const own = await tx.appointments.upcoming(now, 50);
      const reason = checkSlot(
        slotQuery(ctx, request.staffId, own.map((a) => ({ start: a.startsAt, end: a.endsAt })), now, "client"),
        request.startsAt,
      );
      if (reason) return refuse(reason);
      try {
        return succeed(
          await tx.appointments.insert({
            id: asId<"AppointmentId">(deps.ids.next()),
            staffId: request.staffId,
            clientId: actor.clientId,
            serviceId: request.serviceId,
            status,
            startsAt: request.startsAt,
            endsAt: request.startsAt + ctx.service.durationMinutes * MINUTE,
            bufferMinutes: ctx.service.bufferMinutes,
            holdExpiresAt: status === "held" ? now + ctx.salon.policy.holdMinutes * MINUTE : null,
            notes: cleanNotes(request.notes),
            now,
          }),
        );
      } catch (error) {
        if (isBookingError(error)) return err(error);
        throw error;
      }
    }),
  );
}

export function book(deps: Deps, actor: ClientActor, request: BookRequest): Promise<Outcome<Appointment>> {
  return place(deps, actor, request, "booked");
}

export function holdSlot(deps: Deps, actor: ClientActor, request: BookRequest): Promise<Outcome<Appointment>> {
  return place(deps, actor, request, "held");
}

/** Turns a hold into a booking. Confirming twice is harmless; confirming after the hold ran out is refused. */
export async function confirmHold(deps: Deps, actor: ClientActor, appointmentId: AppointmentId): Promise<Outcome<Appointment>> {
  const now = deps.clock.now();
  return deps.db.transaction(actor, async (tx) => {
    const appointment = await tx.appointments.lock(appointmentId);
    if (!appointment) return refuse("not_found");
    if (appointment.status === "booked") return succeed(appointment);
    if (appointment.status !== "held") return refuse("not_active");
    if (appointment.holdExpiresAt === null || appointment.holdExpiresAt <= now) return refuse("hold_expired");
    return succeed(await tx.appointments.setStatus(appointmentId, "booked", now));
  });
}

/** Gives a hold back, whatever the cancellation window says: nothing was promised yet. */
export async function releaseHold(deps: Deps, actor: ClientActor, appointmentId: AppointmentId): Promise<Outcome<void>> {
  const now = deps.clock.now();
  return deps.db.transaction(actor, async (tx) => {
    const appointment = await tx.appointments.lock(appointmentId);
    if (!appointment) return refuse("not_found");
    if (appointment.status !== "held") return succeed(undefined);
    await tx.appointments.setStatus(appointmentId, "cancelled", now);
    return succeed(undefined);
  });
}

export interface MoveRequest {
  readonly appointmentId: AppointmentId;
  readonly startsAt: Instant;
  /** another staff member who offers the service; the same one when omitted */
  readonly staffId?: StaffId | undefined;
  /** refuse unless the appointment is still at this version (the client confirmed what they were shown) */
  readonly expectedVersion?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}

export async function moveAppointment(deps: Deps, actor: ClientActor, request: MoveRequest): Promise<Outcome<Appointment>> {
  if (!Number.isSafeInteger(request.startsAt)) return refuse("invalid_input");
  const now = deps.clock.now();
  const seen = await deps.db.transaction(actor, (tx) => tx.appointments.find(request.appointmentId));
  if (!seen) return refuse("not_found");
  const staffId = request.staffId ?? seen.staffId;
  const ctx = await deps.db.transaction(systemOf(actor), async (tx) => {
    await tx.appointments.releaseExpiredHolds(now);
    return loadSlotContext(tx, now, seen.serviceId, [staffId], { start: request.startsAt - DAY, end: request.startsAt + 2 * DAY }, seen.id);
  });
  if (!ctx) return refuse("not_found");

  return deps.db.transaction(actor, (tx) =>
    idempotent(tx, deps.hasher, now, request.idempotencyKey, { op: "move", id: request.appointmentId, startsAt: request.startsAt, staffId, v: request.expectedVersion ?? null }, async () => {
      // the row is locked: a concurrent cancel or move waits here and this transaction sees its result
      const current = await tx.appointments.lock(request.appointmentId);
      if (!current) return refuse("not_found");
      if (current.status !== "booked") return refuse("not_active");
      if (current.version !== (request.expectedVersion ?? seen.version)) return refuse("stale");
      const rule = checkMove(ctx.salon.policy, now, current, request.startsAt, "client");
      if (rule) return refuse(rule);
      const own = (await tx.appointments.upcoming(now, 50)).filter((a) => a.id !== current.id);
      const duration = { durationMinutes: (current.endsAt - current.startsAt) / MINUTE, bufferMinutes: current.bufferMinutes };
      const reason = checkSlot(slotQuery(ctx, staffId, own.map((a) => ({ start: a.startsAt, end: a.endsAt })), now, "client", duration), request.startsAt);
      if (reason) return refuse(reason);
      try {
        return succeed(
          await tx.appointments.reschedule(current.id, {
            staffId,
            startsAt: request.startsAt,
            endsAt: request.startsAt + duration.durationMinutes * MINUTE,
            bufferMinutes: current.bufferMinutes,
            now,
          }),
        );
      } catch (error) {
        if (isBookingError(error)) return err(error);
        throw error;
      }
    }),
  );
}

export interface CancelRequest {
  readonly appointmentId: AppointmentId;
  readonly expectedVersion?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}

/** A client cancels their own appointment outside the cancellation window; staff may cancel any appointment of the salon at any time before it starts. */
export async function cancelAppointment(deps: Deps, actor: ClientActor | StaffActor, request: CancelRequest): Promise<Outcome<Appointment>> {
  const now = deps.clock.now();
  return deps.db.transaction(actor, (tx) =>
    idempotent(tx, deps.hasher, now, request.idempotencyKey, { op: "cancel", id: request.appointmentId, v: request.expectedVersion ?? null }, async () => {
      const appointment = await tx.appointments.lock(request.appointmentId);
      if (!appointment) return refuse("not_found");
      if (!isBlocking(appointment.status)) return refuse("not_active");
      if (request.expectedVersion !== undefined && appointment.version !== request.expectedVersion) return refuse("stale");
      const salon = await tx.catalog.getSalon();
      if (!salon) return refuse("not_found");
      const rule = checkCancel(salon.policy, now, appointment, actor.kind === "client" ? "client" : "staff");
      if (rule) return refuse(rule);
      return succeed(await tx.appointments.setStatus(appointment.id, "cancelled", now));
    }),
  );
}

export interface AppointmentView {
  readonly id: AppointmentId;
  readonly status: Appointment["status"];
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly serviceName: string;
  readonly staffName: string;
  readonly version: number;
  /** written by the client: untrusted text */
  readonly notes: string | null;
}

/** The client's upcoming appointments, nearest first. */
export async function listMyAppointments(deps: Deps, actor: ClientActor, limit = 10): Promise<AppointmentView[]> {
  const now = deps.clock.now();
  return deps.db.transaction(actor, async (tx) => {
    const upcoming = await tx.appointments.upcoming(now, Math.min(Math.max(limit, 1), 20));
    const views: AppointmentView[] = [];
    for (const a of upcoming) {
      views.push({
        id: a.id,
        status: a.status,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        serviceName: (await tx.catalog.getService(a.serviceId))?.name ?? "",
        staffName: (await tx.catalog.getStaff(a.staffId))?.name ?? "",
        version: a.version,
        notes: a.notes,
      });
    }
    return views;
  });
}
