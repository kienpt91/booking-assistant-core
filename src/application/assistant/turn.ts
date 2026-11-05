import { isBlocking, type Appointment } from "../../domain/appointment.js";
import { isBookingError, type BookingErrorCode } from "../../domain/errors.js";
import { asId, type ServiceId, type StaffId } from "../../domain/ids.js";
import { sanitizeUntrusted } from "../../domain/untrusted-text.js";
import { redactText } from "../../domain/pii.js";
import { checkCancel, checkMove } from "../../domain/rules.js";
import { MINUTE } from "../../domain/time/instant.js";
import { formatIsoWithOffset } from "../../domain/time/zone.js";
import { findAvailability } from "../availability.js";
import { canonicalJson } from "../canonical.js";
import { holdSlot, listMyAppointments } from "../booking.js";
import type { ConversationTurn, PendingAction } from "../store.js";
import { gatherFacts, record, type ConversationContext } from "./context.js";
import { say, formatWhen } from "./messages.js";
import { MAX_REPLY_LENGTH, parseModelOutput, type ModelMessage } from "./model.js";
import { buildSystemPrompt, toolResultMessage } from "./prompt.js";
import { parseToolCall, toolSpecs, TOOL_NAMES, type ToolCall } from "./tools.js";

export type TurnKind = "reply" | "proposal" | "refused" | "failed";

export interface TurnResult {
  readonly reply: string;
  readonly kind: TurnKind;
}

/** Text the model wrote, made safe to send: invisible and direction characters removed, length capped, numbers that look like phones or cards masked. */
export function outgoing(text: string): string {
  return redactText(sanitizeUntrusted(text, MAX_REPLY_LENGTH).text);
}

type StepOutcome =
  | { readonly kind: "continue"; readonly messages: readonly ModelMessage[]; readonly denied: boolean }
  | { readonly kind: "final"; readonly result: TurnResult };

/**
 * One conversation turn: the model proposes, the application disposes. Each model output is parsed (one JSON object, no extras),
 * a tool call is validated against its strict schema, checked by the policy engine against the authenticated client and facts
 * read from the database, and recorded in the audit log whatever the decision. A read is executed and its result goes back to
 * the model as data. A change is never executed here: it becomes a pending action that the client confirms with a plain
 * "yes" in a later message, and the confirmation prompt is written by the application. The turn ends at the first proposal,
 * so one message can never lead to more than one change. Any failure on the model side ends in a polite refusal, never in an action.
 */
export async function runTurn(ctx: ConversationContext, text: string, history: readonly ConversationTurn[]): Promise<TurnResult> {
  const { language } = ctx;
  const system = buildSystemPrompt({ salon: ctx.salon, services: ctx.services, now: ctx.deps.clock.now(), clientName: ctx.clientName });
  const messages: ModelMessage[] = [...history.map((t): ModelMessage => ({ role: t.role === "client" ? "user" : "assistant", content: t.body })), { role: "user", content: text }];
  let denials = 0;
  let unparseable = 0;

  for (let step = 1; step <= ctx.settings.maxSteps; step++) {
    let raw: string;
    try {
      raw = await ctx.model.complete({ system, messages, tools: toolSpecs() });
    } catch {
      await record(ctx, { step, event: "model_output_rejected", reasons: ["model_error"] });
      return { reply: say.genericError(language), kind: "failed" };
    }
    const parsed = parseModelOutput(raw);
    if (!parsed.ok) {
      await record(ctx, { step, event: "model_output_rejected", reasons: [parsed.error] });
      // several actions in one answer is a bulk attempt: refused at once, not repaired
      if (parsed.error === "multiple_actions") return { reply: say.notAllowed(language), kind: "refused" };
      if (++unparseable >= 2) return { reply: say.cannotUnderstand(language), kind: "failed" };
      messages.push({ role: "assistant", content: raw.slice(0, 500) }, toolResultMessage("system", { error: "invalid_output", problem: parsed.error }));
      continue;
    }
    const action = parsed.value;
    if (action.type === "reply") return { reply: outgoing(action.text), kind: "reply" };

    const outcome = await handleToolCall(ctx, step, action.tool, action.arguments);
    if (outcome.kind === "final") return outcome.result;
    if (outcome.denied && ++denials >= ctx.settings.maxDenials) return { reply: say.notAllowed(language), kind: "refused" };
    messages.push(...outcome.messages);
  }
  return { reply: say.cannotUnderstand(language), kind: "failed" };
}

