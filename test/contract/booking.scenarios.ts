import { describe, expect, it } from "vitest";
import { findAvailability } from "../../src/application/availability.js";
import { book, cancelAppointment, confirmHold, holdSlot, listMyAppointments, moveAppointment, releaseHold } from "../../src/application/booking.js";
import type { StaffActor } from "../../src/domain/actor.js";
import { asId, type SalonId, type ServiceId, type StaffId } from "../../src/domain/ids.js";
import { MINUTE } from "../../src/domain/time/instant.js";
import { at, newClient, testWorld } from "../support/deps.js";
import { W } from "../support/seed.js";

const cut = W.cut as ServiceId;
const color = W.color as ServiceId;
const staff1 = W.staffA1 as StaffId;
const staff2 = W.staffA2 as StaffId;
const TUE = "2026-11-10";

const request = (time: string, over: Record<string, unknown> = {}) => ({ serviceId: cut, staffId: staff1, startsAt: at(TUE, time), ...over });
const code = (outcome: { ok: boolean; error?: { code: string } }): string | undefined => (outcome.ok ? undefined : outcome.error?.code);
const staffActor: StaffActor = { kind: "staff", salonId: W.salonA as SalonId, staffId: staff1 };
const day = (d: number) => ({ year: 2026, month: 11, day: d });

describe("findAvailability", () => {
  it("offers start times for both staff members, in order, with a limit", async () => {
    const { deps } = testWorld();
    const client = await newClient(deps, 1);
    const out = await findAvailability(deps, client, { serviceId: cut, from: day(10), to: day(10), limit: 6 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.timeZone).toBe("Europe/London");
    expect(out.value.service.name).toBe("Haircut");
    expect(out.value.slots).toHaveLength(6);
    expect(out.value.slots[0]).toMatchObject({ startsAt: at(TUE, "09:00"), endsAt: at(TUE, "09:30") });
    expect(new Set(out.value.slots.map((s) => s.staffName))).toEqual(new Set(["Staff A1", "Staff A2"]));
  });

  it("leaves out times that are taken, buffers included, and times when the client is already booked", async () => {
    const { deps } = testWorld();
    const other = await newClient(deps, 2);
    const me = await newClient(deps, 1);
    expect((await book(deps, other, request("10:00"))).ok).toBe(true);
    expect((await book(deps, me, request("14:00", { staffId: staff2 }))).ok).toBe(true);
    const out = await findAvailability(deps, me, { serviceId: cut, staffId: staff1, from: day(10), to: day(10), limit: 30 });
    if (!out.ok) throw new Error("unexpected");
    const starts = out.value.slots.map((s) => s.startsAt);
    expect(starts).toContain(at(TUE, "09:00"));
    expect(starts).not.toContain(at(TUE, "09:30")); // its buffer would run into 10:00
    expect(starts).not.toContain(at(TUE, "10:00"));
    expect(starts).not.toContain(at(TUE, "10:30")); // inside the buffer of the 10:00 appointment
    expect(starts).toContain(at(TUE, "11:00"));
    expect(starts).not.toContain(at(TUE, "14:00")); // the client is with staff A2 then
  });

  it("refuses an empty, reversed or too long range and an unknown or foreign service", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    expect(code(await findAvailability(deps, me, { serviceId: cut, from: day(12), to: day(10) }))).toBe("invalid_input");
    expect(code(await findAvailability(deps, me, { serviceId: cut, from: day(10), to: day(24) }))).toBe("invalid_input");
    expect((await findAvailability(deps, me, { serviceId: cut, from: day(10), to: day(23) })).ok).toBe(true);
    expect(code(await findAvailability(deps, me, { serviceId: asId<"ServiceId">("c0000000-0000-4000-8000-0000000000ff"), from: day(10), to: day(10) }))).toBe("not_found");
    // a service of another salon does not exist for this one
    expect(code(await findAvailability(deps, me, { serviceId: W.cutB as ServiceId, from: day(10), to: day(10) }))).toBe("not_found");
  });
});

