import type { Actor } from "../domain/actor.js";
import type { Appointment } from "../domain/appointment.js";
import type { Salon, Service, StaffMember, WorkingWindow } from "../domain/catalog.js";
import type { AppointmentId, ClientId, SalonId, ServiceId, StaffId } from "../domain/ids.js";
import type { Instant, Interval } from "../domain/time/instant.js";

/**
 * The persistence ports. A `Tx` is one transaction that was opened for one actor: the adapter sets the database role
 * and the identity claims before the first statement, and every repository method is scoped by that actor, so a use
 * case cannot read or change another salon's or another client's rows even by mistake. The adapter backs this with row
 * level security; the scoping in the queries is the second lock on the same door.
 */
export interface Database {
  /**
   * Runs `work` in a transaction as `actor`. A transient failure (serialization, deadlock) runs `work` again, a
   * bounded number of times: `work` must not send messages or call anything outside the transaction.
   */
  transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T>;
  readonly channels: ChannelDirectory;
  ping(): Promise<void>;
}

/** Which salon a chat channel address belongs to. Read before the salon is known, so it is not part of a Tx. */
export interface ChannelDirectory {
  salonFor(channel: string, address: string): Promise<SalonId | undefined>;
  salonsWithChannels(): Promise<SalonId[]>;
}

export interface Tx {
  readonly actor: Actor;
  readonly catalog: CatalogRepository;
  readonly appointments: AppointmentRepository;
  readonly clients: ClientRepository;
  readonly pending: PendingActionRepository;
  readonly idempotency: IdempotencyRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  readonly audit: AuditRepository;
  readonly conversation: ConversationRepository;
  readonly maintenance: MaintenanceRepository;
}

export interface CatalogRepository {
  getSalon(): Promise<Salon | undefined>;
  /** active services only */
  listServices(): Promise<Service[]>;
  getService(id: ServiceId): Promise<Service | undefined>;
  getStaff(id: StaffId): Promise<StaffMember | undefined>;
  /** active staff members who offer the service */
  listStaffFor(serviceId: ServiceId): Promise<StaffMember[]>;
  workingWindows(staffId: StaffId): Promise<WorkingWindow[]>;
  timeOff(staffId: StaffId, range: Interval): Promise<Interval[]>;
}

export interface NewAppointment {
  readonly id: AppointmentId;
  readonly staffId: StaffId;
  readonly clientId: ClientId;
  readonly serviceId: ServiceId;
  readonly status: "held" | "booked";
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly bufferMinutes: number;
  readonly holdExpiresAt: Instant | null;
  readonly notes: string | null;
  readonly now: Instant;
}

export interface Reschedule {
  readonly staffId: StaffId;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly bufferMinutes: number;
  readonly now: Instant;
}

/** Time a staff member is occupied, without saying by whom: all that availability needs to know. */
export interface BusyRange {
  readonly staffId: StaffId;
  readonly start: Instant;
  readonly end: Instant;
}

export interface AppointmentRepository {
  /** Throws `BookingError("slot_unavailable")` or `BookingError("client_overlap")` when the database refuses the time. */
  insert(appointment: NewAppointment): Promise<Appointment>;
  find(id: AppointmentId): Promise<Appointment | undefined>;
  /** Like `find`, and holds the row against concurrent changes until the transaction ends. */
  lock(id: AppointmentId): Promise<Appointment | undefined>;
  /** The actor's own held or booked appointments that have not ended, soonest first. */
  upcoming(now: Instant, limit: number): Promise<Appointment[]>;
  /** Moves a booked appointment; throws like `insert` on a conflict. Increases the version. */
  reschedule(id: AppointmentId, change: Reschedule): Promise<Appointment>;
  /** held to booked, held or booked to cancelled. Increases the version. */
  setStatus(id: AppointmentId, status: "booked" | "cancelled", now: Instant): Promise<Appointment>;
  /** System only: who is busy when. Expired holds do not count. */
  busy(staffIds: readonly StaffId[], range: Interval, now: Instant, excluding?: AppointmentId): Promise<BusyRange[]>;
  /** System only: marks holds that nobody confirmed as expired, which frees their time. */
  releaseExpiredHolds(now: Instant): Promise<number>;
  /** System only: cancels the client's future appointments (right to erasure). */
  cancelFuture(clientId: ClientId, now: Instant): Promise<number>;
  /** System only: removes the free text the client wrote on their appointments. */
  scrubNotes(clientId: ClientId): Promise<number>;
}

export interface ClientRecord {
  readonly id: ClientId;
  readonly status: "active" | "erased";
  readonly createdAt: Instant;
}

export interface ClientPii {
  readonly phoneEnc: string;
  readonly nameEnc: string | null;
}

export interface ClientRepository {
  /** System only. */
  findByPhoneKey(phoneKey: string): Promise<ClientId | undefined>;
  /** System only. Creates the client, or returns the one that already has this phone key (two first messages at once). */
  upsertByPhoneKey(input: { id: ClientId; phoneKey: string; phoneEnc: string; nameEnc: string | null; now: Instant }): Promise<{ id: ClientId; created: boolean }>;
  get(id: ClientId): Promise<ClientRecord | undefined>;
  /** System only. True when the client exists and is not erased. Holds the client row against an erasure until the transaction ends. */
  lockActive(id: ClientId): Promise<boolean>;
  getPii(id: ClientId): Promise<ClientPii | undefined>;
  /** System only: deletes the personal data and marks the client erased; their history keeps its shape. */
  erase(id: ClientId, now: Instant): Promise<void>;
}

export type PendingTool = "book" | "move" | "cancel";
export type PendingStatus = "active" | "confirmed" | "declined" | "superseded" | "expired";