async function handleToolCall(ctx: ConversationContext, step: number, tool: unknown, args: unknown): Promise<StepOutcome> {
  const { language } = ctx;
  const toolName = typeof tool === "string" ? tool : null;
  const echoed: ModelMessage = { role: "assistant", content: JSON.stringify({ type: "tool_call", tool: toolName, arguments: args }).slice(0, 1000) };

  const parsed = parseToolCall(tool, args);
  if (!parsed.ok) {
    const rejection = parsed.error;
    const reasons = rejection.kind === "unknown_tool" ? ["unknown_tool"] : ["invalid_arguments", ...(rejection.identityOverride ? ["identity_override"] : []), ...rejection.issues.slice(0, 6).map((i) => `${i.field}:${i.problem}`)];
    await record(ctx, { step, event: "tool_call", tool: toolName, decision: "deny", reasons, args });
    // a call that tries to name who is acting is not retried: the model is being steered, not mistaken
    if (rejection.kind === "invalid_arguments" && rejection.identityOverride) return { kind: "final", result: { reply: say.notAllowed(language), kind: "refused" } };
    const error = rejection.kind === "unknown_tool" ? { error: "unknown_tool", tools: TOOL_NAMES } : { error: "invalid_arguments", issues: rejection.issues };
    return { kind: "continue", denied: true, messages: [echoed, toolResultMessage(toolName ?? "unknown", error)] };
  }

  const call = parsed.value;
  const { facts, appointment } = await gatherFacts(ctx, call, 0);
  const decision = ctx.policy.evaluate({ actor: ctx.client, call, phase: "propose", now: ctx.deps.clock.now(), facts });
  await record(ctx, { step, event: "tool_call", tool: call.tool, decision: decision.effect, reasons: decision.reasons, args });

  if (decision.effect === "deny") {
    const reason = decision.reasons[0] ?? "not_allowed";
    return { kind: "continue", denied: true, messages: [echoed, toolResultMessage(call.tool, { error: reason === "not_found" ? "not_found" : "not_allowed", reason })] };
  }
  if (decision.effect === "allow") {
    const result = await executeRead(ctx, call);
    await record(ctx, { step, event: "tool_executed", tool: call.tool, outcome: "ok" });
    return { kind: "continue", denied: false, messages: [echoed, toolResultMessage(call.tool, result)] };
  }
  return { kind: "final", result: await propose(ctx, step, call, appointment) };
}

const asService = (id: string): ServiceId => asId<"ServiceId">(id);
const asStaff = (id: string): StaffId => asId<"StaffId">(id);

async function executeRead(ctx: ConversationContext, call: ToolCall): Promise<unknown> {
  const zone = ctx.salon.timeZone;
  if (call.tool === "check_availability") {
    const out = await findAvailability(ctx.deps, ctx.client, {
      serviceId: asService(call.args.service_id),
      from: call.args.date_from,
      to: call.args.date_to ?? call.args.date_from,
      ...(call.args.staff_id ? { staffId: asStaff(call.args.staff_id) } : {}),
      limit: 12,
    });
    if (!out.ok) return { error: out.error.code };
    return {
      time_zone: out.value.timeZone,
      service: { id: out.value.service.id, name: out.value.service.name, duration_minutes: out.value.service.durationMinutes },
      free_times: out.value.slots.map((s) => ({ staff_id: s.staffId, staff_name: s.staffName, starts_at: formatIsoWithOffset(zone, s.startsAt) })),
    };
  }
  if (call.tool === "my_appointments") {
    const mine = await listMyAppointments(ctx.deps, ctx.client, 10);
    return {
      appointments: mine.map((a) => ({
        appointment_id: a.id,
        service: a.serviceName,
        staff: a.staffName,
        starts_at: formatIsoWithOffset(zone, a.startsAt),
        status: a.status,
        // what the client once wrote: untrusted text, short, and labelled as such
        client_note: a.notes === null ? null : sanitizeUntrusted(a.notes, 100).text,
      })),
    };
  }
  return { error: "not_a_read_tool" };
}

