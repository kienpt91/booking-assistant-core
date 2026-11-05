import type { SalonId } from "../domain/ids.js";
import { DAY, MINUTE, type Instant } from "../domain/time/instant.js";
import { aad } from "./aad.js";
import type { Deps, OutboundChannel } from "./ports.js";
import type { PurgeReport } from "./store.js";

export interface DispatchOptions {
  readonly batchSize: number;
  /** how long a claimed message is invisible to other dispatchers; a crash is retried after this */
  readonly leaseMs: number;
  readonly maxAttempts: number;
  /** wait before the second attempt; doubles each time, never more than an hour */
  readonly backoffMs: number;
}

export const DEFAULT_DISPATCH: DispatchOptions = { batchSize: 20, leaseMs: 2 * MINUTE, maxAttempts: 5, backoffMs: 30_000 };

export interface DispatchReport {
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
}

/**
 * Sends the replies that are due (the outbox pattern). A reply is written in the same transaction as the change that
 * caused it and sent from here: a crash between the two sends it again rather than never, so delivery is at least once;
 * the outbox id goes along as the idempotency key for a channel that can drop the second copy. Nothing about the
 * recipient or the text is logged.
 */
export async function dispatchOutbox(deps: Deps, channel: OutboundChannel, salonId: SalonId, options: DispatchOptions = DEFAULT_DISPATCH): Promise<DispatchReport> {
  const system = { kind: "system", salonId } as const;
  const now = deps.clock.now();
  const due = await deps.db.transaction(system, (tx) => tx.outbox.claimDue(now, options.batchSize, options.leaseMs));
  let sent = 0;
  let retried = 0;
  let dead = 0;
  for (const message of due) {
    try {
      await channel.send({ idempotencyKey: message.id, to: deps.cipher.decrypt(message.recipientEnc, aad.recipient(salonId, message.id)), text: deps.messageCipher.decrypt(message.bodyEnc, aad.outboxBody(salonId, message.id)) });
      await deps.db.transaction(system, (tx) => tx.outbox.markSent(message.id, deps.clock.now()));
      sent++;
    } catch (error) {
      const giveUp = message.attempts >= options.maxAttempts;
      const delay = Math.min(options.backoffMs * 2 ** (message.attempts - 1), 60 * MINUTE);
      await deps.db.transaction(system, (tx) => tx.outbox.markFailed(message.id, giveUp ? null : deps.clock.now() + delay));
      deps.logger.warn("outbox.send_failed", { outboxId: message.id, attempt: message.attempts, giveUp, error: error instanceof Error ? error.name : "unknown" });
      if (giveUp) dead++;
      else retried++;
    }
  }
  return { sent, retried, dead };
}

/** Dispatches for every salon that has a channel. */
export async function dispatchAll(deps: Deps, channel: OutboundChannel, options: DispatchOptions = DEFAULT_DISPATCH): Promise<DispatchReport> {
  let sent = 0;
  let retried = 0;
  let dead = 0;
  for (const salonId of await deps.db.channels.salonsWithChannels()) {
    const report = await dispatchOutbox(deps, channel, salonId, options);
    sent += report.sent;
    retried += report.retried;
    dead += report.dead;
  }
  return { sent, retried, dead };
}

/** Frees the time of holds nobody confirmed. Booking does this itself before it looks; running it on a timer keeps the calendar tidy. */
export async function releaseExpiredHolds(deps: Deps, salonId: SalonId): Promise<number> {
  const now = deps.clock.now();
  return deps.db.transaction({ kind: "system", salonId }, (tx) => tx.appointments.releaseExpiredHolds(now));
}

export interface RetentionPolicy {
  readonly conversationDays: number;
  readonly outboxDays: number;
  readonly inboxDays: number;
  readonly idempotencyDays: number;
  readonly pendingDays: number;
  readonly auditDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { conversationDays: 14, outboxDays: 30, inboxDays: 14, idempotencyDays: 7, pendingDays: 7, auditDays: 400 };

/** Deletes what has outlived its purpose: old conversation text, sent replies, message ids, stored answers, proposals and audit rows. */
export async function applyRetention(deps: Deps, salonId: SalonId, policy: RetentionPolicy = DEFAULT_RETENTION): Promise<PurgeReport> {
  const now = deps.clock.now();
  const before = (days: number): Instant => now - days * DAY;
  return deps.db.transaction({ kind: "system", salonId }, (tx) =>
    tx.maintenance.purge({
      conversationBefore: before(policy.conversationDays),
      outboxBefore: before(policy.outboxDays),
      inboxBefore: before(policy.inboxDays),
      idempotencyBefore: before(policy.idempotencyDays),
      pendingBefore: before(policy.pendingDays),
      auditBefore: before(policy.auditDays),
    }),
  );
}
