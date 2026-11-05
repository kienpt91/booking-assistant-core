import type { ClientActor } from "../../domain/actor.js";
import type { Appointment } from "../../domain/appointment.js";
import type { Salon, Service } from "../../domain/catalog.js";
import { asId } from "../../domain/ids.js";
import { redactValue } from "../../domain/pii.js";
import { DAY } from "../../domain/time/instant.js";
import type { Language } from "../../domain/untrusted-text.js";
import type { Deps } from "../ports.js";
import type { AuditDecision, AuditEntry, AuditEvent } from "../store.js";
import type { AssistantModel } from "./model.js";
import type { PolicyEngine, PolicyFacts } from "./policy.js";
import type { ToolCall } from "./tools.js";

export interface AssistantSettings {
  /** model calls per message */
  readonly maxSteps: number;
  /** refused tool calls per message before the assistant stops and says it cannot help */
  readonly maxDenials: number;
  /** earlier turns of the conversation shown to the model */
  readonly historyTurns: number;
}

export const DEFAULT_SETTINGS: AssistantSettings = { maxSteps: 4, maxDenials: 2, historyTurns: 8 };

/** The state tools that change a booking: the quotas count these. */
export const WRITE_TOOLS = ["book", "move", "cancel"] as const;

/** Everything one conversation turn works with. The client is the authenticated sender: the model never supplies it. */
export interface ConversationContext {
  readonly deps: Deps;
  readonly model: AssistantModel;
  readonly policy: PolicyEngine;
  readonly settings: AssistantSettings;
  readonly salon: Salon;
  readonly services: readonly Service[];
  readonly client: ClientActor;
  readonly clientName: string | undefined;
  readonly messageId: string;
  readonly language: Language;
}

export interface AuditInput {
  /** a fixed id makes writing the entry again a no-op: used where a retry may record the same fact twice */
  readonly id?: string;
  readonly step: number;
  readonly event: AuditEvent;
  readonly tool?: string | null;
  readonly decision?: AuditDecision | null;
  readonly reasons?: readonly string[];
  /** anything: it is redacted here before it is stored */
  readonly args?: unknown;
  readonly outcome?: string | null;
}

/** Writes one audit entry as the client. The arguments are redacted first: no free text and no phone number reaches the table. */
export async function record(ctx: ConversationContext, entry: AuditInput): Promise<void> {
  const full: AuditEntry = {
    id: entry.id ?? ctx.deps.ids.next(),
    clientId: ctx.client.clientId,
    occurredAt: ctx.deps.clock.now(),
    messageId: ctx.messageId.slice(0, 200),
    step: entry.step,
    event: entry.event,
    tool: entry.tool === undefined || entry.tool === null ? null : entry.tool.slice(0, 40),
    decision: entry.decision ?? null,
    reasons: (entry.reasons ?? []).slice(0, 12).map((r) => r.slice(0, 60)),
    args: entry.args === undefined ? null : redactValue(entry.args),
    outcome: entry.outcome === undefined || entry.outcome === null ? null : entry.outcome.slice(0, 80),
  };
  await ctx.deps.db.transaction(ctx.client, (tx) => tx.audit.append(full));
}

export interface GatheredFacts {
  readonly facts: PolicyFacts;
  /** for move and cancel: the client's own appointment, when the scoped lookup found it */
  readonly appointment: Appointment | undefined;
}

/** The facts the policy needs, read from the database under the client's own identity (a stranger's appointment is simply not found). */
export async function gatherFacts(ctx: ConversationContext, call: ToolCall): Promise<GatheredFacts> {
  const since = ctx.deps.clock.now() - DAY;
  return ctx.deps.db.transaction(ctx.client, async (tx) => {
    const appointment = call.tool === "move" || call.tool === "cancel" ? await tx.appointments.find(asId<"AppointmentId">(call.args.appointment_id)) : undefined;
    const executedToday = await tx.audit.count({ event: "tool_executed", tools: WRITE_TOOLS, outcome: "ok", since });
    const proposedToday = await tx.audit.count({ event: "tool_call", tools: WRITE_TOOLS, decision: "confirm", since });
    const ownsAppointment = call.tool === "move" || call.tool === "cancel" ? appointment !== undefined : undefined;
    return { facts: { ownsAppointment, executedToday, proposedToday }, appointment };
  });
}