describe("book", () => {
  it("books a slot and stores the service's duration and buffer", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const out = await book(deps, me, request("10:00"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ status: "booked", clientId: me.clientId, startsAt: at(TUE, "10:00"), endsAt: at(TUE, "10:30"), blockedUntil: at(TUE, "10:40"), version: 1 });
  });

  it("gives the second client for the same time slot_unavailable, and the same client client_overlap", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    expect((await book(deps, a, request("10:00"))).ok).toBe(true);
    expect(code(await book(deps, b, request("10:00")))).toBe("slot_unavailable");
    expect(code(await book(deps, b, request("10:15", { startsAt: at(TUE, "10:15") })))).toBe("slot_unavailable");
    // the same client with another staff member at the same time
    expect(code(await book(deps, a, request("10:00", { staffId: staff2 })))).toBe("client_overlap");
    // the other staff member is free for the other client
    expect((await book(deps, b, request("10:00", { staffId: staff2 }))).ok).toBe(true);
  });

  it.each([
    ["in the past", at("2026-11-09", "08:00"), "in_the_past"],
    ["inside the lead time (120 minutes)", at("2026-11-09", "10:30"), "lead_time"],
    ["beyond the horizon", at("2027-03-01", "10:00"), "too_far_ahead"],
    ["before opening", at(TUE, "08:30"), "outside_working_hours"],
    ["off the grid", at(TUE, "10:07"), "not_on_grid"],
    ["on a Saturday", at("2026-11-14", "10:00"), "outside_working_hours"],
  ])("refuses a start %s", async (_name, startsAt, expected) => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    expect(code(await book(deps, me, { serviceId: cut, staffId: staff1, startsAt }))).toBe(expected);
  });

  it("refuses a long service that would end after closing", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    expect(code(await book(deps, me, { serviceId: color, staffId: staff1, startsAt: at(TUE, "16:00") }))).toBe("outside_working_hours");
    expect((await book(deps, me, { serviceId: color, staffId: staff1, startsAt: at(TUE, "15:30") })).ok).toBe(true);
  });

  it("refuses unknown ids, a staff member who does not offer the service, and a bad time", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    expect(code(await book(deps, me, { serviceId: color, staffId: staff2, startsAt: at(TUE, "10:00") }))).toBe("not_found");
    expect(code(await book(deps, me, { serviceId: cut, staffId: W.staffB1 as StaffId, startsAt: at(TUE, "10:00") }))).toBe("not_found");
    expect(code(await book(deps, me, { serviceId: cut, staffId: staff1, startsAt: Number.NaN }))).toBe("invalid_input");
    expect(code(await book(deps, me, { serviceId: cut, staffId: staff1, startsAt: 1.5 }))).toBe("invalid_input");
  });

  it("respects time off", async () => {
    const { deps, addTimeOff } = testWorld();
    await addTimeOff(W.staffA1, at(TUE, "12:00"), at(TUE, "14:00"));
    const me = await newClient(deps, 1);
    expect(code(await book(deps, me, request("12:30")))).toBe("time_off");
    expect((await book(deps, me, request("14:00"))).ok).toBe(true);
  });

  it("masks phone numbers, e-mail addresses and card numbers in the notes, in the stored appointment and in the stored answer of a retry (review finding)", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const input = request("10:00", { notes: "call me on +966 50 123 4567 or sara@example.com, card 4242 4242 4242 4242", idempotencyKey: "notes-1" });
    const first = await book(deps, me, input);
    const replay = await book(deps, me, input);
    if (!first.ok || !replay.ok) throw new Error("unexpected");
    expect(first.value.notes).toBe("call me on [phone] or [email], card [card]");
    expect(replay.value.notes).toBe(first.value.notes);
    expect(JSON.stringify(await listMyAppointments(deps, me))).not.toMatch(/966|sara@|4242/);
  });

  it("cleans the notes the client wrote", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const out = await book(deps, me, request("10:00", { notes: `window\u202e seat\u0000 ${"x".repeat(500)}` }));
    if (!out.ok) throw new Error("unexpected");
    expect(out.value.notes?.startsWith("window seat ")).toBe(true);
    expect(out.value.notes?.length).toBe(300);
    const blank = await book(deps, me, request("11:00", { notes: "  \u200b  " }));
    expect(blank.ok && blank.value.notes).toBeNull();
  });

  describe("with an idempotency key", () => {
    it("returns the first answer for a retry and books once", async () => {
      const { deps } = testWorld();
      const me = await newClient(deps, 1);
      const first = await book(deps, me, request("10:00", { idempotencyKey: "msg-1:0" }));
      const second = await book(deps, me, request("10:00", { idempotencyKey: "msg-1:0" }));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value).toEqual(first.value);
      expect(await listMyAppointments(deps, me)).toHaveLength(1);
    });

    it("refuses the same key for a different request", async () => {
      const { deps } = testWorld();
      const me = await newClient(deps, 1);
      await book(deps, me, request("10:00", { idempotencyKey: "k" }));
      expect(code(await book(deps, me, request("11:00", { idempotencyKey: "k" })))).toBe("idempotency_mismatch");
    });

    it("does not store a refusal: the retry is evaluated again", async () => {
      const { deps } = testWorld();
      const a = await newClient(deps, 1);
      const b = await newClient(deps, 2);
      const taken = await book(deps, a, request("10:00"));
      expect(taken.ok).toBe(true);
      expect(code(await book(deps, b, request("10:00", { idempotencyKey: "k" })))).toBe("slot_unavailable");
      if (taken.ok) await cancelAppointment(deps, a, { appointmentId: taken.value.id });
      expect((await book(deps, b, request("10:00", { idempotencyKey: "k" }))).ok).toBe(true);
    });

    it("does not let one client replay another client's answer", async () => {
      const { deps } = testWorld();
      const a = await newClient(deps, 1);
      const b = await newClient(deps, 2);
      const first = await book(deps, a, request("10:00", { idempotencyKey: "shared" }));
      const second = await book(deps, b, request("11:00", { idempotencyKey: "shared" }));
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.value.id).not.toBe(first.value.id);
    });

    it("refuses a malformed key", async () => {
      const { deps } = testWorld();
      const me = await newClient(deps, 1);
      expect(code(await book(deps, me, request("10:00", { idempotencyKey: "" })))).toBe("invalid_input");
      expect(code(await book(deps, me, request("10:00", { idempotencyKey: "a\nb" })))).toBe("invalid_input");
      expect(code(await book(deps, me, request("10:00", { idempotencyKey: "x".repeat(201) })))).toBe("invalid_input");
    });
  });
});

