import type pg from "pg";
import type { Actor } from "../../domain/actor.js";
import { blockedUntil, type Appointment, type AppointmentStatus } from "../../domain/appointment.js";
import type { Salon, Service, StaffMember, WorkingWindow } from "../../domain/catalog.js";
import { BookingError } from "../../domain/errors.js";
import { asId, type AppointmentId, type ClientId, type SalonId, type ServiceId, type StaffId } from "../../domain/ids.js";
import type { Instant, Interval } from "../../domain/time/instant.js";
import { isValidZone } from "../../domain/time/zone.js";
import type { Language } from "../../domain/untrusted-text.js";
import type {
  AppointmentRepository,
  AuditEntry,
  AuditRepository,
  BusyRange,
  CatalogRepository,
  ClientPii,
  ClientRecord,
  ClientRepository,
  ConversationRepository,
  DueOutbound,
  IdempotencyRepository,
  InboxRepository,
  MaintenanceRepository,
  NewAppointment,
  OutboxRepository,
  PendingAction,
  PendingActionRepository,
  PurgeReport,
  Reschedule,
  RetentionCutoffs,
  Tx,
} from "../../application/store.js";
import { constraintName, sqlState } from "./errors.js";

type Db = pg.PoolClient;
type Row = Record<string, unknown>;

const at = (ms: Instant): Date => new Date(ms);
const ms = (value: unknown): Instant => (value instanceof Date ? value.getTime() : Number.NaN);
const text = (value: unknown): string => String(value);
const nullableMs = (value: unknown): Instant | null => (value === null || value === undefined ? null : ms(value));

/** Every statement runs with bind parameters; nothing a caller supplies is ever part of the SQL text. */
async function rows(db: Db, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, [...values])).rows;
}

async function run(db: Db, sql: string, values: readonly unknown[] = []): Promise<number> {
  return (await db.query(sql, [...values])).rowCount ?? 0;
}

const APPOINTMENT_COLUMNS =
  "id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, hold_expires_at, notes, version, created_at, updated_at, cancelled_at";

function toAppointment(r: Row): Appointment {
  return {
    id: asId<"AppointmentId">(text(r["id"])),
    salonId: asId<"SalonId">(text(r["salon_id"])),
    staffId: asId<"StaffId">(text(r["staff_id"])),
    clientId: asId<"ClientId">(text(r["client_id"])),
    serviceId: asId<"ServiceId">(text(r["service_id"])),
    status: text(r["status"]) as AppointmentStatus,
    startsAt: ms(r["starts_at"]),
    endsAt: ms(r["ends_at"]),
    bufferMinutes: Number(r["buffer_minutes"]),
    blockedUntil: ms(r["blocked_until"]),
    holdExpiresAt: nullableMs(r["hold_expires_at"]),
    notes: r["notes"] === null ? null : text(r["notes"]),
    version: Number(r["version"]),
    createdAt: ms(r["created_at"]),
    updatedAt: ms(r["updated_at"]),
    cancelledAt: nullableMs(r["cancelled_at"]),
  };
}

/**
 * Builds the repositories of one transaction. Each query carries the salon of the actor, and for a client also the
 * client, in its WHERE clause; row level security enforces the same thing underneath. A statement that touches
 * something the actor's role may not touch fails with permission denied rather than returning less.
 */
