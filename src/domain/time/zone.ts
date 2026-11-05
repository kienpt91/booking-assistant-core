import { addDays, type CivilDate } from "./civil.js";
import { DAY, MINUTE, type Instant } from "./instant.js";

/**
 * Time zone arithmetic on top of Intl, which carries the IANA rules (no dependency, no stored offsets).
 *
 * Working hours are wall-clock ("09:00 to 17:00 in Europe/London"); appointments are instants. The two meet in
 * `wallStartInstant` and `wallEndInstant`, which say what happens on the two bad days of a year:
 *   - a wall time that does not exist (spring forward, 02:30 when the clock jumps from 02:00 to 03:00) is the instant of
 *     the jump itself, whether it starts or ends a window, so a window never covers time that did not happen;
 *   - a wall time that happens twice (fall back, 01:30 twice) starts a window at its first occurrence and ends it at
 *     its last, so the window covers the whole repeated hour.
 * Inside a window time is counted in elapsed minutes, so a 09:00 to 17:00 window is still eight real hours.
 */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** An IANA zone name that this runtime knows. Fixed offsets ("+02:00") are refused: they have no daylight saving rules. */
export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length > 64 || !ZONE_NAME.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

export interface LocalDateTime extends WallTime {
  readonly second: number;
}

/** The wall clock of a zone at an instant. */
export function localDateTime(zone: string, at: Instant): LocalDateTime {
  const out: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(at)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out["year"] as number,
    month: out["month"] as number,
    day: out["day"] as number,
    hour: out["hour"] as number,
    minute: out["minute"] as number,
    second: out["second"] as number,
  };
}

export function localDate(zone: string, at: Instant): CivilDate {
  const l = localDateTime(zone, at);
  return { year: l.year, month: l.month, day: l.day };
}

/** Minutes east of UTC at an instant (-300 for New York in winter). */
export function offsetMinutes(zone: string, at: Instant): number {
  const l = localDateTime(zone, at);
  const wallAsUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  const whole = Math.floor(at / 1000) * 1000;
  return Math.round((wallAsUtc - whole) / MINUTE);
}

function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** Every instant at which the wall clock of the zone reads `wall`: none (a gap), one, or two (a repeated hour). */
export function instantsAtWall(zone: string, wall: WallTime): Instant[] {
  const w = wallAsUtc(wall);
  const found = new Set<Instant>();
  for (const offset of new Set([offsetMinutes(zone, w - DAY), offsetMinutes(zone, w), offsetMinutes(zone, w + DAY)])) {
    const candidate = w - offset * MINUTE;
    const back = localDateTime(zone, candidate);
    if (back.year === wall.year && back.month === wall.month && back.day === wall.day && back.hour === wall.hour && back.minute === wall.minute) {
      found.add(candidate);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** The instant at which the offset of the zone changes, for a wall time that falls into the gap of that change. */
function gapInstant(zone: string, wall: WallTime): Instant {
  const w = wallAsUtc(wall);
  let lo = w - DAY;
  let hi = w + DAY;
  const before = offsetMinutes(zone, lo);
  if (before === offsetMinutes(zone, hi)) return w - before * MINUTE;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
    if (offsetMinutes(zone, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Where a window that starts at this wall time starts: the first occurrence, or the end of the gap. */
export function wallStartInstant(zone: string, wall: WallTime): Instant {
  const all = instantsAtWall(zone, wall);
  return all.length > 0 ? (all[0] as Instant) : gapInstant(zone, wall);
}

/** Where a window that ends at this wall time ends: the last occurrence, or the start of the gap. */
export function wallEndInstant(zone: string, wall: WallTime): Instant {
  const all = instantsAtWall(zone, wall);
  return all.length > 0 ? (all[all.length - 1] as Instant) : gapInstant(zone, wall);
}

export function wallOnDate(date: CivilDate, minuteOfDay: number): WallTime {
  const day = minuteOfDay >= 1440 ? addDays(date, Math.floor(minuteOfDay / 1440)) : date;
  const minutes = minuteOfDay % 1440;
  return { ...day, hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

/** An instant as ISO 8601 text in the zone, with its offset: "2026-11-10T10:00:00+00:00". The form the assistant tools exchange. */
export function formatIsoWithOffset(zone: string, at: Instant): string {
  const l = localDateTime(zone, at);
  const offset = offsetMinutes(zone, at);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(l.year).padStart(4, "0")}-${two(l.month)}-${two(l.day)}T${two(l.hour)}:${two(l.minute)}:${two(l.second)}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}
