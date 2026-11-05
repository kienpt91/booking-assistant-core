import { describe, expect, it } from "vitest";
import { checkSlot, listSlots, slotsOnDate, type SlotQuery } from "../../src/domain/availability.js";
import { blockedUntil, isBlocking } from "../../src/domain/appointment.js";
import { DEFAULT_POLICY, isValidPolicy, isValidWindow, type BookingPolicy } from "../../src/domain/catalog.js";
import { BookingError, isBookingError } from "../../src/domain/errors.js";
import { parseId, parseUuid } from "../../src/domain/ids.js";
import { err, ok } from "../../src/domain/result.js";
import { checkCancel, checkMove, checkNewStart } from "../../src/domain/rules.js";
import { DAY, MINUTE } from "../../src/domain/time/instant.js";
import { localDateTime } from "../../src/domain/time/zone.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);
const policy: BookingPolicy = { minLeadMinutes: 60, cancelWindowMinutes: 24 * 60, maxAdvanceDays: 30, slotGranularityMinutes: 30, holdMinutes: 5 };
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Monday 2026-06-08, 08:00 in London (BST, UTC+1)
const NOW = utc(2026, 6, 8, 7, 0);
// Tuesday 2026-06-09 in London: 09:00 local is 08:00 UTC
const tue = (hour: number, minute = 0): number => utc(2026, 6, 9, hour - 1, minute);
const TUESDAY = { year: 2026, month: 6, day: 9 };

function query(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    zone: "Europe/London",
    windows: weekdays,
    busy: [],
    timeOff: [],
    clientBusy: [],
    durationMinutes: 30,
    bufferMinutes: 10,
    policy,
    now: NOW,
    initiator: "client",
    ...over,
  };
}

const starts = (q: SlotQuery, date = TUESDAY): number[] => slotsOnDate(q, date).map((s) => s.startsAt);

describe("domain basics", () => {
  it("refuses with fixed messages that carry no data", () => {
    const e = new BookingError("slot_unavailable");
    expect(e.code).toBe("slot_unavailable");
    expect(e.message).toBe("That time is no longer available.");
    expect(isBookingError(e)).toBe(true);
    expect(isBookingError(new Error("x"))).toBe(false);
  });

  it("parses identifiers strictly and canonically", () => {
    expect(parseUuid("3F2B8C1A-0000-4000-8000-000000000001")).toBe("3f2b8c1a-0000-4000-8000-000000000001");
    expect(parseUuid("3f2b8c1a-0000-4000-8000-00000000000")).toBeUndefined();
    expect(parseUuid("3f2b8c1a-0000-9000-8000-000000000001")).toBeUndefined();
    expect(parseUuid("not-a-uuid-at-all-not-a-uuid-at-all!!")).toBeUndefined();
    expect(parseUuid(5)).toBeUndefined();
    expect(parseUuid("3f2b8c1a-0000-4000-8000-000000000001' or '1'='1")).toBeUndefined();
    expect(parseId<"ClientId">("3f2b8c1a-0000-4000-8000-000000000001")).toBe("3f2b8c1a-0000-4000-8000-000000000001");
  });

  it("carries results", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("no")).toEqual({ ok: false, error: "no" });
  });

  it("knows which statuses occupy time and how long", () => {
    expect(isBlocking("held")).toBe(true);
    expect(isBlocking("booked")).toBe(true);
    for (const s of ["cancelled", "expired", "completed"] as const) expect(isBlocking(s)).toBe(false);
    expect(blockedUntil(1_000_000, 10)).toBe(1_000_000 + 10 * MINUTE);
  });

  it("validates policies and working windows", () => {
    expect(isValidPolicy(DEFAULT_POLICY)).toBe(true);
    expect(isValidPolicy({ ...DEFAULT_POLICY, slotGranularityMinutes: 0 })).toBe(false);
    expect(isValidPolicy({ ...DEFAULT_POLICY, minLeadMinutes: -1 })).toBe(false);
    expect(isValidPolicy({ ...DEFAULT_POLICY, maxAdvanceDays: 1.5 })).toBe(false);
    expect(isValidPolicy({ ...DEFAULT_POLICY, holdMinutes: 0 })).toBe(false);
    expect(isValidWindow({ weekday: 1, startMinute: 540, endMinute: 1020 })).toBe(true);
    expect(isValidWindow({ weekday: 1, startMinute: 0, endMinute: 1440 })).toBe(true);
    expect(isValidWindow({ weekday: 0, startMinute: 540, endMinute: 1020 })).toBe(false);
    expect(isValidWindow({ weekday: 8, startMinute: 540, endMinute: 1020 })).toBe(false);
    expect(isValidWindow({ weekday: 1, startMinute: 600, endMinute: 600 })).toBe(false);
    expect(isValidWindow({ weekday: 1, startMinute: 600, endMinute: 1441 })).toBe(false);
    expect(isValidWindow({ weekday: 1, startMinute: -5, endMinute: 600 })).toBe(false);
  });
});

