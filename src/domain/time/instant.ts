/** An instant is a number of milliseconds since the epoch, always UTC. Wall-clock time only exists inside a zone. */
export type Instant = number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A half-open range [start, end): two appointments that touch are not overlapping. */
export interface Interval {
  readonly start: Instant;
  readonly end: Instant;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function addMinutes(at: Instant, minutes: number): Instant {
  return at + minutes * MINUTE;
}
