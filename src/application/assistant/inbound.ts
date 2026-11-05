import type { ClientActor } from "../../domain/actor.js";
import { redactText } from "../../domain/pii.js";
import { normalizePhone } from "../../domain/phone.js";
import { MINUTE } from "../../domain/time/instant.js";
import { detectLanguage, injectionFlags, matchConfirmation, sanitizeUntrusted, type Language } from "../../domain/untrusted-text.js";
import { clientDisplayName, resolveClient } from "../clients.js";
import type { Deps } from "../ports.js";
import { confirmPending, dropPending, settlePending } from "./confirmation.js";
import { DEFAULT_SETTINGS, record, type AssistantSettings, type ConversationContext } from "./context.js";
import { SlidingWindowLimiter } from "./limits.js";
import { say } from "./messages.js";
import type { AssistantModel } from "./model.js";
import { PolicyEngine } from "./policy.js";
import { runTurn } from "./turn.js";

/** A message a channel adapter hands over, already authenticated as coming from that channel (see the webhook). */
export interface InboundMessage {
  readonly channel: string;
  /** the channel's id of the message: the key of the de-duplication */
  readonly messageId: string;
  /** the channel address the message was sent to: it names the salon */
  readonly to: string;
  /** the sender's phone number as the channel gives it: the identity of the client */
  readonly from: string;
  readonly text: unknown;
  /** the profile name the channel supplies, if any: untrusted text */
  readonly senderName?: string | undefined;
}

export interface AssistantRuntime {
  readonly model: AssistantModel;
  readonly policy: PolicyEngine;
  /** messages per client per minute, before anything else happens */
  readonly messageLimiter: SlidingWindowLimiter;
  readonly settings: AssistantSettings;
  /** calling code ("44") for senders whose number arrives in national form; none means only international numbers are accepted */
  readonly defaultCountryCode?: string | undefined;
}

export function createRuntime(model: AssistantModel, over: Partial<Omit<AssistantRuntime, "model">> = {}): AssistantRuntime {
  return {
    model,
    policy: over.policy ?? new PolicyEngine(),
    messageLimiter: over.messageLimiter ?? new SlidingWindowLimiter(60_000, 20),
    settings: over.settings ?? DEFAULT_SETTINGS,
    defaultCountryCode: over.defaultCountryCode,
  };
}

export type ReceiveStatus = "processed" | "duplicate" | "invalid" | "unknown_recipient" | "rate_limited";

export interface ReceiveResult {
  readonly status: ReceiveStatus;
}

export const MAX_INBOUND_CHARS = 4_000;
export const MAX_CLIENT_TEXT = 1_000;
/** how long a worker owns a message before the channel's next delivery may take it over */
export const LEASE_MS = 2 * MINUTE;
const KEEP_TURNS = 10;

const CHANNEL = /^[a-z0-9_-]{1,32}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * Handles one inbound chat message end to end, safely to repeat:
 *   1. the salon is found from the address the message was sent to, the sender from their phone number;
 *   2. the message id is claimed (a repeated delivery is answered once; a worker that died is taken over after its lease);
 *   3. a pending proposal is confirmed or dropped by a plain yes or no, else the assistant answers;
 *   4. the reply, the conversation turns and the completion of the message are written in one transaction, the reply into
 *      the outbox, so a crash leaves either everything or nothing and sending is a separate, retried step.
 * An unexpected failure releases the claim and is rethrown, so the channel's retry processes the message again.
 */