export interface PendingAction {
  readonly id: string;
  readonly clientId: ClientId;
  readonly tool: PendingTool;
  readonly args: Readonly<Record<string, unknown>>;
  /** SHA-256 of the tool and the arguments: the confirmation carries out exactly what the client was shown */
  readonly argsDigest: string;
  readonly holdAppointmentId: AppointmentId | null;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
}

export interface PendingActionRepository {
  /** At most one action per client is active: the new one replaces the old (the old becomes superseded). */
  create(action: PendingAction): Promise<void>;
  /** The client's active action that has not expired. */
  findActive(now: Instant): Promise<PendingAction | undefined>;
  /** Marks the client's active action(s) as resolved and returns the ones that were active. */
  resolveActive(status: Exclude<PendingStatus, "active">, now: Instant): Promise<PendingAction[]>;
  deleteFor(clientId: ClientId): Promise<void>;
}

export interface IdempotencyRepository {
  /** Serialises requests with the same key (an advisory lock held until the transaction ends). */
  lock(key: string): Promise<void>;
  find(key: string): Promise<{ readonly requestDigest: string; readonly response: unknown } | undefined>;
  store(key: string, requestDigest: string, response: unknown, now: Instant): Promise<void>;
  deleteFor(clientId: ClientId): Promise<void>;
}

export interface InboxRepository {
  /**
   * The attempt number (1, 2, ...) when this worker now owns the message; 0 when it is done or another worker holds an unexpired lease.
   * The attempt number is the owner's token: `complete` and `release` act only for the worker that still holds it, so a worker whose
   * lease was taken over cannot finish or release the message under the new owner.
   */
  claim(channel: string, messageId: string, now: Instant, leaseMs: number): Promise<number>;
  complete(channel: string, messageId: string, attempt: number, now: Instant): Promise<void>;
  /** Gives the message up so that the channel's next delivery can be processed at once. */
  release(channel: string, messageId: string, attempt: number, now: Instant): Promise<void>;
}

export interface NewOutbound {
  readonly id: string;
  readonly clientId: ClientId;
  /** one reply per inbound message and position: a retried webhook cannot enqueue it twice */
  readonly dedupeKey: string;
  readonly recipientEnc: string;
  /** the text of the reply, encrypted: a reply can address the client by name */
  readonly bodyEnc: string;
  readonly now: Instant;
}

export interface DueOutbound {
  readonly id: string;
  readonly clientId: ClientId;
  readonly recipientEnc: string;
  readonly bodyEnc: string;
  readonly attempts: number;
}

export interface OutboxRepository {
  /** False when a message with this dedupe key already exists. */
  enqueue(message: NewOutbound): Promise<boolean>;
  /** Takes up to `limit` messages that are due and leases them, so two dispatchers never send the same one. */
  claimDue(now: Instant, limit: number, leaseMs: number): Promise<DueOutbound[]>;
  markSent(id: string, now: Instant): Promise<void>;
  /** `retryAt` null gives up on the message (status dead). */
  markFailed(id: string, retryAt: Instant | null): Promise<void>;
  deleteFor(clientId: ClientId): Promise<void>;
}

export type AuditEvent = "tool_call" | "tool_executed" | "confirmation" | "declined" | "model_output_rejected" | "flagged" | "rate_limited" | "erased";
export type AuditDecision = "allow" | "confirm" | "deny";

export interface AuditEntry {
  readonly id: string;
  readonly clientId: ClientId | null;
  readonly occurredAt: Instant;
  readonly messageId: string | null;
  readonly step: number;
  readonly event: AuditEvent;
  readonly tool: string | null;
  readonly decision: AuditDecision | null;
  readonly reasons: readonly string[];
  /** already redacted: see `redactValue` */
  readonly args: unknown;
  readonly outcome: string | null;
}

export interface AuditCountQuery {
  readonly event: AuditEvent;
  readonly tools: readonly string[];
  readonly since: Instant;
  readonly decision?: AuditDecision;
  readonly outcome?: string;
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  /** How many audit entries match, for the actor's client (client actors) or the whole salon (staff and system): the basis of the daily quotas. */
  count(query: AuditCountQuery): Promise<number>;
  /** Newest first. For the actor's client (client actors) or the whole salon (staff and system). */
  recent(limit: number): Promise<AuditEntry[]>;
}

/** One turn as the assistant reads it. */
export interface ConversationTurn {
  readonly role: "client" | "assistant";
  readonly body: string;
}

/** One turn as stored: the text is encrypted and bound to the turn's id. */
export interface StoredTurn {
  readonly id: string;
  readonly role: ConversationTurn["role"];
  readonly bodyEnc: string;
}

export interface ConversationRepository {
  /** The actor's most recent turns, oldest first. */
  recent(limit: number): Promise<StoredTurn[]>;
  /** System only. */
  append(turn: StoredTurn & { readonly clientId: ClientId; readonly now: Instant }): Promise<void>;
  /** System only: keeps the newest `keep` turns of the client. */
  trim(clientId: ClientId, keep: number): Promise<void>;
  deleteFor(clientId: ClientId): Promise<void>;
}

export interface RetentionCutoffs {
  readonly conversationBefore: Instant;
  readonly outboxBefore: Instant;
  readonly inboxBefore: Instant;
  readonly idempotencyBefore: Instant;
  readonly pendingBefore: Instant;
  readonly auditBefore: Instant;
}

export interface PurgeReport {
  readonly conversation: number;
  readonly outbox: number;
  readonly inbox: number;
  readonly idempotency: number;
  readonly pending: number;
  readonly audit: number;
}

export interface MaintenanceRepository {
  /** System only. */
  purge(cutoffs: RetentionCutoffs): Promise<PurgeReport>;
}
