import type { BookingErrorCode } from "./errors.js";
import type { BookingPolicy, WorkingWindow } from "./catalog.js";
import { checkNewStart, type Initiator } from "./rules.js";
import { addDays, compareCivil, type CivilDate } from "./time/civil.js";
import { MINUTE, overlaps, type Instant, type Interval } from "./time/instant.js";
import { localDate, wallEndInstant, wallOnDate, wallStartInstant } from "./time/zone.js";
import { isoWeekday } from "./time/civil.js";

export interface SlotQuery {
  readonly zone: string;
  /** the staff member's opening intervals */
  readonly windows: readonly WorkingWindow[];
  /** time the staff member's other appointments occupy, buffers included */
  readonly busy: readonly Interval[];
  readonly timeOff: readonly Interval[];
  /** the client's own appointments (without buffers): one person cannot be in two places */
  readonly clientBusy: readonly Interval[];
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly policy: BookingPolicy;
  readonly now: Instant;
  readonly initiator: Initiator;
}

export interface Slot {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
}

/** The opening intervals of a local date as instants; a window on a day with a clock change keeps its real length. */
function openingsOn(q: SlotQuery, date: CivilDate): Interval[] {
  const weekday = isoWeekday(date);
  return q.windows
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ start: wallStartInstant(q.zone, wallOnDate(date, w.startMinute)), end: wallEndInstant(q.zone, wallOnDate(date, w.endMinute)) }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start);
}

function evaluate(q: SlotQuery, opening: Interval, startsAt: Instant): BookingErrorCode | undefined {
  const policy = checkNewStart(q.policy, q.now, startsAt, q.initiator);
  if (policy) return policy;
  const endsAt = startsAt + q.durationMinutes * MINUTE;
  if (startsAt < opening.start || endsAt > opening.end) return "outside_working_hours";
  if ((startsAt - opening.start) % (q.policy.slotGranularityMinutes * MINUTE) !== 0) return "not_on_grid";
  const occupied = { start: startsAt, end: endsAt };
  if (q.timeOff.some((t) => overlaps(t, occupied))) return "time_off";
  if (q.clientBusy.some((c) => overlaps(c, occupied))) return "client_overlap";
  const blocked = { start: startsAt, end: endsAt + q.bufferMinutes * MINUTE };
  if (q.busy.some((b) => overlaps(b, blocked))) return "slot_unavailable";
  return undefined;
}

/** Why a start time is not bookable, or undefined when it is. The same rules produce the slot list below. */
export function checkSlot(q: SlotQuery, startsAt: Instant): BookingErrorCode | undefined {
  const date = localDate(q.zone, startsAt);
  const opening = openingsOn(q, date).find((o) => startsAt >= o.start && startsAt < o.end);
  if (!opening) return checkNewStart(q.policy, q.now, startsAt, q.initiator) ?? "outside_working_hours";
  return evaluate(q, opening, startsAt);
}

/** Every bookable start on one local date, in order. */
export function slotsOnDate(q: SlotQuery, date: CivilDate): Slot[] {
  const out: Slot[] = [];
  const step = q.policy.slotGranularityMinutes * MINUTE;
  for (const opening of openingsOn(q, date)) {
    for (let start = opening.start; start + q.durationMinutes * MINUTE <= opening.end; start += step) {
      if (evaluate(q, opening, start) === undefined) out.push({ startsAt: start, endsAt: start + q.durationMinutes * MINUTE });
    }
  }
  return out;
}

/** Bookable starts from `from` to `to` (inclusive local dates), at most `limit`. */
export function listSlots(q: SlotQuery, from: CivilDate, to: CivilDate, limit: number): Slot[] {
  const out: Slot[] = [];
  for (let date = from; compareCivil(date, to) <= 0 && out.length < limit; date = addDays(date, 1)) {
    for (const slot of slotsOnDate(q, date)) {
      if (out.length >= limit) break;
      out.push(slot);
    }
  }
  return out;
}
