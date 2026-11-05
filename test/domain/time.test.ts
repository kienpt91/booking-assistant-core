import { describe, expect, it } from "vitest";
import { addDays, compareCivil, daysBetween, formatCivilDate, isoWeekday, parseCivilDate } from "../../src/domain/time/civil.js";
import { addMinutes, DAY, HOUR, MINUTE, overlaps } from "../../src/domain/time/instant.js";
import {
  formatIsoWithOffset,
  instantsAtWall,
  isValidZone,
  localDate,
  localDateTime,
  offsetMinutes,
  wallEndInstant,
  wallOnDate,
  wallStartInstant,
} from "../../src/domain/time/zone.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

describe("civil dates", () => {
  it("parses strict dates and refuses impossible ones", () => {
    expect(parseCivilDate("2026-11-05")).toEqual({ year: 2026, month: 11, day: 5 });
    expect(parseCivilDate("2026-02-30")).toBeUndefined();
    expect(parseCivilDate("2026-2-3")).toBeUndefined();
    expect(parseCivilDate("2026-11-05T00:00:00Z")).toBeUndefined();
    expect(parseCivilDate("1969-12-31")).toBeUndefined();
    expect(parseCivilDate("2300-01-01")).toBeUndefined();
    expect(parseCivilDate(20261105)).toBeUndefined();
    expect(parseCivilDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseCivilDate("2027-02-29")).toBeUndefined();
  });

  it("does arithmetic across months and years", () => {
    expect(formatCivilDate(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe("2027-01-01");
    expect(formatCivilDate(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe("2026-02-28");
    expect(daysBetween({ year: 2026, month: 1, day: 1 }, { year: 2027, month: 1, day: 1 })).toBe(365);
    expect(compareCivil({ year: 2026, month: 1, day: 2 }, { year: 2026, month: 1, day: 1 })).toBeGreaterThan(0);
  });

  it("numbers weekdays Monday=1 to Sunday=7", () => {
    expect(isoWeekday({ year: 2026, month: 11, day: 2 })).toBe(1);
    expect(isoWeekday({ year: 2026, month: 11, day: 8 })).toBe(7);
    expect(isoWeekday({ year: 2026, month: 11, day: 7 })).toBe(6);
  });
});

describe("intervals", () => {
  it("treats touching ranges as not overlapping", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(overlaps({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
    expect(overlaps({ start: 5, end: 6 }, { start: 0, end: 20 })).toBe(true);
    expect(addMinutes(0, 2)).toBe(2 * MINUTE);
  });
});

describe("zones", () => {
  it("accepts IANA names and refuses everything else", () => {
    expect(isValidZone("Europe/London")).toBe(true);
    expect(isValidZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidZone("UTC")).toBe(true);
    expect(isValidZone("+02:00")).toBe(false);
    expect(isValidZone("Mars/Olympus")).toBe(false);
    expect(isValidZone("")).toBe(false);
    expect(isValidZone("Europe/London; drop table")).toBe(false);
    expect(isValidZone(42)).toBe(false);
    expect(isValidZone("A".repeat(100))).toBe(false);
  });

  it("reads offsets, including half-hour zones and zones without daylight saving", () => {
    expect(offsetMinutes("Asia/Kolkata", utc(2026, 6, 1))).toBe(330);
    expect(offsetMinutes("Asia/Riyadh", utc(2026, 6, 1))).toBe(180);
    expect(offsetMinutes("America/New_York", utc(2026, 1, 15))).toBe(-300);
    expect(offsetMinutes("America/New_York", utc(2026, 7, 15))).toBe(-240);
    expect(offsetMinutes("Australia/Lord_Howe", utc(2026, 1, 15))).toBe(660);
    expect(offsetMinutes("Australia/Lord_Howe", utc(2026, 7, 15))).toBe(630);
  });

  it("reads the wall clock and the local date at an instant", () => {
    const at = utc(2026, 11, 5, 23, 30);
    expect(localDateTime("Asia/Riyadh", at)).toMatchObject({ day: 6, hour: 2, minute: 30 });
    expect(localDate("America/New_York", at)).toEqual({ year: 2026, month: 11, day: 5 });
    expect(localDate("Pacific/Kiritimati", at)).toEqual({ year: 2026, month: 11, day: 6 });
  });

  it("maps an ordinary wall time to exactly one instant", () => {
    const wall = { year: 2026, month: 6, day: 10, hour: 9, minute: 0 };
    expect(instantsAtWall("Europe/London", wall)).toEqual([utc(2026, 6, 10, 8, 0)]);
    expect(instantsAtWall("Asia/Kolkata", wall)).toEqual([utc(2026, 6, 10, 3, 30)]);
  });

  describe("spring forward (America/New_York, 2026-03-08: 02:00 becomes 03:00)", () => {
    const zone = "America/New_York";
    const jump = utc(2026, 3, 8, 7, 0);
    const wall = (hour: number, minute = 0) => ({ year: 2026, month: 3, day: 8, hour, minute });

    it("finds no instant for a wall time inside the gap", () => {
      expect(instantsAtWall(zone, wall(2, 30))).toEqual([]);
    });

    it("starts and ends a window at the jump when the wall time is in the gap", () => {
      expect(wallStartInstant(zone, wall(2, 30))).toBe(jump);
      expect(wallEndInstant(zone, wall(2, 30))).toBe(jump);
      expect(wallStartInstant(zone, wall(2, 0))).toBe(jump);
    });

    it("counts a 01:00 to 05:00 window as three real hours", () => {
      const start = wallStartInstant(zone, wall(1));
      const end = wallEndInstant(zone, wall(5));
      expect((end - start) / HOUR).toBe(3);
    });
  });

  describe("fall back (America/New_York, 2026-11-01: 02:00 becomes 01:00)", () => {
    const zone = "America/New_York";
    const wall = (hour: number, minute = 0) => ({ year: 2026, month: 11, day: 1, hour, minute });

    it("finds two instants for a repeated wall time", () => {
      expect(instantsAtWall(zone, wall(1, 30))).toEqual([utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 6, 30)]);
    });

    it("starts at the first occurrence and ends at the last", () => {
      expect(wallStartInstant(zone, wall(1, 30))).toBe(utc(2026, 11, 1, 5, 30));
      expect(wallEndInstant(zone, wall(1, 30))).toBe(utc(2026, 11, 1, 6, 30));
    });

    it("counts a 00:00 to 03:00 window as four real hours", () => {
      expect((wallEndInstant(zone, wall(3)) - wallStartInstant(zone, wall(0))) / HOUR).toBe(4);
    });
  });

  it("handles the London changes (last Sundays of March and October)", () => {
    const march = { year: 2026, month: 3, day: 29, hour: 1, minute: 30 };
    expect(instantsAtWall("Europe/London", march)).toEqual([]);
    expect(wallStartInstant("Europe/London", march)).toBe(utc(2026, 3, 29, 1, 0));
    const october = { year: 2026, month: 10, day: 25, hour: 1, minute: 30 };
    expect(instantsAtWall("Europe/London", october)).toEqual([utc(2026, 10, 25, 0, 30), utc(2026, 10, 25, 1, 30)]);
  });

  it("handles a half-hour daylight saving change (Lord Howe, first Sunday of October)", () => {
    // 02:00 standard (+10:30) becomes 02:30 (+11:00): wall times 02:00 to 02:29 do not exist
    const gap = { year: 2026, month: 10, day: 4, hour: 2, minute: 15 };
    expect(instantsAtWall("Australia/Lord_Howe", gap)).toEqual([]);
    expect(wallStartInstant("Australia/Lord_Howe", gap)).toBe(utc(2026, 10, 3, 15, 30));
    const after = { year: 2026, month: 10, day: 4, hour: 2, minute: 30 };
    expect(instantsAtWall("Australia/Lord_Howe", after)).toEqual([utc(2026, 10, 3, 15, 30)]);
  });

  it("returns the wall time of a minute of the day, rolling 24:00 into the next day", () => {
    const date = { year: 2026, month: 12, day: 31 };
    expect(wallOnDate(date, 9 * 60 + 5)).toEqual({ year: 2026, month: 12, day: 31, hour: 9, minute: 5 });
    expect(wallOnDate(date, 1440)).toEqual({ year: 2027, month: 1, day: 1, hour: 0, minute: 0 });
    expect(DAY).toBe(24 * HOUR);
  });
});

describe("formatIsoWithOffset", () => {
  it("writes the wall clock of the zone with its offset, across a clock change", () => {
    expect(formatIsoWithOffset("Europe/London", utc(2026, 11, 10, 10, 0))).toBe("2026-11-10T10:00:00+00:00");
    expect(formatIsoWithOffset("Europe/London", utc(2026, 6, 10, 9, 0))).toBe("2026-06-10T10:00:00+01:00");
    expect(formatIsoWithOffset("Asia/Kolkata", utc(2026, 6, 10, 9, 0))).toBe("2026-06-10T14:30:00+05:30");
    expect(formatIsoWithOffset("America/New_York", utc(2026, 1, 1, 3, 5))).toBe("2025-12-31T22:05:00-05:00");
  });

  it("round-trips through Date.parse", () => {
    const at = utc(2026, 3, 8, 7, 30);
    expect(Date.parse(formatIsoWithOffset("America/New_York", at))).toBe(at);
  });
});
