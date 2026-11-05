import type { Actor } from "../../src/domain/actor.js";
import { blockedUntil, isBlocking, type Appointment } from "../../src/domain/appointment.js";
import { DEFAULT_POLICY, type Salon, type Service, type StaffMember, type WorkingWindow } from "../../src/domain/catalog.js";
import { BookingError } from "../../src/domain/errors.js";
import type { AppointmentId, ClientId, SalonId, ServiceId, StaffId } from "../../src/domain/ids.js";
import { MINUTE, overlaps, type Instant, type Interval } from "../../src/domain/time/instant.js";
import type {
  AppointmentRepository,
  AuditEntry,
  AuditRepository,
  BusyRange,
  CatalogRepository,
  ChannelDirectory,
  ClientPii,
  ClientRecord,
  ClientRepository,
  ConversationRepository,
  ConversationTurn,
  Database,
  DueOutbound,
  IdempotencyRepository,
  InboxRepository,
  MaintenanceRepository,
  NewAppointment,
  NewOutbound,
  OutboxRepository,
  PendingAction,
  PendingActionRepository,
  PurgeReport,
  Reschedule,
  RetentionCutoffs,
  Tx,
} from "../../src/application/store.js";
import { W } from "./seed.js";

/** What the in-memory database starts with: the catalog of the salons. */
export interface MemorySeed {
  readonly salons: readonly Salon[];
  readonly staff: readonly StaffMember[];
  readonly services: readonly Service[];
  readonly staffServices: readonly (readonly [StaffId, ServiceId])[];
  readonly windows: Readonly<Record<string, readonly WorkingWindow[]>>;
  readonly timeOff: Readonly<Record<string, readonly Interval[]>>;
  readonly channels: readonly { channel: string; address: string; salonId: SalonId }[];
}

const weekdays = (start: number, end: number): WorkingWindow[] => [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: start, endMinute: end }));

/** The same world the PostgreSQL tests seed: salon A (London) with two staff members, salon B (Riyadh) with one. */
export function standardSeed(): MemorySeed {
  const a = W.salonA as SalonId;
  const b = W.salonB as SalonId;
  return {
    salons: [
      { id: a, name: "Salon A", timeZone: "Europe/London", defaultLanguage: "en", policy: DEFAULT_POLICY },
      { id: b, name: "Salon B", timeZone: "Asia/Riyadh", defaultLanguage: "ar", policy: DEFAULT_POLICY },
    ],
    staff: [
      { id: W.staffA1 as StaffId, salonId: a, name: "Staff A1", active: true },
      { id: W.staffA2 as StaffId, salonId: a, name: "Staff A2", active: true },
      { id: W.staffB1 as StaffId, salonId: b, name: "Staff B1", active: true },
    ],
    services: [
      { id: W.cut as ServiceId, salonId: a, name: "Haircut", durationMinutes: 30, bufferMinutes: 10, active: true },
      { id: W.color as ServiceId, salonId: a, name: "Colour", durationMinutes: 90, bufferMinutes: 15, active: true },
      { id: W.cutB as ServiceId, salonId: b, name: "Haircut", durationMinutes: 30, bufferMinutes: 0, active: true },
    ],
    staffServices: [
      [W.staffA1 as StaffId, W.cut as ServiceId],
      [W.staffA1 as StaffId, W.color as ServiceId],
      [W.staffA2 as StaffId, W.cut as ServiceId],
      [W.staffB1 as StaffId, W.cutB as ServiceId],
    ],
    windows: { [W.staffA1]: weekdays(540, 1020), [W.staffA2]: weekdays(540, 1020), [W.staffB1]: weekdays(540, 1020) },
    timeOff: {},
    channels: [
      { channel: "chat", address: "salon-a", salonId: a },
      { channel: "chat", address: "salon-b", salonId: b },
    ],
  };
}