describe("holds", () => {
  it("block the slot for others until they are confirmed, released or expire", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const hold = await holdSlot(deps, a, request("10:00"));
    expect(hold.ok && hold.value.status).toBe("held");
    if (!hold.ok) return;
    expect(hold.value.holdExpiresAt).toBe(clock.now() + 5 * MINUTE);
    expect(code(await book(deps, b, request("10:00")))).toBe("slot_unavailable");
    clock.advance(5 * MINUTE);
    expect((await book(deps, b, request("10:00"))).ok).toBe(true);
    expect(code(await confirmHold(deps, a, hold.value.id))).toBe("not_active");
  });

  it("are confirmed by their owner, once or twice", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const hold = await holdSlot(deps, a, request("10:00"));
    if (!hold.ok) throw new Error("unexpected");
    const first = await confirmHold(deps, a, hold.value.id);
    expect(first.ok && first.value).toMatchObject({ status: "booked", holdExpiresAt: null, version: 2 });
    expect((await confirmHold(deps, a, hold.value.id)).ok).toBe(true);
  });

  it("cannot be confirmed after they expired, or by another client", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const hold = await holdSlot(deps, a, request("10:00"));
    if (!hold.ok) throw new Error("unexpected");
    expect(code(await confirmHold(deps, b, hold.value.id))).toBe("not_found");
    clock.advance(5 * MINUTE);
    expect(code(await confirmHold(deps, a, hold.value.id))).toBe("hold_expired");
  });

  it("are given back without regard to the cancellation window", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const startsAt = at("2026-11-09", "12:00");
    const hold = await holdSlot(deps, a, { serviceId: cut, staffId: staff1, startsAt });
    if (!hold.ok) throw new Error("unexpected");
    expect(code(await releaseHold(deps, b, hold.value.id))).toBe("not_found");
    expect((await releaseHold(deps, a, hold.value.id)).ok).toBe(true);
    expect((await releaseHold(deps, a, hold.value.id)).ok).toBe(true);
    expect((await book(deps, b, { serviceId: cut, staffId: staff1, startsAt })).ok).toBe(true);
  });
});

