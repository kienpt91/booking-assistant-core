import { systemOf, type ClientActor, type StaffActor, type SystemActor } from "../domain/actor.js";
import { asId, type ClientId, type SalonId } from "../domain/ids.js";
import type { E164 } from "../domain/phone.js";
import { sanitizeUntrusted } from "../domain/untrusted-text.js";
import { aad } from "./aad.js";
import { refuse, succeed, type Outcome } from "./outcome.js";
import type { Deps } from "./ports.js";

export interface ResolvedClient {
  readonly actor: ClientActor;
  readonly created: boolean;
}

const MAX_NAME = 60;

/**
 * Finds the client for a sender, or creates them on their first message. The phone number is looked up by its keyed
 * hash and stored encrypted; the profile name the channel supplies is untrusted text, cleaned, capped and encrypted.
 * The first name seen is kept: a later message cannot rename a client.
 */
export async function resolveClient(deps: Deps, salonId: SalonId, phone: E164, displayName: string | undefined): Promise<ResolvedClient> {
  const phoneKey = deps.hasher.phoneKey(salonId, phone);
  const name = displayName === undefined ? "" : sanitizeUntrusted(displayName, MAX_NAME).text;
  const now = deps.clock.now();
  const system: SystemActor = { kind: "system", salonId };
  const newId = asId<"ClientId">(deps.ids.next());
  const found = await deps.db.transaction(system, async (tx) => {
    const existing = await tx.clients.findByPhoneKey(phoneKey);
    if (existing) return { id: existing, created: false };
    return tx.clients.upsertByPhoneKey({
      id: newId,
      phoneKey,
      phoneEnc: deps.cipher.encrypt(phone, aad.phone(salonId, newId)),
      nameEnc: name === "" ? null : deps.cipher.encrypt(name, aad.name(salonId, newId)),
      now,
    });
  });
  return { actor: { kind: "client", salonId, clientId: found.id }, created: found.created };
}

/** The client's name for a greeting, or undefined. Decrypted on demand, never stored in the clear. */
export async function clientDisplayName(deps: Deps, actor: ClientActor): Promise<string | undefined> {
  const pii = await deps.db.transaction(actor, (tx) => tx.clients.getPii(actor.clientId));
  return pii?.nameEnc ? deps.cipher.decrypt(pii.nameEnc, aad.name(actor.salonId, actor.clientId)) : undefined;
}

export interface ErasureReport {
  /** future appointments that were cancelled */
  readonly appointmentsCancelled: number;
  /** appointments whose free-text notes were removed */
  readonly notesScrubbed: number;
}

/**
 * Right to erasure. Deletes the phone number, the name, the conversation, the queued replies, the pending proposals and
 * the stored answers of the client, cancels their future appointments and removes the notes they wrote. What stays is
 * the shape of the history (an appointment existed at this time for this service) under a client id that points
 * to no person, and the audit trail, which holds no personal data. Erasing twice is harmless.
 */
export async function eraseClient(deps: Deps, actor: StaffActor | SystemActor, clientId: ClientId): Promise<Outcome<ErasureReport>> {
  const now = deps.clock.now();
  return deps.db.transaction(systemOf(actor), async (tx) => {
    const client = await tx.clients.get(clientId);
    if (!client) return refuse("not_found");
    if (client.status === "erased") return succeed({ appointmentsCancelled: 0, notesScrubbed: 0 });
    const appointmentsCancelled = await tx.appointments.cancelFuture(clientId, now);
    const notesScrubbed = await tx.appointments.scrubNotes(clientId);
    await tx.conversation.deleteFor(clientId);
    await tx.outbox.deleteFor(clientId);
    await tx.pending.deleteFor(clientId);
    await tx.idempotency.deleteFor(clientId);
    await tx.clients.erase(clientId, now);
    await tx.audit.append({ id: deps.ids.next(), clientId, occurredAt: now, messageId: null, step: 0, event: "erased", tool: null, decision: null, reasons: [], args: null, outcome: "ok" });
    return succeed({ appointmentsCancelled, notesScrubbed });
  });
}

/** Erasure by phone number, for an operator who got the request from the person ("delete my data"). */
export async function eraseClientByPhone(deps: Deps, actor: StaffActor | SystemActor, phone: E164): Promise<Outcome<ErasureReport>> {
  const id = await deps.db.transaction(systemOf(actor), (tx) => tx.clients.findByPhoneKey(deps.hasher.phoneKey(actor.salonId, phone)));
  return id ? eraseClient(deps, actor, id) : refuse("not_found");
}