export function createRepositories(actor: Actor, db: Db): Tx {
  const salonId = actor.salonId;
  const clientId = actor.kind === "client" ? actor.clientId : undefined;
  const requireSystem = (what: string): void => {
    if (actor.kind !== "system") throw new Error(`${what} is for the system actor`);
  };
  const requireClient = (what: string): ClientId => {
    if (clientId === undefined) throw new Error(`${what} is for a client actor`);
    return clientId;
  };
  /** `salon_id = $n [AND client_id = $n+1]` and the values, numbered from `from`. */
  const scope = (from: number, column = "client_id"): { sql: string; values: unknown[] } =>
    clientId === undefined ? { sql: `salon_id = $${from}`, values: [salonId] } : { sql: `salon_id = $${from} AND ${column} = $${from + 1}`, values: [salonId, clientId] };
  const actorId = actor.kind === "client" ? actor.clientId : actor.kind === "staff" ? actor.staffId : actor.salonId;

  /** Runs a statement that the database may refuse for a booking reason, inside a savepoint so the transaction survives. */
  async function guarded<T>(statement: () => Promise<T>): Promise<T> {
    await db.query("SAVEPOINT guarded");
    try {
      const result = await statement();
      await db.query("RELEASE SAVEPOINT guarded");
      return result;
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT guarded");
      await db.query("RELEASE SAVEPOINT guarded");
      if (sqlState(error) === "23P01") {
        const name = constraintName(error);
        if (name === "appointments_staff_no_overlap") throw new BookingError("slot_unavailable");
        if (name === "appointments_client_no_overlap") throw new BookingError("client_overlap");
      }
      throw error;
    }
  }

  /**
   * Takes the transaction-scoped advisory locks of a client and a staff member, in that order, before a statement that can
   * occupy time. The exclusion constraints stay the arbiter; the locks only keep two transactions that insert
   * overlapping rows from waiting for each other's uncommitted rows (a deadlock that PostgreSQL resolves by aborting one,
   * after a second). The later transaction waits here, then meets the committed row and is refused cleanly.
   */
  async function serialise(client: ClientId, staff: StaffId): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking:client:${client}`]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking:staff:${staff}`]);
  }

  const catalog: CatalogRepository = {
    async getSalon(): Promise<Salon | undefined> {
      const r = (
        await rows(
          db,
          "SELECT id, name, time_zone, default_language, min_lead_minutes, cancel_window_minutes, max_advance_days, slot_granularity_minutes, hold_minutes FROM salons WHERE id = $1",
          [salonId],
        )
      )[0];
      if (!r) return undefined;
      const zone = text(r["time_zone"]);
      if (!isValidZone(zone)) throw new Error("a salon has a time zone this runtime does not know");
      return {
        id: asId<"SalonId">(text(r["id"])),
        name: text(r["name"]),
        timeZone: zone,
        defaultLanguage: text(r["default_language"]) as Language,
        policy: {
          minLeadMinutes: Number(r["min_lead_minutes"]),
          cancelWindowMinutes: Number(r["cancel_window_minutes"]),
          maxAdvanceDays: Number(r["max_advance_days"]),
          slotGranularityMinutes: Number(r["slot_granularity_minutes"]),
          holdMinutes: Number(r["hold_minutes"]),
        },
      };
    },
    async listServices() {
      return (await rows(db, "SELECT id, salon_id, name, duration_minutes, buffer_minutes, active FROM services WHERE salon_id = $1 AND active ORDER BY name, id", [salonId])).map(toService);
    },
    async getService(id: ServiceId) {
      const r = (await rows(db, "SELECT id, salon_id, name, duration_minutes, buffer_minutes, active FROM services WHERE salon_id = $1 AND id = $2", [salonId, id]))[0];
      return r ? toService(r) : undefined;
    },
    async getStaff(id: StaffId) {
      const r = (await rows(db, "SELECT id, salon_id, name, active FROM staff WHERE salon_id = $1 AND id = $2", [salonId, id]))[0];
      return r ? toStaff(r) : undefined;
    },
    async listStaffFor(serviceId: ServiceId) {
      return (
        await rows(
          db,
          `SELECT s.id, s.salon_id, s.name, s.active FROM staff s JOIN staff_services ss ON ss.salon_id = s.salon_id AND ss.staff_id = s.id
           WHERE s.salon_id = $1 AND ss.service_id = $2 AND s.active ORDER BY s.name, s.id`,
          [salonId, serviceId],
        )
      ).map(toStaff);
    },
    async workingWindows(staffId: StaffId): Promise<WorkingWindow[]> {
      return (await rows(db, "SELECT weekday, start_minute, end_minute FROM working_hours WHERE salon_id = $1 AND staff_id = $2 ORDER BY weekday, start_minute", [salonId, staffId])).map((r) => ({
        weekday: Number(r["weekday"]),
        startMinute: Number(r["start_minute"]),
        endMinute: Number(r["end_minute"]),
      }));
    },
    async timeOff(staffId: StaffId, range: Interval): Promise<Interval[]> {
      return (
        await rows(db, "SELECT lower(during) AS s, upper(during) AS e FROM time_off WHERE salon_id = $1 AND staff_id = $2 AND during && tstzrange($3, $4, '[)')", [salonId, staffId, at(range.start), at(range.end)])
      ).map((r) => ({ start: ms(r["s"]), end: ms(r["e"]) }));
    },
  };

  const appointments: AppointmentRepository = {
    async insert(a: NewAppointment) {
      await serialise(a.clientId, a.staffId);
      const r = await guarded(() =>
        rows(
          db,
          `INSERT INTO appointments (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, hold_expires_at, notes, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13) RETURNING ${APPOINTMENT_COLUMNS}`,
          [a.id, salonId, a.staffId, a.clientId, a.serviceId, a.status, at(a.startsAt), at(a.endsAt), a.bufferMinutes, at(blockedUntil(a.endsAt, a.bufferMinutes)), a.holdExpiresAt === null ? null : at(a.holdExpiresAt), a.notes, at(a.now)],
        ),
      );
      return toAppointment(r[0] as Row);
    },
    async find(id: AppointmentId) {
      const s = scope(2);
      const r = (await rows(db, `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1 AND ${s.sql}`, [id, ...s.values]))[0];
      return r ? toAppointment(r) : undefined;
    },
    async lock(id: AppointmentId) {
      const s = scope(2);
      const r = (await rows(db, `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1 AND ${s.sql} FOR UPDATE`, [id, ...s.values]))[0];
      return r ? toAppointment(r) : undefined;
    },
    async upcoming(now: Instant, limit: number) {
      const s = scope(3);
      return (
        await rows(
          db,
          `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
           WHERE ${s.sql} AND status IN ('held', 'booked') AND ends_at > $1 AND (status = 'booked' OR hold_expires_at > $1)
           ORDER BY starts_at, id LIMIT $2`,
          [at(now), limit, ...s.values],
        )
      ).map(toAppointment);
    },
    async reschedule(id: AppointmentId, c: Reschedule) {
      const owner = (await rows(db, "SELECT client_id FROM appointments WHERE id = $1 AND salon_id = $2", [id, salonId]))[0];
      if (!owner) throw new BookingError("not_found");
      await serialise(asId<"ClientId">(text(owner["client_id"])), c.staffId);
      const s = scope(8);
      const r = await guarded(() =>
        rows(
          db,
          `UPDATE appointments SET staff_id = $2, starts_at = $3, ends_at = $4, buffer_minutes = $5, blocked_until = $6, version = version + 1, updated_at = $7
           WHERE id = $1 AND status = 'booked' AND ${s.sql} RETURNING ${APPOINTMENT_COLUMNS}`,
          [id, c.staffId, at(c.startsAt), at(c.endsAt), c.bufferMinutes, at(blockedUntil(c.endsAt, c.bufferMinutes)), at(c.now), ...s.values],
        ),
      );
      if (!r[0]) throw new BookingError("not_active");
      return toAppointment(r[0]);
    },
    async setStatus(id: AppointmentId, status: "booked" | "cancelled", now: Instant) {
      const s = scope(4);
      const r = await rows(
        db,
        `UPDATE appointments SET status = $2::text,
           hold_expires_at = CASE WHEN $2::text = 'booked' THEN NULL ELSE hold_expires_at END,
           cancelled_at = CASE WHEN $2::text = 'cancelled' THEN $3::timestamptz ELSE cancelled_at END,
           version = version + 1, updated_at = $3::timestamptz
         WHERE id = $1 AND ${s.sql} RETURNING ${APPOINTMENT_COLUMNS}`,
        [id, status, at(now), ...s.values],
      );
      if (!r[0]) throw new BookingError("not_found");
      return toAppointment(r[0]);
    },
    async busy(staffIds: readonly StaffId[], range: Interval, now: Instant, excluding?: AppointmentId): Promise<BusyRange[]> {
      requireSystem("busy");
      return (
        await rows(
          db,
          `SELECT staff_id, starts_at, blocked_until FROM appointments
           WHERE salon_id = $1 AND staff_id = ANY($2::uuid[]) AND (status = 'booked' OR (status = 'held' AND hold_expires_at > $3))
             AND tstzrange(starts_at, blocked_until, '[)') && tstzrange($4, $5, '[)') AND ($6::uuid IS NULL OR id <> $6::uuid)`,
          [salonId, [...staffIds], at(now), at(range.start), at(range.end), excluding ?? null],
        )
      ).map((r) => ({ staffId: asId<"StaffId">(text(r["staff_id"])), start: ms(r["starts_at"]), end: ms(r["blocked_until"]) }));
    },
    async releaseExpiredHolds(now: Instant) {
      requireSystem("releaseExpiredHolds");
      return run(db, "UPDATE appointments SET status = 'expired', version = version + 1, updated_at = $2 WHERE salon_id = $1 AND status = 'held' AND hold_expires_at <= $2", [salonId, at(now)]);
    },
    async cancelFuture(client: ClientId, now: Instant) {
      requireSystem("cancelFuture");
      return run(
        db,
        `UPDATE appointments SET status = 'cancelled', cancelled_at = $3, version = version + 1, updated_at = $3
         WHERE salon_id = $1 AND client_id = $2 AND status IN ('held', 'booked') AND starts_at > $3`,
        [salonId, client, at(now)],
      );
    },
    async scrubNotes(client: ClientId) {
      requireSystem("scrubNotes");
      return run(db, "UPDATE appointments SET notes = NULL WHERE salon_id = $1 AND client_id = $2 AND notes IS NOT NULL", [salonId, client]);
    },
  };

  const clients: ClientRepository = {
    async findByPhoneKey(phoneKey: string) {
      requireSystem("findByPhoneKey");
      const r = (await rows(db, "SELECT client_id FROM client_pii WHERE salon_id = $1 AND phone_hash = $2", [salonId, phoneKey]))[0];
      return r ? asId<"ClientId">(text(r["client_id"])) : undefined;
    },
    async upsertByPhoneKey(input) {
      requireSystem("upsertByPhoneKey");
      await db.query("SAVEPOINT new_client");
      await db.query("INSERT INTO clients (id, salon_id, created_at) VALUES ($1, $2, $3)", [input.id, salonId, at(input.now)]);
      const inserted = await db.query("INSERT INTO client_pii (client_id, salon_id, phone_hash, phone_enc, name_enc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (salon_id, phone_hash) DO NOTHING", [
        input.id,
        salonId,
        input.phoneKey,
        input.phoneEnc,
        input.nameEnc,
      ]);
      if (inserted.rowCount === 1) {
        await db.query("RELEASE SAVEPOINT new_client");
        return { id: input.id, created: true };
      }
      // another message from the same number won the race: drop the row made for this one and use theirs
      await db.query("ROLLBACK TO SAVEPOINT new_client");
      await db.query("RELEASE SAVEPOINT new_client");
      const existing = (await rows(db, "SELECT client_id FROM client_pii WHERE salon_id = $1 AND phone_hash = $2", [salonId, input.phoneKey]))[0];
      if (!existing) throw new Error("client vanished after a conflict");
      return { id: asId<"ClientId">(text(existing["client_id"])), created: false };
    },
    async get(id: ClientId): Promise<ClientRecord | undefined> {
      const s = scope(2, "id");
      const r = (await rows(db, `SELECT id, status, created_at FROM clients WHERE id = $1 AND ${s.sql}`, [id, ...s.values]))[0];
      return r ? { id: asId<"ClientId">(text(r["id"])), status: text(r["status"]) as ClientRecord["status"], createdAt: ms(r["created_at"]) } : undefined;
    },
    async getPii(id: ClientId): Promise<ClientPii | undefined> {
      const s = scope(2);
      const r = (await rows(db, `SELECT phone_enc, name_enc FROM client_pii WHERE client_id = $1 AND ${s.sql}`, [id, ...s.values]))[0];
      return r ? { phoneEnc: text(r["phone_enc"]), nameEnc: r["name_enc"] === null ? null : text(r["name_enc"]) } : undefined;
    },
    async erase(id: ClientId, now: Instant) {
      requireSystem("erase");
      await run(db, "DELETE FROM client_pii WHERE client_id = $1 AND salon_id = $2", [id, salonId]);
      await run(db, "UPDATE clients SET status = 'erased', erased_at = $3 WHERE id = $1 AND salon_id = $2", [id, salonId, at(now)]);
    },
  };

  const PENDING_COLUMNS = "id, client_id, tool, args, args_digest, hold_appointment_id, created_at, expires_at";
  const toPending = (r: Row): PendingAction => ({
    id: text(r["id"]),
    clientId: asId<"ClientId">(text(r["client_id"])),
    tool: text(r["tool"]) as PendingAction["tool"],
    args: r["args"] as PendingAction["args"],
    argsDigest: text(r["args_digest"]),
    holdAppointmentId: r["hold_appointment_id"] === null ? null : asId<"AppointmentId">(text(r["hold_appointment_id"])),
    createdAt: ms(r["created_at"]),
    expiresAt: ms(r["expires_at"]),
  });
  const pending: PendingActionRepository = {
    async create(action) {
      const me = requireClient("pending.create");
      await run(db, "UPDATE pending_actions SET status = 'superseded', resolved_at = $3 WHERE salon_id = $1 AND client_id = $2 AND status = 'active'", [salonId, me, at(action.createdAt)]);
      await run(
        db,
        `INSERT INTO pending_actions (id, salon_id, client_id, tool, args, args_digest, hold_appointment_id, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'active', $8, $9)`,
        [action.id, salonId, me, action.tool, JSON.stringify(action.args), action.argsDigest, action.holdAppointmentId, at(action.createdAt), at(action.expiresAt)],
      );
    },
    async findActive(now) {
      const me = requireClient("pending.findActive");
      const r = (await rows(db, `SELECT ${PENDING_COLUMNS} FROM pending_actions WHERE salon_id = $1 AND client_id = $2 AND status = 'active' AND expires_at > $3`, [salonId, me, at(now)]))[0];
      return r ? toPending(r) : undefined;
    },
    async resolveActive(status, now) {
      const me = requireClient("pending.resolveActive");
      return (await rows(db, `UPDATE pending_actions SET status = $3, resolved_at = $4 WHERE salon_id = $1 AND client_id = $2 AND status = 'active' RETURNING ${PENDING_COLUMNS}`, [salonId, me, status, at(now)])).map(toPending);
    },
    async deleteFor(client) {
      requireSystem("pending.deleteFor");
      await run(db, "DELETE FROM pending_actions WHERE salon_id = $1 AND client_id = $2", [salonId, client]);
    },
  };

  const idempotency: IdempotencyRepository = {
    async lock(key) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${salonId}:${actorId}:${key}`]);
    },
    async find(key) {
      const r = (await rows(db, "SELECT request_digest, response FROM idempotency_keys WHERE salon_id = $1 AND actor_id = $2 AND key = $3", [salonId, actorId, key]))[0];
      return r ? { requestDigest: text(r["request_digest"]), response: r["response"] } : undefined;
    },
    async store(key, requestDigest, response, now) {
      await run(db, "INSERT INTO idempotency_keys (salon_id, actor_id, key, request_digest, response, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)", [salonId, actorId, key, requestDigest, JSON.stringify(response), at(now)]);
    },
    async deleteFor(client) {
      requireSystem("idempotency.deleteFor");
      await run(db, "DELETE FROM idempotency_keys WHERE salon_id = $1 AND actor_id = $2", [salonId, client]);
    },
  };

  const inbox: InboxRepository = {
    async claim(channel, messageId, now, leaseMs) {
      requireSystem("inbox.claim");
      const claimed = await run(
        db,
        `INSERT INTO inbound_messages (salon_id, channel, message_id, status, attempts, lease_until, received_at)
         VALUES ($1, $2, $3, 'processing', 1, $4, $5)
         ON CONFLICT (salon_id, channel, message_id) DO UPDATE SET attempts = inbound_messages.attempts + 1, lease_until = EXCLUDED.lease_until
           WHERE inbound_messages.status = 'processing' AND inbound_messages.lease_until <= $5`,
        [salonId, channel, messageId, at(now + leaseMs), at(now)],
      );
      return claimed === 1;
    },
    async complete(channel, messageId, now) {
      requireSystem("inbox.complete");
      await run(db, "UPDATE inbound_messages SET status = 'done', completed_at = $4 WHERE salon_id = $1 AND channel = $2 AND message_id = $3", [salonId, channel, messageId, at(now)]);
    },
    async release(channel, messageId, now) {
      requireSystem("inbox.release");
      await run(db, "UPDATE inbound_messages SET lease_until = $4 WHERE salon_id = $1 AND channel = $2 AND message_id = $3 AND status = 'processing'", [salonId, channel, messageId, at(now)]);
    },
  };

  const outbox: OutboxRepository = {
    async enqueue(m) {
      requireSystem("outbox.enqueue");
      return (
        (await run(
          db,
          `INSERT INTO outbox_messages (id, salon_id, client_id, dedupe_key, recipient_enc, body, status, attempts, next_attempt_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $7) ON CONFLICT (salon_id, dedupe_key) DO NOTHING`,
          [m.id, salonId, m.clientId, m.dedupeKey, m.recipientEnc, m.body, at(m.now)],
        )) === 1
      );
    },
    async claimDue(now, limit, leaseMs): Promise<DueOutbound[]> {
      requireSystem("outbox.claimDue");
      return (
        await rows(
          db,
          `WITH due AS (
             SELECT id FROM outbox_messages
             WHERE salon_id = $1 AND status = 'pending' AND next_attempt_at <= $2 AND (locked_until IS NULL OR locked_until <= $2)
             ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
           UPDATE outbox_messages o SET attempts = o.attempts + 1, locked_until = $4 FROM due WHERE o.id = due.id
           RETURNING o.id, o.client_id, o.recipient_enc, o.body, o.attempts, o.next_attempt_at`,
          [salonId, at(now), limit, at(now + leaseMs)],
        )
      )
        .sort((a, b) => ms(a["next_attempt_at"]) - ms(b["next_attempt_at"]) || text(a["id"]).localeCompare(text(b["id"])))
        .map((r) => ({ id: text(r["id"]), clientId: asId<"ClientId">(text(r["client_id"])), recipientEnc: text(r["recipient_enc"]), body: text(r["body"]), attempts: Number(r["attempts"]) }));
    },
    async markSent(id, now) {
      requireSystem("outbox.markSent");
      await run(db, "UPDATE outbox_messages SET status = 'sent', sent_at = $3, locked_until = NULL WHERE salon_id = $1 AND id = $2", [salonId, id, at(now)]);
    },
    async markFailed(id, retryAt) {
      requireSystem("outbox.markFailed");
      if (retryAt === null) await run(db, "UPDATE outbox_messages SET status = 'dead', locked_until = NULL WHERE salon_id = $1 AND id = $2", [salonId, id]);
      else await run(db, "UPDATE outbox_messages SET next_attempt_at = $3, locked_until = NULL WHERE salon_id = $1 AND id = $2", [salonId, id, at(retryAt)]);
    },
    async deleteFor(client) {
      requireSystem("outbox.deleteFor");
      await run(db, "DELETE FROM outbox_messages WHERE salon_id = $1 AND client_id = $2", [salonId, client]);
    },
  };

  const toAudit = (r: Row): AuditEntry => ({
    id: text(r["id"]),
    clientId: r["client_id"] === null ? null : asId<"ClientId">(text(r["client_id"])),
    occurredAt: ms(r["occurred_at"]),
    messageId: r["message_id"] === null ? null : text(r["message_id"]),
    step: Number(r["step"]),
    event: text(r["event"]) as AuditEntry["event"],
    tool: r["tool"] === null ? null : text(r["tool"]),
    decision: r["decision"] === null ? null : (text(r["decision"]) as NonNullable<AuditEntry["decision"]>),
    reasons: r["reasons"] as string[],
    args: r["args"],
    outcome: r["outcome"] === null ? null : text(r["outcome"]),
  });
  const audit: AuditRepository = {
    async append(e) {
      await run(
        db,
        `INSERT INTO audit_log (id, salon_id, client_id, occurred_at, message_id, step, event, tool, decision, reasons, args, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12) ON CONFLICT (id) DO NOTHING`,
        [e.id, salonId, e.clientId, at(e.occurredAt), e.messageId, e.step, e.event, e.tool, e.decision, [...e.reasons], e.args === null || e.args === undefined ? null : JSON.stringify(e.args), e.outcome],
      );
    },
    async count(q) {
      const s = scope(6);
      const r = await rows(
        db,
        `SELECT count(*)::int AS n FROM audit_log
         WHERE event = $1 AND tool = ANY($2::text[]) AND occurred_at >= $3 AND ($4::text IS NULL OR decision = $4::text) AND ($5::text IS NULL OR outcome = $5::text) AND ${s.sql}`,
        [q.event, [...q.tools], at(q.since), q.decision ?? null, q.outcome ?? null, ...s.values],
      );
      return Number(r[0]?.["n"] ?? 0);
    },
    async recent(limit) {
      const s = scope(2);
      return (
        await rows(db, `SELECT id, client_id, occurred_at, message_id, step, event, tool, decision, reasons, args, outcome FROM audit_log WHERE ${s.sql} ORDER BY seq DESC LIMIT $1`, [limit, ...s.values])
      ).map(toAudit);
    },
  };

  const conversation: ConversationRepository = {
    async recent(limit) {
      const s = scope(2);
      return (await rows(db, `SELECT role, body FROM (SELECT id, role, body FROM conversation_turns WHERE ${s.sql} ORDER BY id DESC LIMIT $1) t ORDER BY id`, [limit, ...s.values])).map((r) => ({
        role: text(r["role"]) as "client" | "assistant",
        body: text(r["body"]),
      }));
    },
    async append(client, role, body, now) {
      requireSystem("conversation.append");
      await run(db, "INSERT INTO conversation_turns (salon_id, client_id, role, body, created_at) VALUES ($1, $2, $3, $4, $5)", [salonId, client, role, body, at(now)]);
    },
    async trim(client, keep) {
      requireSystem("conversation.trim");
      await run(
        db,
        `DELETE FROM conversation_turns WHERE salon_id = $1 AND client_id = $2
           AND id NOT IN (SELECT id FROM conversation_turns WHERE salon_id = $1 AND client_id = $2 ORDER BY id DESC LIMIT $3)`,
        [salonId, client, keep],
      );
    },
    async deleteFor(client) {
      requireSystem("conversation.deleteFor");
      await run(db, "DELETE FROM conversation_turns WHERE salon_id = $1 AND client_id = $2", [salonId, client]);
    },
  };

  const maintenance: MaintenanceRepository = {
    async purge(c: RetentionCutoffs): Promise<PurgeReport> {
      requireSystem("purge");
      return {
        conversation: await run(db, "DELETE FROM conversation_turns WHERE salon_id = $1 AND created_at < $2", [salonId, at(c.conversationBefore)]),
        outbox: await run(db, "DELETE FROM outbox_messages WHERE salon_id = $1 AND status <> 'pending' AND created_at < $2", [salonId, at(c.outboxBefore)]),
        inbox: await run(db, "DELETE FROM inbound_messages WHERE salon_id = $1 AND status = 'done' AND received_at < $2", [salonId, at(c.inboxBefore)]),
        idempotency: await run(db, "DELETE FROM idempotency_keys WHERE salon_id = $1 AND created_at < $2", [salonId, at(c.idempotencyBefore)]),
        pending: await run(db, "DELETE FROM pending_actions WHERE salon_id = $1 AND status <> 'active' AND created_at < $2", [salonId, at(c.pendingBefore)]),
        audit: await run(db, "DELETE FROM audit_log WHERE salon_id = $1 AND occurred_at < $2", [salonId, at(c.auditBefore)]),
      };
    },
  };

  return { actor, catalog, appointments, clients, pending, idempotency, inbox, outbox, audit, conversation, maintenance };
}

function toService(r: Row): Service {
  return {
    id: asId<"ServiceId">(text(r["id"])),
    salonId: asId<"SalonId">(text(r["salon_id"])) as SalonId,
    name: text(r["name"]),
    durationMinutes: Number(r["duration_minutes"]),
    bufferMinutes: Number(r["buffer_minutes"]),
    active: r["active"] === true,
  };
}

function toStaff(r: Row): StaffMember {
  return { id: asId<"StaffId">(text(r["id"])), salonId: asId<"SalonId">(text(r["salon_id"])) as SalonId, name: text(r["name"]), active: r["active"] === true };
}