export async function receiveMessage(deps: Deps, runtime: AssistantRuntime, message: InboundMessage): Promise<ReceiveResult> {
  if (!CHANNEL.test(message.channel) || !isId(message.messageId, 200) || !isId(message.to, 64) || typeof message.from !== "string") return { status: "invalid" };
  const phone = normalizePhone(message.from, runtime.defaultCountryCode);
  if (!phone) return { status: "invalid" };
  const salonId = await deps.db.channels.salonFor(message.channel, message.to);
  if (!salonId) return { status: "unknown_recipient" };

  const system = { kind: "system", salonId } as const;
  const now = deps.clock.now();
  if (!(await deps.db.transaction(system, (tx) => tx.inbox.claim(message.channel, message.messageId, now, LEASE_MS)))) return { status: "duplicate" };

  try {
    const { actor, created } = await resolveClient(deps, salonId, phone, message.senderName);
    deps.logger.info("inbound.received", { salonId, clientId: actor.clientId, messageId: message.messageId, newClient: created });

    if (!runtime.messageLimiter.hit(`${salonId}:${actor.clientId}`, now)) {
      await deps.db.transaction(actor, (tx) =>
        tx.audit.append({ id: deps.ids.next(), clientId: actor.clientId, occurredAt: now, messageId: message.messageId, step: 0, event: "rate_limited", tool: null, decision: null, reasons: ["messages_per_minute"], args: null, outcome: null }),
      );
      await deps.db.transaction(system, (tx) => tx.inbox.complete(message.channel, message.messageId, deps.clock.now()));
      return { status: "rate_limited" };
    }

    const { reply, heard, afterCommit } = await converse(deps, runtime, actor, message);
    await deps.db.transaction(system, async (tx) => {
      await tx.outbox.enqueue({ id: deps.ids.next(), clientId: actor.clientId, dedupeKey: `${message.channel}:${message.messageId}:0`, recipientEnc: deps.cipher.encrypt(phone), body: reply, now: deps.clock.now() });
      await tx.conversation.append(actor.clientId, "client", redactText(heard).slice(0, 500), now);
      await tx.conversation.append(actor.clientId, "assistant", redactText(reply).slice(0, 1_500), deps.clock.now());
      await tx.conversation.trim(actor.clientId, KEEP_TURNS);
      await tx.inbox.complete(message.channel, message.messageId, deps.clock.now());
    });
    // the proposal is marked as used only now that its answer is stored (see confirmPending); if this fails the
    // reply is already safe and the proposal simply expires, where carrying it out again would replay the same answer
    await afterCommit?.().catch(() => deps.logger.warn("inbound.settle_failed", { messageId: message.messageId }));
    return { status: "processed" };
  } catch (error) {
    await deps.db.transaction(system, (tx) => tx.inbox.release(message.channel, message.messageId, deps.clock.now())).catch(() => undefined);
    throw error;
  }
}

function isId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && PRINTABLE.test(value);
}

interface Conversed {
  readonly reply: string;
  /** what the client said, cleaned: stored (redacted) as the conversation */
  readonly heard: string;
  readonly afterCommit?: () => Promise<void>;
}

async function converse(deps: Deps, runtime: AssistantRuntime, client: ClientActor, message: InboundMessage): Promise<Conversed> {
  const { salon, services } = await deps.db.transaction(client, async (tx) => ({ salon: await tx.catalog.getSalon(), services: await tx.catalog.listServices() }));
  if (!salon) throw new Error("the salon of a known channel does not exist");

  const raw = message.text;
  const language = (text: string): Language => (/\p{L}/u.test(text) ? detectLanguage(text) : salon.defaultLanguage);
  if (typeof raw !== "string") return { reply: say.textOnly(salon.defaultLanguage), heard: "" };
  if (raw.length > MAX_INBOUND_CHARS) return { reply: say.tooLong(language(raw.slice(0, 200))), heard: "" };
  const clean = sanitizeUntrusted(raw, MAX_CLIENT_TEXT);
  if (clean.text === "") return { reply: say.textOnly(salon.defaultLanguage), heard: "" };
  if (clean.truncated) return { reply: say.tooLong(language(clean.text)), heard: clean.text };

  const ctx: ConversationContext = {
    deps,
    model: runtime.model,
    policy: runtime.policy,
    settings: runtime.settings,
    salon,
    services,
    client,
    clientName: await clientDisplayName(deps, client),
    messageId: message.messageId,
    language: language(clean.text),
  };
  const flags = injectionFlags(clean.text);
  if (flags.length > 0) await record(ctx, { step: 0, event: "flagged", reasons: flags });

  const pending = await deps.db.transaction(client, (tx) => tx.pending.findActive(deps.clock.now()));
  if (pending) {
    const answer = matchConfirmation(clean.text);
    if (answer === "yes") return { reply: await confirmPending(ctx, pending), heard: clean.text, afterCommit: () => settlePending(ctx, "confirmed") };
    if (answer === "no") {
      await dropPending(ctx, pending, "declined");
      return { reply: say.declined(ctx.language), heard: clean.text };
    }
    // anything else is a new request: it replaces the proposal instead of confirming it
    await dropPending(ctx, pending, "superseded");
  }
  const history = await deps.db.transaction(client, (tx) => tx.conversation.recent(runtime.settings.historyTurns));
  const result = await runTurn(ctx, clean.text, history);
  return { reply: result.reply, heard: clean.text };
}