/**
 * Turns an allowed state-changing call into a proposal. For a booking the slot is held for the client first, so it cannot be
 * taken while they decide. Nothing is booked, moved or cancelled here.
 */
async function propose(ctx: ConversationContext, step: number, call: ToolCall, appointment: Appointment | undefined): Promise<TurnResult> {
  const { deps, language, salon } = ctx;
  const now = deps.clock.now();
  const zone = salon.timeZone;
  const refuse = async (code: BookingErrorCode): Promise<TurnResult> => {
    await record(ctx, { step, event: "tool_executed", tool: call.tool, outcome: code });
    return { reply: say.refusal(language, code), kind: "refused" };
  };
  const serviceName = async (id: ServiceId): Promise<string> => (await deps.db.transaction(ctx.client, (tx) => tx.catalog.getService(id)))?.name ?? "";

  let args: Record<string, unknown>;
  let holdAppointmentId: PendingAction["holdAppointmentId"] = null;
  let prompt: string;

  if (call.tool === "book") {
    const service = ctx.services.find((s) => s.id === call.args.service_id);
    const staff = await deps.db.transaction(ctx.client, (tx) => tx.catalog.getStaff(asStaff(call.args.staff_id)));
    if (!service || !staff) return refuse("not_found");
    const hold = await holdSlot(deps, ctx.client, {
      serviceId: service.id,
      staffId: staff.id,
      startsAt: call.args.starts_at,
      notes: call.args.notes,
      idempotencyKey: `${ctx.messageId}:${step}:hold`,
    });
    if (!hold.ok) return refuse(hold.error.code);
    holdAppointmentId = hold.value.id;
    args = { appointment_id: hold.value.id, service_id: service.id, staff_id: staff.id, starts_at: call.args.starts_at };
    prompt = say.confirmBook(language, { service: service.name, staff: staff.name, when: formatWhen(zone, call.args.starts_at, language) });
  } else if (call.tool === "move") {
    if (!appointment) return refuse("not_found");
    const rule = checkMove(salon.policy, now, appointment, call.args.new_starts_at, "client");
    if (rule) return refuse(rule);
    args = { appointment_id: appointment.id, new_starts_at: call.args.new_starts_at, expected_version: appointment.version, ...(call.args.staff_id ? { staff_id: call.args.staff_id } : {}) };
    prompt = say.confirmMove(language, { service: await serviceName(appointment.serviceId), from: formatWhen(zone, appointment.startsAt, language), to: formatWhen(zone, call.args.new_starts_at, language) });
  } else if (call.tool === "cancel") {
    if (!appointment) return refuse("not_found");
    if (!isBlocking(appointment.status)) return refuse("not_active");
    const rule = checkCancel(salon.policy, now, appointment, "client");
    if (rule) return refuse(rule);
    args = { appointment_id: appointment.id, expected_version: appointment.version };
    prompt = say.confirmCancel(language, { service: await serviceName(appointment.serviceId), when: formatWhen(zone, appointment.startsAt, language) });
  } else {
    return { reply: say.notAllowed(language), kind: "refused" };
  }

  try {
    await deps.db.transaction(ctx.client, (tx) =>
      tx.pending.create({
        id: deps.ids.next(),
        clientId: ctx.client.clientId,
        tool: call.tool as PendingAction["tool"],
        args,
        argsDigest: deps.hasher.digest(canonicalJson({ tool: call.tool, args })),
        holdAppointmentId,
        createdAt: now,
        expiresAt: now + salon.policy.holdMinutes * MINUTE,
      }),
    );
  } catch (error) {
    if (!isBookingError(error)) throw error;
    return refuse(error.code);
  }
  return { reply: prompt, kind: "proposal" };
}