interface ClientRow {
  id: ClientId;
  salonId: SalonId;
  status: "active" | "erased";
  createdAt: Instant;
  erasedAt: Instant | null;
  phoneKey: string | null;
  phoneEnc: string | null;
  nameEnc: string | null;
}
type AppointmentRow = Appointment;
interface PendingRow {
  id: string;
  salonId: SalonId;
  clientId: ClientId;
  tool: PendingAction["tool"];
  args: Record<string, unknown>;
  argsDigest: string;
  holdAppointmentId: AppointmentId | null;
  status: "active" | "confirmed" | "declined" | "superseded" | "expired";
  createdAt: Instant;
  expiresAt: Instant;
}
interface IdemRow {
  salonId: SalonId;
  actorId: string;
  key: string;
  digest: string;
  response: unknown;
  createdAt: Instant;
}
interface InboxRow {
  salonId: SalonId;
  channel: string;
  messageId: string;
  status: "processing" | "done";
  attempts: number;
  leaseUntil: Instant;
  receivedAt: Instant;
}
interface OutboxRow {
  id: string;
  salonId: SalonId;
  clientId: ClientId;
  dedupeKey: string;
  recipientEnc: string;
  body: string;
  status: "pending" | "sent" | "dead";
  attempts: number;
  nextAttemptAt: Instant;
  lockedUntil: Instant | null;
  createdAt: Instant;
  sentAt: Instant | null;
}
type AuditRow = AuditEntry & { salonId: SalonId };
interface TurnRow {
  salonId: SalonId;
  clientId: ClientId;
  role: ConversationTurn["role"];
  body: string;
  createdAt: Instant;
}

export interface MemoryState {
  clients: ClientRow[];
  appointments: AppointmentRow[];
  pending: PendingRow[];
  idempotency: IdemRow[];
  inbox: InboxRow[];
  outbox: OutboxRow[];
  audit: AuditRow[];
  conversation: TurnRow[];
}

function denied(what: string): Error {
  return new Error(`permission denied: ${what}`);
}

/**
 * An in-memory implementation of the persistence ports for the fast tests of the use cases. It keeps the rules that the
 * real database enforces and the use cases rely on: scoping by tenant and client, the two overlap constraints, the unique
 * keys and the system-only operations. A transaction is serialised with the others and rolled back when it throws. The
 * contract tests run the same scenarios against this class and against PostgreSQL.
 */