describe("moveAppointment", () => {
  it("moves a booking to a free time and increases its version", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const booked = await book(deps, me, request("10:00"));
    if (!booked.ok) throw new Error("unexpected");
    const moved = await moveAppointment(deps, me, { appointmentId: booked.value.id, startsAt: at("2026-11-11", "15:00") });
    expect(moved.ok && moved.value).toMatchObject({ startsAt: at("2026-11-11", "15:00"), endsAt: at("2026-11-11", "15:30"), version: 2, status: "booked" });
  });

  it("can move to a time that overlaps its own old time, and to another staff member", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const booked = await book(deps, me, request("10:00"));
    if (!booked.ok) throw new Error("unexpected");
    expect((await moveAppointment(deps, me, { appointmentId: booked.value.id, startsAt: at(TUE, "10:15") })).ok).toBe(true);
    const other = await moveAppointment(deps, me, { appointmentId: booked.value.id, startsAt: at(TUE, "10:15"), staffId: staff2 });
    expect(other.ok && other.value.staffId).toBe(staff2);
  });

  it("is refused onto a taken time and leaves the appointment where it was", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    await book(deps, b, request("11:00"));
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    expect(code(await moveAppointment(deps, a, { appointmentId: mine.value.id, startsAt: at(TUE, "11:00") }))).toBe("slot_unavailable");
    const still = await listMyAppointments(deps, a);
    expect(still.map((x) => x.startsAt)).toEqual([at(TUE, "10:00")]);
  });

  it("applies the booking rules to the new time and the cancellation window to the old one", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const far = await book(deps, me, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-12", "10:00") });
    if (!far.ok) throw new Error("unexpected");
    expect(code(await moveAppointment(deps, me, { appointmentId: far.value.id, startsAt: at("2026-11-08", "10:00") }))).toBe("in_the_past");
    expect(code(await moveAppointment(deps, me, { appointmentId: far.value.id, startsAt: at("2026-11-13", "10:05") }))).toBe("not_on_grid");
    const soon = await book(deps, me, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-09", "12:00") });
    if (!soon.ok) throw new Error("unexpected");
    expect(code(await moveAppointment(deps, me, { appointmentId: soon.value.id, startsAt: at("2026-11-13", "10:00") }))).toBe("cancellation_window");
  });

  it("refuses an appointment of another client as if it did not exist, and a cancelled or stale one", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    expect(code(await moveAppointment(deps, b, { appointmentId: mine.value.id, startsAt: at(TUE, "11:00") }))).toBe("not_found");
    expect(code(await moveAppointment(deps, a, { appointmentId: mine.value.id, startsAt: at(TUE, "11:00"), expectedVersion: 7 }))).toBe("stale");
    await cancelAppointment(deps, a, { appointmentId: mine.value.id });
    expect(code(await moveAppointment(deps, a, { appointmentId: mine.value.id, startsAt: at(TUE, "11:00") }))).toBe("not_active");
    expect(code(await moveAppointment(deps, a, { appointmentId: mine.value.id, startsAt: Number.NaN }))).toBe("invalid_input");
  });

  it("returns the first answer for a retry with the same key", async () => {
    const { deps } = testWorld();
    const me = await newClient(deps, 1);
    const booked = await book(deps, me, request("10:00"));
    if (!booked.ok) throw new Error("unexpected");
    const input = { appointmentId: booked.value.id, startsAt: at(TUE, "13:00"), idempotencyKey: "move-1" };
    const first = await moveAppointment(deps, me, input);
    const second = await moveAppointment(deps, me, input);
    expect(first.ok && second.ok && second.value.version).toBe(2);
  });
});

