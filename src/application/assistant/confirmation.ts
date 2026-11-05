import type { BookingErrorCode } from "../../domain/errors.js";
import { asId, parseUuid, type ServiceId, type StaffId } from "../../domain/ids.js";
import { cancelAppointment, confirmHold, moveAppointment, releaseHold } from "../booking.js";
import { canonicalJson, uuidFromDigest } from "../canonical.js";
import type { PendingAction } from "../store.js";
import { gatherFacts, record, type ConversationContext } from "./context.js";
import { formatWhen, say } from "./messages.js";
import type { ToolCall } from "./tools.js";

interface StoredCall {
  readonly call: ToolCall;
  readonly expectedVersion: number | undefined;
}

/** The arguments of a stored proposal, read back and checked again: a row that was edited in the database does not get to run. */
function readCall(pending: PendingAction): StoredCall | undefined {
  const a = pending.args;
  const id = parseUuid(a["appointment_id"]);
  const version = a["expected_version"];
  const expectedVersion = Number.isSafeInteger(version) ? (version as number) : undefined;
  const staff = a["staff_id"] === undefined ? undefined : parseUuid(a["staff_id"]);
  const service = parseUuid(a["service_id"]);
  const startsAt = a["starts_at"];
  const newStartsAt = a["new_starts_at"];
  if (pending.tool === "cancel" && id && expectedVersion !== undefined) return { call: { tool: "cancel", args: { appointment_id: id } }, expectedVersion };
  if (pending.tool === "move" && id && expectedVersion !== undefined && Number.isSafeInteger(newStartsAt) && (a["staff_id"] === undefined || staff)) {
    return { call: { tool: "move", args: { appointment_id: id, new_starts_at: newStartsAt as number, staff_id: staff } }, expectedVersion };
  }
  if (pending.tool === "book" && id && service && staff && Number.isSafeInteger(startsAt) && pending.holdAppointmentId === id) {
    return { call: { tool: "book", args: { service_id: service, staff_id: staff, starts_at: startsAt as number, notes: undefined } }, expectedVersion: undefined };
  }
  return undefined;
}

/**
 * The client answered yes. The stored proposal is verified (its digest, its arguments, the policy again with today's
 * quotas) and only then carried out, through the same use cases the rest of the system uses and with an idempotency key
 * derived from the proposal. The reply is written here, from the facts of what happened.
 *
 * The proposal is NOT marked as used here: the caller does that with `settlePending` once the reply is stored. If the
 * process dies in between, the channel's retry finds the proposal still active, carries it out again, gets the stored answer
 * (same idempotency key) and sends the same reply, instead of losing the confirmation.
 */
export async function confirmPending(ctx: ConversationContext, pending: PendingAction): Promise<string> {
  const { deps, language, salon } = ctx;
  const step = 0;
  const failed = async (reasons: string[]): Promise<string> => {
    await record(ctx, { step, event: "confirmation", tool: pending.tool, decision: "deny", reasons });
    if (pending.holdAppointmentId) await releaseHold(deps, ctx.client, pending.holdAppointmentId);
    return say.genericError(language);
  };

  if (deps.hasher.digest(canonicalJson({ tool: pending.tool, args: pending.args })) !== pending.argsDigest) return failed(["digest_mismatch"]);
  const stored = readCall(pending);
  if (!stored) return failed(["stored_arguments_invalid"]);
  const { call, expectedVersion } = stored;

  const { facts } = await gatherFacts(ctx, call, 0);
  const decision = ctx.policy.evaluate({ actor: ctx.client, call, phase: "execute", now: deps.clock.now(), facts });
  await record(ctx, { step, event: "confirmation", tool: pending.tool, decision: decision.effect, reasons: decision.reasons });
  if (decision.effect !== "allow") {
    if (pending.holdAppointmentId) await releaseHold(deps, ctx.client, pending.holdAppointmentId);
    return say.refusal(language, decision.reasons.includes("daily_quota") ? "quota_exceeded" : decision.reasons.includes("not_found") ? "not_found" : "forbidden");
  }

  const key = `pending:${pending.id}`;
  const zone = salon.timeZone;
  // one id per proposal and outcome: a retry that carries the proposal out again records the same fact once, so quotas do not count it twice
  const done = (outcome: string): Promise<void> =>
    record(ctx, { id: uuidFromDigest(deps.hasher.digest(`executed:${pending.id}:${outcome}`)), step, event: "tool_executed", tool: pending.tool, outcome });
  const refuse = async (code: BookingErrorCode): Promise<string> => {
    await done(code);
    return say.refusal(language, code);
  };
  const nameOf = (serviceId: ServiceId, staffId?: StaffId): Promise<{ service: string; staff: string }> =>
    deps.db.transaction(ctx.client, async (tx) => ({
      service: (await tx.catalog.getService(serviceId))?.name ?? "",
      staff: staffId ? ((await tx.catalog.getStaff(staffId))?.name ?? "") : "",
    }));

  if (call.tool === "book" && pending.holdAppointmentId) {
    const out = await confirmHold(deps, ctx.client, pending.holdAppointmentId);
    if (!out.ok) return refuse(out.error.code);
    await done("ok");
    return say.booked(language, { ...(await nameOf(out.value.serviceId, out.value.staffId)), when: formatWhen(zone, out.value.startsAt, language) });
  }
  if (call.tool === "move") {
    const out = await moveAppointment(deps, ctx.client, {
      appointmentId: asId<"AppointmentId">(call.args.appointment_id),
      startsAt: call.args.new_starts_at,
      ...(call.args.staff_id ? { staffId: asId<"StaffId">(call.args.staff_id) } : {}),
      expectedVersion,
      idempotencyKey: key,
    });
    if (!out.ok) return refuse(out.error.code);
    await done("ok");
    return say.moved(language, { service: (await nameOf(out.value.serviceId)).service, to: formatWhen(zone, out.value.startsAt, language) });
  }
  if (call.tool === "cancel") {
    const out = await cancelAppointment(deps, ctx.client, { appointmentId: asId<"AppointmentId">(call.args.appointment_id), expectedVersion, idempotencyKey: key });
    if (!out.ok) return refuse(out.error.code);
    await done("ok");
    return say.cancelled(language, { service: (await nameOf(out.value.serviceId)).service, when: formatWhen(zone, out.value.startsAt, language) });
  }
  return failed(["unsupported_tool"]);
}

/** The client said no, or sent something else: the proposal is dropped and a held slot is given back. */
export async function dropPending(ctx: ConversationContext, pending: PendingAction, why: "declined" | "superseded"): Promise<void> {
  await record(ctx, { step: 0, event: why === "declined" ? "declined" : "confirmation", tool: pending.tool, decision: why === "declined" ? null : "deny", reasons: [why] });
  await settlePending(ctx, why);
  if (pending.holdAppointmentId) await releaseHold(ctx.deps, ctx.client, pending.holdAppointmentId);
}

/** Marks the client's active proposal as used. Idempotent. */
export async function settlePending(ctx: ConversationContext, status: "confirmed" | "declined" | "superseded"): Promise<void> {
  await ctx.deps.db.transaction(ctx.client, async (tx) => {
    await tx.pending.resolveActive(status, ctx.deps.clock.now());
  });
}