export class MemoryDatabase implements Database {
  readonly channels: ChannelDirectory;
  state: MemoryState = { clients: [], appointments: [], pending: [], idempotency: [], inbox: [], outbox: [], audit: [], conversation: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private readonly seed: MemorySeed & { timeOff: Record<string, readonly Interval[]> };

  constructor(seed: MemorySeed = standardSeed()) {
    this.seed = { ...seed, timeOff: { ...seed.timeOff } };
    this.channels = {
      salonFor: async (channel, address) => seed.channels.find((c) => c.channel === channel && c.address === address)?.salonId,
      salonsWithChannels: async () => [...new Set(seed.channels.map((c) => c.salonId))],
    };
  }

  /** Marks a staff member as away for a stretch of time. */
  addTimeOff(staffId: string, interval: Interval): void {
    this.seed.timeOff[staffId] = [...(this.seed.timeOff[staffId] ?? []), interval];
  }

  async ping(): Promise<void> {}

  transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const before = structuredClone(this.state);
      try {
        return await work(this.tx(actor));
      } catch (error) {
        this.state = before;
        throw error;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private tx(actor: Actor): Tx {
    const db = this;
    const seed = this.seed;
    const salonId = actor.salonId;
    const own = <R extends { salonId: SalonId; clientId: ClientId | null }>(row: R): boolean =>
      row.salonId === salonId && (actor.kind !== "client" || row.clientId === actor.clientId);
    const requireSystem = (what: string): void => {
      if (actor.kind !== "system") throw denied(what);
    };
    const requireClient = (what: string): ClientId => {
      if (actor.kind !== "client") throw denied(what);
      return actor.clientId;
    };
    const actorId = (): string => (actor.kind === "client" ? actor.clientId : actor.kind === "staff" ? actor.staffId : actor.salonId);

    const conflict = (row: { id: string; staffId: StaffId; clientId: ClientId; startsAt: Instant; endsAt: Instant; blockedUntil: Instant }): void => {
      for (const other of db.state.appointments) {
        if (other.id === row.id || other.salonId !== salonId || !isBlocking(other.status)) continue;
        if (other.staffId === row.staffId && overlaps({ start: other.startsAt, end: other.blockedUntil }, { start: row.startsAt, end: row.blockedUntil })) throw new BookingError("slot_unavailable");
      }
      for (const other of db.state.appointments) {
        if (other.id === row.id || other.salonId !== salonId || !isBlocking(other.status)) continue;
        if (other.clientId === row.clientId && overlaps({ start: other.startsAt, end: other.endsAt }, { start: row.startsAt, end: row.endsAt })) throw new BookingError("client_overlap");
      }
    };
    const strip = (row: AppointmentRow): Appointment => ({ ...row });
    const visible = (): AppointmentRow[] => db.state.appointments.filter((a) => own({ salonId: a.salonId, clientId: a.clientId }));
    const find = (id: AppointmentId): AppointmentRow | undefined => visible().find((a) => a.id === id);

    const catalog: CatalogRepository = {
      getSalon: async () => seed.salons.find((s) => s.id === salonId),
      listServices: async () => seed.services.filter((s) => s.salonId === salonId && s.active),
      getService: async (id) => seed.services.find((s) => s.salonId === salonId && s.id === id),
      getStaff: async (id) => seed.staff.find((s) => s.salonId === salonId && s.id === id),
      listStaffFor: async (serviceId) =>
        seed.staff.filter((s) => s.salonId === salonId && s.active && seed.staffServices.some(([staff, service]) => staff === s.id && service === serviceId)),
      workingWindows: async (staffId) => {
        if (actor.kind === "client") throw denied("working_hours");
        return [...(seed.windows[staffId] ?? [])];
      },
      timeOff: async (staffId, range) => {
        if (actor.kind === "client") throw denied("time_off");
        return (seed.timeOff[staffId] ?? []).filter((t) => overlaps(t, range));
      },
    };

    const appointments: AppointmentRepository = {
      async insert(a: NewAppointment) {
        if (actor.kind === "system") throw denied("appointments insert");
        if (actor.kind === "client" && a.clientId !== actor.clientId) throw denied("row-level security");
        const row: AppointmentRow = {
          id: a.id,
          salonId,
          staffId: a.staffId,
          clientId: a.clientId,
          serviceId: a.serviceId,
          status: a.status,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          bufferMinutes: a.bufferMinutes,
          blockedUntil: blockedUntil(a.endsAt, a.bufferMinutes),
          holdExpiresAt: a.holdExpiresAt,
          notes: a.notes,
          version: 1,
          createdAt: a.now,
          updatedAt: a.now,
          cancelledAt: null,
        };
        conflict(row);
        db.state.appointments.push(row);
        return strip(row);
      },
      find: async (id) => {
        const row = find(id);
        return row ? strip(row) : undefined;
      },
      lock: async (id) => {
        const row = find(id);
        return row ? strip(row) : undefined;
      },
      upcoming: async (now, limit) =>
        visible()
          .filter((a) => isBlocking(a.status) && a.endsAt > now && (a.status !== "held" || (a.holdExpiresAt ?? 0) > now))
          .sort((x, y) => x.startsAt - y.startsAt)
          .slice(0, limit)
          .map(strip),
      async reschedule(id, change: Reschedule) {
        const row = find(id);
        if (!row) throw new Error("no such appointment");
        const next = { ...row, staffId: change.staffId, startsAt: change.startsAt, endsAt: change.endsAt, bufferMinutes: change.bufferMinutes, blockedUntil: blockedUntil(change.endsAt, change.bufferMinutes) };
        conflict(next);
        Object.assign(row, next, { version: row.version + 1, updatedAt: change.now });
        return strip(row);
      },
      async setStatus(id, status, now) {
        const row = find(id);
        if (!row) throw new Error("no such appointment");
        const allowed = (row.status === "held" && (status === "booked" || status === "cancelled")) || (row.status === "booked" && status === "cancelled");
        if (!allowed) throw new Error("appointment status cannot change");
        Object.assign(row, { status, holdExpiresAt: status === "booked" ? null : row.holdExpiresAt, cancelledAt: status === "cancelled" ? now : null, version: row.version + 1, updatedAt: now });
        return strip(row);
      },
      async busy(staffIds, range, now, excluding): Promise<BusyRange[]> {
        requireSystem("busy");
        return db.state.appointments
          .filter((a) => a.salonId === salonId && staffIds.includes(a.staffId) && a.id !== excluding && isBlocking(a.status) && (a.status !== "held" || (a.holdExpiresAt ?? 0) > now))
          .filter((a) => overlaps({ start: a.startsAt, end: a.blockedUntil }, range))
          .map((a) => ({ staffId: a.staffId, start: a.startsAt, end: a.blockedUntil }));
      },
      async releaseExpiredHolds(now) {
        requireSystem("releaseExpiredHolds");
        let n = 0;
        for (const a of db.state.appointments) {
          if (a.salonId === salonId && a.status === "held" && (a.holdExpiresAt ?? 0) <= now) {
            Object.assign(a, { status: "expired", version: a.version + 1, updatedAt: now });
            n++;
          }
        }
        return n;
      },
      async cancelFuture(clientId, now) {
        requireSystem("cancelFuture");
        let n = 0;
        for (const a of db.state.appointments) {
          if (a.salonId === salonId && a.clientId === clientId && isBlocking(a.status) && a.startsAt > now) {
            Object.assign(a, { status: "cancelled", cancelledAt: now, version: a.version + 1, updatedAt: now });
            n++;
          }
        }
        return n;
      },
      async scrubNotes(clientId) {
        requireSystem("scrubNotes");
        let n = 0;
        for (const a of db.state.appointments) {
          if (a.salonId === salonId && a.clientId === clientId && a.notes !== null) {
            Object.assign(a, { notes: null });
            n++;
          }
        }
        return n;
      },
    };

    const clientRow = (id: ClientId): ClientRow | undefined => db.state.clients.find((c) => c.salonId === salonId && c.id === id && (actor.kind !== "client" || c.id === actor.clientId));
    const clients: ClientRepository = {
      async findByPhoneKey(phoneKey) {
        requireSystem("findByPhoneKey");
        return db.state.clients.find((c) => c.salonId === salonId && c.phoneKey === phoneKey)?.id;
      },
      async upsertByPhoneKey(input) {
        requireSystem("upsertByPhoneKey");
        const existing = db.state.clients.find((c) => c.salonId === salonId && c.phoneKey === input.phoneKey);
        if (existing) return { id: existing.id, created: false };
        db.state.clients.push({ id: input.id, salonId, status: "active", createdAt: input.now, erasedAt: null, phoneKey: input.phoneKey, phoneEnc: input.phoneEnc, nameEnc: input.nameEnc });
        return { id: input.id, created: true };
      },
      async get(id): Promise<ClientRecord | undefined> {
        const row = clientRow(id);
        return row ? { id: row.id, status: row.status, createdAt: row.createdAt } : undefined;
      },
      async getPii(id): Promise<ClientPii | undefined> {
        const row = clientRow(id);
        return row?.phoneEnc ? { phoneEnc: row.phoneEnc, nameEnc: row.nameEnc } : undefined;
      },
      async erase(id, now) {
        requireSystem("erase");
        const row = clientRow(id);
        if (row) Object.assign(row, { status: "erased", erasedAt: now, phoneKey: null, phoneEnc: null, nameEnc: null });
      },
    };

    const pending: PendingActionRepository = {
      async create(action) {
        const clientId = requireClient("pending create");
        for (const p of db.state.pending) if (p.clientId === clientId && p.status === "active") p.status = "superseded";
        db.state.pending.push({ ...action, salonId, status: "active", args: { ...action.args } });
      },
      async findActive(now) {
        const clientId = requireClient("pending find");
        const row = db.state.pending.find((p) => p.salonId === salonId && p.clientId === clientId && p.status === "active" && p.expiresAt > now);
        if (!row) return undefined;
        const { salonId: _s, status: _st, ...rest } = row;
        return rest;
      },
      async resolveActive(status, now) {
        const clientId = requireClient("pending resolve");
        const done: PendingAction[] = [];
        for (const p of db.state.pending) {
          if (p.salonId === salonId && p.clientId === clientId && p.status === "active") {
            p.status = status;
            const { salonId: _s, status: _st, ...rest } = p;
            done.push(rest);
          }
        }
        void now;
        return done;
      },
      async deleteFor(clientId) {
        requireSystem("pending deleteFor");
        db.state.pending = db.state.pending.filter((p) => !(p.salonId === salonId && p.clientId === clientId));
      },
    };

    const idempotency: IdempotencyRepository = {
      async lock() {},
      async find(key) {
        const row = db.state.idempotency.find((r) => r.salonId === salonId && r.actorId === actorId() && r.key === key);
        return row ? { requestDigest: row.digest, response: row.response } : undefined;
      },
      async store(key, digest, response, now) {
        db.state.idempotency.push({ salonId, actorId: actorId(), key, digest, response: JSON.parse(JSON.stringify(response)), createdAt: now });
      },
      async deleteFor(clientId) {
        requireSystem("idempotency deleteFor");
        db.state.idempotency = db.state.idempotency.filter((r) => !(r.salonId === salonId && r.actorId === clientId));
      },
    };

    const inbox: InboxRepository = {
      async claim(channel, messageId, now, leaseMs) {
        requireSystem("inbox claim");
        const row = db.state.inbox.find((r) => r.salonId === salonId && r.channel === channel && r.messageId === messageId);
        if (!row) {
          db.state.inbox.push({ salonId, channel, messageId, status: "processing", attempts: 1, leaseUntil: now + leaseMs, receivedAt: now });
          return true;
        }
        if (row.status === "processing" && row.leaseUntil <= now) {
          Object.assign(row, { attempts: row.attempts + 1, leaseUntil: now + leaseMs });
          return true;
        }
        return false;
      },
      async complete(channel, messageId) {
        requireSystem("inbox complete");
        const row = db.state.inbox.find((r) => r.salonId === salonId && r.channel === channel && r.messageId === messageId);
        if (row) row.status = "done";
      },
      async release(channel, messageId, now) {
        requireSystem("inbox release");
        const row = db.state.inbox.find((r) => r.salonId === salonId && r.channel === channel && r.messageId === messageId && r.status === "processing");
        if (row) row.leaseUntil = now;
      },
    };

    const outbox: OutboxRepository = {
      async enqueue(m: NewOutbound) {
        requireSystem("outbox enqueue");
        if (db.state.outbox.some((r) => r.salonId === salonId && r.dedupeKey === m.dedupeKey)) return false;
        db.state.outbox.push({ id: m.id, salonId, clientId: m.clientId, dedupeKey: m.dedupeKey, recipientEnc: m.recipientEnc, body: m.body, status: "pending", attempts: 0, nextAttemptAt: m.now, lockedUntil: null, createdAt: m.now, sentAt: null });
        return true;
      },
      async claimDue(now, limit, leaseMs): Promise<DueOutbound[]> {
        requireSystem("outbox claimDue");
        const due = db.state.outbox
          .filter((r) => r.salonId === salonId && r.status === "pending" && r.nextAttemptAt <= now && (r.lockedUntil === null || r.lockedUntil <= now))
          .sort((x, y) => x.nextAttemptAt - y.nextAttemptAt)
          .slice(0, limit);
        for (const r of due) Object.assign(r, { attempts: r.attempts + 1, lockedUntil: now + leaseMs });
        return due.map((r) => ({ id: r.id, clientId: r.clientId, recipientEnc: r.recipientEnc, body: r.body, attempts: r.attempts }));
      },
      async markSent(id, now) {
        requireSystem("outbox markSent");
        const row = db.state.outbox.find((r) => r.salonId === salonId && r.id === id);
        if (row) Object.assign(row, { status: "sent", sentAt: now, lockedUntil: null });
      },
      async markFailed(id, retryAt) {
        requireSystem("outbox markFailed");
        const row = db.state.outbox.find((r) => r.salonId === salonId && r.id === id);
        if (!row) return;
        if (retryAt === null) Object.assign(row, { status: "dead", lockedUntil: null });
        else Object.assign(row, { nextAttemptAt: retryAt, lockedUntil: null });
      },
      async deleteFor(clientId) {
        requireSystem("outbox deleteFor");
        db.state.outbox = db.state.outbox.filter((r) => !(r.salonId === salonId && r.clientId === clientId));
      },
    };

    const audit: AuditRepository = {
      async append(entry) {
        if (actor.kind === "client" && entry.clientId !== actor.clientId) throw denied("row-level security");
        db.state.audit.push({ ...entry, salonId, args: JSON.parse(JSON.stringify(entry.args ?? null)) });
      },
      async countExecuted(tools, since) {
        return db.state.audit.filter((e) => own({ salonId: e.salonId, clientId: e.clientId }) && e.event === "tool_executed" && e.outcome === "ok" && e.tool !== null && tools.includes(e.tool) && e.occurredAt >= since).length;
      },
      async recent(limit) {
        return db.state.audit
          .filter((e) => own({ salonId: e.salonId, clientId: e.clientId }))
          .slice()
          .reverse()
          .slice(0, limit)
          .map(({ salonId: _s, ...rest }) => rest);
      },
    };

    const conversation: ConversationRepository = {
      async recent(limit) {
        return db.state.conversation
          .filter((t) => own({ salonId: t.salonId, clientId: t.clientId }))
          .slice(-limit)
          .map((t) => ({ role: t.role, body: t.body }));
      },
      async append(clientId, role, body, now) {
        requireSystem("conversation append");
        db.state.conversation.push({ salonId, clientId, role, body, createdAt: now });
      },
      async trim(clientId, keep) {
        requireSystem("conversation trim");
        const mine = db.state.conversation.filter((t) => t.salonId === salonId && t.clientId === clientId);
        const drop = new Set(mine.slice(0, Math.max(0, mine.length - keep)));
        db.state.conversation = db.state.conversation.filter((t) => !drop.has(t));
      },
      async deleteFor(clientId) {
        requireSystem("conversation deleteFor");
        db.state.conversation = db.state.conversation.filter((t) => !(t.salonId === salonId && t.clientId === clientId));
      },
    };

    const maintenance: MaintenanceRepository = {
      async purge(c: RetentionCutoffs): Promise<PurgeReport> {
        requireSystem("purge");
        const drop = <T>(rows: T[], doomed: (row: T) => boolean): [T[], number] => {
          const kept = rows.filter((r) => !doomed(r));
          return [kept, rows.length - kept.length];
        };
        const inSalon = <T extends { salonId: SalonId }>(r: T): boolean => r.salonId === salonId;
        const [conversationRows, conversationN] = drop(db.state.conversation, (r) => inSalon(r) && r.createdAt < c.conversationBefore);
        const [outboxRows, outboxN] = drop(db.state.outbox, (r) => inSalon(r) && r.status !== "pending" && r.createdAt < c.outboxBefore);
        const [inboxRows, inboxN] = drop(db.state.inbox, (r) => inSalon(r) && r.status === "done" && r.receivedAt < c.inboxBefore);
        const [idemRows, idemN] = drop(db.state.idempotency, (r) => inSalon(r) && r.createdAt < c.idempotencyBefore);
        const [pendingRows, pendingN] = drop(db.state.pending, (r) => inSalon(r) && r.status !== "active" && r.createdAt < c.pendingBefore);
        const [auditRows, auditN] = drop(db.state.audit, (r) => inSalon(r) && r.occurredAt < c.auditBefore);
        Object.assign(db.state, { conversation: conversationRows, outbox: outboxRows, inbox: inboxRows, idempotency: idemRows, pending: pendingRows, audit: auditRows });
        return { conversation: conversationN, outbox: outboxN, inbox: inboxN, idempotency: idemN, pending: pendingN, audit: auditN };
      },
    };

    return { actor, catalog, appointments, clients, pending, idempotency, inbox, outbox, audit, conversation, maintenance };
  }
}

export const minutes = (n: number): number => n * MINUTE;