describe("booking rules", () => {
  it("refuses the past, a start inside the lead time and one beyond the horizon, for a client", () => {
    expect(checkNewStart(policy, NOW, NOW - 1, "client")).toBe("in_the_past");
    expect(checkNewStart(policy, NOW, NOW, "client")).toBe("in_the_past");
    expect(checkNewStart(policy, NOW, NOW + 59 * MINUTE, "client")).toBe("lead_time");
    expect(checkNewStart(policy, NOW, NOW + 60 * MINUTE, "client")).toBeUndefined();
    expect(checkNewStart(policy, NOW, NOW + 30 * DAY, "client")).toBeUndefined();
    expect(checkNewStart(policy, NOW, NOW + 30 * DAY + 1, "client")).toBe("too_far_ahead");
  });

  it("lets staff book inside the lead time and beyond the horizon, but not in the past", () => {
    expect(checkNewStart(policy, NOW, NOW + MINUTE, "staff")).toBeUndefined();
    expect(checkNewStart(policy, NOW, NOW + 90 * DAY, "staff")).toBeUndefined();
    expect(checkNewStart(policy, NOW, NOW - MINUTE, "staff")).toBe("in_the_past");
  });

  it("applies the cancellation window to clients and not to staff", () => {
    const soon = { status: "booked", startsAt: NOW + 23 * 60 * MINUTE } as const;
    const later = { status: "booked", startsAt: NOW + 24 * 60 * MINUTE } as const;
    expect(checkCancel(policy, NOW, soon, "client")).toBe("cancellation_window");
    expect(checkCancel(policy, NOW, later, "client")).toBeUndefined();
    expect(checkCancel(policy, NOW, soon, "staff")).toBeUndefined();
    expect(checkCancel(policy, NOW, { status: "booked", startsAt: NOW - 1 }, "staff")).toBe("in_the_past");
    expect(checkCancel(policy, NOW, { status: "cancelled", startsAt: NOW + 5 * DAY }, "client")).toBe("not_active");
    expect(checkCancel(policy, NOW, { status: "held", startsAt: NOW + 5 * DAY }, "client")).toBeUndefined();
  });

  it("applies the cancellation window and the booking rules to a move", () => {
    const booked = { status: "booked", startsAt: NOW + 3 * DAY } as const;
    expect(checkMove(policy, NOW, booked, NOW + 4 * DAY, "client")).toBeUndefined();
    expect(checkMove(policy, NOW, booked, NOW - 1, "client")).toBe("in_the_past");
    expect(checkMove(policy, NOW, booked, NOW + 40 * DAY, "client")).toBe("too_far_ahead");
    expect(checkMove(policy, NOW, { status: "booked", startsAt: NOW + 2 * 60 * MINUTE }, NOW + 4 * DAY, "client")).toBe("cancellation_window");
    expect(checkMove(policy, NOW, { status: "held", startsAt: NOW + 3 * DAY }, NOW + 4 * DAY, "client")).toBe("not_active");
    expect(checkMove(policy, NOW, { status: "cancelled", startsAt: NOW + 3 * DAY }, NOW + 4 * DAY, "staff")).toBe("not_active");
  });
});

