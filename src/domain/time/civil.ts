/** A calendar date without a zone or a time of day. Arithmetic never leaves the Gregorian calendar. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysFromCivil(d: CivilDate): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
}

function civilFromDays(days: number): CivilDate {
  const at = new Date(days * 86_400_000);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** Strict YYYY-MM-DD that names a real day (2026-02-30 is refused). */
export function parseCivilDate(text: unknown): CivilDate | undefined {
  if (typeof text !== "string") return undefined;
  const m = DATE.exec(text);
  if (!m) return undefined;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (date.year < 1970 || date.year > 2200) return undefined;
  const back = civilFromDays(daysFromCivil(date));
  return back.year === date.year && back.month === date.month && back.day === date.day ? date : undefined;
}

export function formatCivilDate(d: CivilDate): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function addDays(d: CivilDate, days: number): CivilDate {
  return civilFromDays(daysFromCivil(d) + days);
}

export function daysBetween(from: CivilDate, to: CivilDate): number {
  return daysFromCivil(to) - daysFromCivil(from);
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return daysFromCivil(a) - daysFromCivil(b);
}

/** ISO weekday: Monday is 1, Sunday is 7. */
export function isoWeekday(d: CivilDate): number {
  const sunday0 = new Date(daysFromCivil(d) * 86_400_000).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}