describe("cancelAppointment", () => {
  it("cancels outside the window and frees the time", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    expect(code(await cancelAppointment(deps, a, { appointmentId: mine.value.id }))).toBeUndefined();
    expect((await book(deps, b, request("10:00"))).ok).toBe(true);
  });

  it("refuses a client inside the cancellation window and lets staff override it", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const soon = await book(deps, a, { serviceId: cut, staffId: staff1, startsAt: at("2026-11-09", "14:00") });
    if (!soon.ok) throw new Error("unexpected");
    expect(code(await cancelAppointment(deps, a, { appointmentId: soon.value.id }))).toBe("cancellation_window");
    expect((await cancelAppointment(deps, staffActor, { appointmentId: soon.value.id })).ok).toBe(true);
  });

  it("refuses to cancel twice, the past, and another client's appointment", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    expect(code(await cancelAppointment(deps, b, { appointmentId: mine.value.id }))).toBe("not_found");
    expect(code(await cancelAppointment(deps, a, { appointmentId: mine.value.id, expectedVersion: 9 }))).toBe("stale");
    expect((await cancelAppointment(deps, a, { appointmentId: mine.value.id })).ok).toBe(true);
    expect(code(await cancelAppointment(deps, a, { appointmentId: mine.value.id }))).toBe("not_active");
    const other = await book(deps, a, request("12:00"));
    if (!other.ok) throw new Error("unexpected");
    clock.set(at(TUE, "12:30"));
    expect(code(await cancelAppointment(deps, staffActor, { appointmentId: other.value.id }))).toBe("in_the_past");
  });

  it("does not find another client's appointment even for staff of another salon", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    const otherSalonStaff: StaffActor = { kind: "staff", salonId: W.salonB as SalonId, staffId: W.staffB1 as StaffId };
    expect(code(await cancelAppointment(deps, otherSalonStaff, { appointmentId: mine.value.id }))).toBe("not_found");
  });

  it("replays the first answer for a retry with the same key", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    const input = { appointmentId: mine.value.id, idempotencyKey: "c1" };
    const first = await cancelAppointment(deps, a, input);
    const second = await cancelAppointment(deps, a, input);
    expect(first.ok && second.ok).toBe(true);
  });
});

describe("listMyAppointments", () => {
  it("lists only the client's own upcoming appointments with names, soonest first", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    await book(deps, a, request("14:00"));
    await book(deps, a, request("10:00", { notes: "window seat" }));
    await book(deps, b, request("11:00"));
    const mine = await listMyAppointments(deps, a);
    expect(mine.map((x) => [x.serviceName, x.staffName, x.startsAt, x.notes])).toEqual([
      ["Haircut", "Staff A1", at(TUE, "10:00"), "window seat"],
      ["Haircut", "Staff A1", at(TUE, "14:00"), null],
    ]);
    expect(await listMyAppointments(deps, b)).toHaveLength(1);
  });

  it("leaves out cancelled appointments and appointments in the past", async () => {
    const { deps, clock } = testWorld();
    const a = await newClient(deps, 1);
    const x = await book(deps, a, request("10:00"));
    await book(deps, a, request("14:00"));
    if (x.ok) await cancelAppointment(deps, a, { appointmentId: x.value.id });
    expect(await listMyAppointments(deps, a)).toHaveLength(1);
    clock.set(at(TUE, "15:00"));
    expect(await listMyAppointments(deps, a)).toHaveLength(0);
  });

  it("is not able to read an appointment id of someone else", async () => {
    const { deps } = testWorld();
    const a = await newClient(deps, 1);
    const b = await newClient(deps, 2);
    const mine = await book(deps, a, request("10:00"));
    if (!mine.ok) throw new Error("unexpected");
    const foreign = mine.value.id;
    expect(await deps.db.transaction(b, (tx) => tx.appointments.find(foreign))).toBeUndefined();
  });
});
