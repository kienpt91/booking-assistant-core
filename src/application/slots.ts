import type { Salon, Service, StaffMember, WorkingWindow } from "../domain/catalog.js";
import type { StaffId, ServiceId } from "../domain/ids.js";
import type { SlotQuery } from "../domain/availability.js";
import type { Initiator } from "../domain/rules.js";
import type { Instant, Interval } from "../domain/time/instant.js";
import type { Tx } from "./store.js";

export interface StaffSchedule {
  readonly windows: readonly WorkingWindow[];
  readonly timeOff: readonly Interval[];
  /** what other appointments occupy, buffers included */
  readonly busy: readonly Interval[];
}

/** Everything the slot rules need that is not about the client: the salon, the service and each staff member's calendar. */
export interface SlotContext {
  readonly salon: Salon;
  readonly service: Service;
  readonly staff: readonly StaffMember[];
  readonly schedules: ReadonlyMap<StaffId, StaffSchedule>;
}

/**
 * Reads the calendar of the staff members who offer a service, as the system actor (the only role that may see what is
 * busy without seeing who by). Returns undefined when the salon, the service or every requested staff member is
 * missing or inactive.
 */
export async function loadSlotContext(
  tx: Tx,
  now: Instant,
  serviceId: ServiceId,
  onlyStaff: readonly StaffId[] | undefined,
  range: Interval,
  excluding?: Parameters<Tx["appointments"]["busy"]>[3],
): Promise<SlotContext | undefined> {
  const salon = await tx.catalog.getSalon();
  const service = await tx.catalog.getService(serviceId);
  if (!salon || !service?.active) return undefined;
  const offered = await tx.catalog.listStaffFor(serviceId);
  const staff = onlyStaff ? offered.filter((s) => onlyStaff.includes(s.id)) : offered;
  if (staff.length === 0) return undefined;
  const busyAll = await tx.appointments.busy(
    staff.map((s) => s.id),
    range,
    now,
    excluding,
  );
  const schedules = new Map<StaffId, StaffSchedule>();
  for (const member of staff) {
    schedules.set(member.id, {
      windows: await tx.catalog.workingWindows(member.id),
      timeOff: await tx.catalog.timeOff(member.id, range),
      busy: busyAll.filter((b) => b.staffId === member.id).map((b) => ({ start: b.start, end: b.end })),
    });
  }
  return { salon, service, staff, schedules };
}

export function slotQuery(
  ctx: SlotContext,
  staffId: StaffId,
  clientBusy: readonly Interval[],
  now: Instant,
  initiator: Initiator,
  duration?: { readonly durationMinutes: number; readonly bufferMinutes: number },
): SlotQuery {
  const schedule = ctx.schedules.get(staffId);
  return {
    zone: ctx.salon.timeZone,
    windows: schedule?.windows ?? [],
    busy: schedule?.busy ?? [],
    timeOff: schedule?.timeOff ?? [],
    clientBusy,
    durationMinutes: duration?.durationMinutes ?? ctx.service.durationMinutes,
    bufferMinutes: duration?.bufferMinutes ?? ctx.service.bufferMinutes,
    policy: ctx.salon.policy,
    now,
    initiator,
  };
}
