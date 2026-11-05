import type { Actor } from "../domain/actor.js";
import { listSlots } from "../domain/availability.js";
import type { ServiceId, StaffId } from "../domain/ids.js";
import { systemOf } from "../domain/actor.js";
import { addDays, compareCivil, daysBetween, type CivilDate } from "../domain/time/civil.js";
import { wallOnDate, wallStartInstant } from "../domain/time/zone.js";
import type { Instant } from "../domain/time/instant.js";
import { refuse, succeed, type Outcome } from "./outcome.js";
import type { Deps } from "./ports.js";
import { loadSlotContext, slotQuery } from "./slots.js";

export const MAX_RANGE_DAYS = 14;
export const MAX_SLOTS = 30;

export interface AvailabilityRequest {
  readonly serviceId: ServiceId;
  /** first and last local date (in the salon's zone), inclusive */
  readonly from: CivilDate;
  readonly to: CivilDate;
  readonly staffId?: StaffId;
  readonly limit?: number;
}

export interface OfferedSlot {
  readonly staffId: StaffId;
  readonly staffName: string;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
}

export interface Availability {
  readonly timeZone: string;
  readonly service: { readonly id: ServiceId; readonly name: string; readonly durationMinutes: number };
  readonly slots: readonly OfferedSlot[];
}

/**
 * Free start times for a service. The salon's calendar is read as the system actor, which sees when a staff member is
 * busy but not who with; a client's own appointments are read as the client, so that nobody is offered a time when they
 * already have somewhere to be.
 */
export async function findAvailability(deps: Deps, actor: Actor, request: AvailabilityRequest): Promise<Outcome<Availability>> {
  if (compareCivil(request.from, request.to) > 0 || daysBetween(request.from, request.to) >= MAX_RANGE_DAYS) return refuse("invalid_input");
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? 10), 1), MAX_SLOTS);
  const now = deps.clock.now();

  const loaded = await deps.db.transaction(systemOf(actor), async (tx) => {
    const salon = await tx.catalog.getSalon();
    if (!salon) return undefined;
    const range = {
      start: wallStartInstant(salon.timeZone, wallOnDate(request.from, 0)),
      end: wallStartInstant(salon.timeZone, wallOnDate(addDays(request.to, 1), 0)),
    };
    return { range, ctx: await loadSlotContext(tx, now, request.serviceId, request.staffId ? [request.staffId] : undefined, range) };
  });
  if (!loaded?.ctx) return refuse("not_found");
  const { ctx } = loaded;

  const clientBusy =
    actor.kind === "client" ? (await deps.db.transaction(actor, (tx) => tx.appointments.upcoming(now, 50))).map((a) => ({ start: a.startsAt, end: a.endsAt })) : [];
  const initiator = actor.kind === "client" ? "client" : "staff";

  const slots: OfferedSlot[] = [];
  for (const member of ctx.staff) {
    for (const slot of listSlots(slotQuery(ctx, member.id, clientBusy, now, initiator), request.from, request.to, limit)) {
      slots.push({ staffId: member.id, staffName: member.name, startsAt: slot.startsAt, endsAt: slot.endsAt });
    }
  }
  slots.sort((a, b) => a.startsAt - b.startsAt || a.staffName.localeCompare(b.staffName));
  return succeed({
    timeZone: ctx.salon.timeZone,
    service: { id: ctx.service.id, name: ctx.service.name, durationMinutes: ctx.service.durationMinutes },
    slots: slots.slice(0, limit),
  });
}