describe("availability", () => {
  it("offers every start of a free working day up to the last one that still ends by closing time", () => {
    const all = starts(query());
    expect(all).toHaveLength(16);
    expect(all[0]).toBe(tue(9));
    expect(all[15]).toBe(tue(16, 30));
  });

  it("offers nothing on a day without a working window", () => {
    expect(starts(query(), { year: 2026, month: 6, day: 13 })).toEqual([]);
    expect(checkSlot(query(), utc(2026, 6, 13, 9, 0))).toBe("outside_working_hours");
  });

  it("keeps the buffer of the previous appointment free and the buffer of the new one", () => {
    // another client holds 10:00 to 10:30 local, with a 10 minute buffer: busy until 10:40
    const busy = [{ start: tue(10), end: tue(10, 40) }];
    const free = starts(query({ busy }));
    expect(free).toContain(tue(9)); // 09:00 to 09:30, blocks until 09:40: fits before 10:00
    expect(free).not.toContain(tue(9, 30)); // its own buffer would run into the 10:00 appointment
    expect(free).not.toContain(tue(10));
    expect(free).not.toContain(tue(10, 30)); // 10:30 starts before the buffer of 10:00 ends (10:40)
    expect(free).toContain(tue(11));
    expect(checkSlot(query({ busy }), tue(9, 30))).toBe("slot_unavailable");
    expect(checkSlot(query({ busy }), tue(11))).toBeUndefined();
  });

  it("does not count touching appointments as a conflict", () => {
    const busy = [{ start: tue(9), end: tue(9, 30) }];
    expect(starts(query({ busy, bufferMinutes: 0 }))).toContain(tue(9, 30));
  });

  it("respects the lead time and the horizon", () => {
    // 08:00 local now, lead time 60 minutes: 09:00 is the first start that is far enough
    expect(starts(query({ now: tue(8) }))[0]).toBe(tue(9));
    expect(starts(query({ now: tue(8, 1) }))[0]).toBe(tue(9, 30));
    expect(starts(query({ now: utc(2026, 5, 1) }))).toEqual([]); // 39 days ahead, horizon 30 days
  });

  it("lets staff see the slots inside the lead time", () => {
    expect(starts(query({ now: tue(8, 50), initiator: "staff" }))[0]).toBe(tue(9));
  });

  it("removes time off and the client's own appointments", () => {
    const timeOff = [{ start: tue(12), end: tue(13) }];
    const free = starts(query({ timeOff }));
    expect(free).toContain(tue(11, 30));
    expect(free).not.toContain(tue(12));
    expect(free).not.toContain(tue(12, 30));
    expect(free).toContain(tue(13));
    expect(checkSlot(query({ timeOff }), tue(12))).toBe("time_off");

    const clientBusy = [{ start: tue(14), end: tue(15) }];
    expect(starts(query({ clientBusy }))).not.toContain(tue(14, 30));
    expect(checkSlot(query({ clientBusy }), tue(14, 30))).toBe("client_overlap");
  });

  it("supports a lunch break as two windows", () => {
    const windows = [
      { weekday: 2, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday: 2, startMinute: 13 * 60, endMinute: 17 * 60 },
    ];
    const free = starts(query({ windows }));
    expect(free).toContain(tue(11, 30));
    expect(free).not.toContain(tue(12));
    expect(free).not.toContain(tue(12, 30));
    expect(free).toContain(tue(13));
    expect(checkSlot(query({ windows }), tue(12, 30))).toBe("outside_working_hours");
  });

  it("explains why a single start is refused", () => {
    expect(checkSlot(query(), tue(9, 10))).toBe("not_on_grid");
    expect(checkSlot(query({ durationMinutes: 45 }), tue(16, 30))).toBe("outside_working_hours");
    expect(checkSlot(query(), tue(8, 30))).toBe("outside_working_hours");
    expect(checkSlot(query(), NOW - DAY)).toBe("in_the_past");
    expect(checkSlot(query(), utc(2026, 8, 10, 8, 0))).toBe("too_far_ahead");
    expect(checkSlot(query(), tue(9))).toBeUndefined();
  });

  it("lists slots across days up to a limit", () => {
    const all = listSlots(query(), TUESDAY, { year: 2026, month: 6, day: 12 }, 1000);
    expect(all).toHaveLength(64); // Tue, Wed, Thu, Fri
    expect(listSlots(query(), TUESDAY, { year: 2026, month: 6, day: 12 }, 5)).toHaveLength(5);
    expect(listSlots(query(), { year: 2026, month: 6, day: 13 }, { year: 2026, month: 6, day: 14 }, 5)).toEqual([]);
  });

  describe("on the days the clock changes", () => {
    const zone = "America/New_York";
    const sunday = (over: Partial<SlotQuery> = {}): SlotQuery =>
      query({ zone, windows: [{ weekday: 7, startMinute: 0, endMinute: 360 }], now: utc(2026, 3, 1), policy: { ...policy, minLeadMinutes: 0 }, ...over });
    const clock = (zoneName: string, at: number): string => {
      const l = localDateTime(zoneName, at);
      return `${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
    };

    it("skips the hour that does not exist (2026-03-08) and counts five real hours", () => {
      const slots = slotsOnDate(sunday(), { year: 2026, month: 3, day: 8 });
      expect(slots.map((s) => clock(zone, s.startsAt))).toEqual(["00:00", "00:30", "01:00", "01:30", "03:00", "03:30", "04:00", "04:30", "05:00", "05:30"]);
    });

    it("keeps both passes through the repeated hour (2026-11-01), seven real hours, and books them independently", () => {
      const q = sunday({ now: utc(2026, 10, 25) });
      const slots = slotsOnDate(q, { year: 2026, month: 11, day: 1 });
      expect(slots).toHaveLength(14);
      expect(slots.slice(0, 10).map((s) => clock(zone, s.startsAt))).toEqual(["00:00", "00:30", "01:00", "01:30", "01:00", "01:30", "02:00", "02:30", "03:00", "03:30"]);
      expect(slots[0]?.startsAt).toBe(utc(2026, 11, 1, 4, 0));
      // the first 01:30 (05:30 UTC) is taken; the second 01:30 (06:30 UTC) is not
      const busy = [{ start: utc(2026, 11, 1, 5, 30), end: utc(2026, 11, 1, 6, 0) }];
      const after = slotsOnDate({ ...q, busy, bufferMinutes: 0 }, { year: 2026, month: 11, day: 1 });
      expect(after.map((s) => s.startsAt)).not.toContain(utc(2026, 11, 1, 5, 30));
      expect(after.map((s) => s.startsAt)).toContain(utc(2026, 11, 1, 6, 30));
    });

    it("answers a start inside the gap as outside the working hours", () => {
      // 02:30 on 2026-03-08 does not exist: the instant 07:30 UTC is 03:30 local, which is a normal slot
      expect(checkSlot(sunday(), utc(2026, 3, 8, 7, 30))).toBeUndefined();
      expect(checkSlot(sunday({ windows: [{ weekday: 7, startMinute: 120, endMinute: 180 }] }), utc(2026, 3, 8, 7, 0))).toBe("outside_working_hours");
    });
  });
});
