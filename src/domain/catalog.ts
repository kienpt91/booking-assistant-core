import type { SalonId, ServiceId, StaffId } from "./ids.js";
import type { Language } from "./untrusted-text.js";

/** The salon's booking rules. Minutes are real elapsed minutes; the horizon is counted in 24 hour days. */
export interface BookingPolicy {
  /** a client cannot book a start earlier than this many minutes from now */
  readonly minLeadMinutes: number;
  /** a client cannot cancel or move an appointment that starts sooner than this; they have to call */
  readonly cancelWindowMinutes: number;
  readonly maxAdvanceDays: number;
  /** start times are the opening time of a working window plus a multiple of this */
  readonly slotGranularityMinutes: number;
  /** how long a held slot waits for the client's confirmation */
  readonly holdMinutes: number;
}

export const DEFAULT_POLICY: BookingPolicy = {
  minLeadMinutes: 120,
  cancelWindowMinutes: 24 * 60,
  maxAdvanceDays: 60,
  slotGranularityMinutes: 15,
  holdMinutes: 5,
};

export interface Salon {
  readonly id: SalonId;
  readonly name: string;
  /** IANA zone; every working hour and every date shown to a client is in this zone */
  readonly timeZone: string;
  readonly defaultLanguage: Language;
  readonly policy: BookingPolicy;
}

export interface Service {
  readonly id: ServiceId;
  readonly salonId: SalonId;
  readonly name: string;
  readonly durationMinutes: number;
  /** cleaning or setup time kept free after the appointment, for the same staff member */
  readonly bufferMinutes: number;
  readonly active: boolean;
}

export interface StaffMember {
  readonly id: StaffId;
  readonly salonId: SalonId;
  readonly name: string;
  readonly active: boolean;
}

/** One opening interval of one staff member: weekday 1 (Monday) to 7 (Sunday), minutes after local midnight. */
export interface WorkingWindow {
  readonly weekday: number;
  readonly startMinute: number;
  /** up to 1440 (midnight at the end of the day); a window never crosses midnight */
  readonly endMinute: number;
}

export function isValidPolicy(p: BookingPolicy): boolean {
  const whole = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;
  return (
    whole(p.minLeadMinutes, 0, 14 * 24 * 60) &&
    whole(p.cancelWindowMinutes, 0, 14 * 24 * 60) &&
    whole(p.maxAdvanceDays, 1, 730) &&
    whole(p.slotGranularityMinutes, 5, 240) &&
    whole(p.holdMinutes, 1, 60)
  );
}

export function isValidWindow(w: WorkingWindow): boolean {
  return Number.isInteger(w.weekday) && w.weekday >= 1 && w.weekday <= 7 && Number.isInteger(w.startMinute) && Number.isInteger(w.endMinute) && w.startMinute >= 0 && w.endMinute <= 1440 && w.startMinute < w.endMinute;
}
