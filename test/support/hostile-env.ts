import type { Database, Tx } from "../../src/application/store.js";
import type { HostileEnvironment } from "../../src/demo/hostile.js";
import type { Actor } from "../../src/domain/actor.js";
import type { ClientId, SalonId, ServiceId, StaffId } from "../../src/domain/ids.js";
import { MemoryDatabase } from "./memory-db.js";
import { FakeClock } from "./deps.js";
import { testWorld } from "./deps.js";
import { asAdmin, type TestDatabase } from "./pg.js";
import { W } from "./seed.js";

const sample: HostileEnvironment["sample"] = {
  salonA: W.salonA as SalonId,
  salonB: W.salonB as SalonId,
  cut: W.cut as ServiceId,
  cutB: W.cutB as ServiceId,
  staffA1: W.staffA1 as StaffId,
  staffB1: W.staffB1 as StaffId,
};

/** The hostile suite over the in-memory double of the store. */
export function memoryHostileEnvironment(): HostileEnvironment {
  const world = testWorld();
  const db = world.db as MemoryDatabase;
  const clock: FakeClock = world.clock;
  return {
    deps: world.deps,
    clock,
    sample,
    async reset() {
      db.state = { clients: [], appointments: [], pending: [], idempotency: [], inbox: [], outbox: [], audit: [], conversation: [] };
    },
    async tamperPending(clientId: ClientId, args) {
      for (const p of db.state.pending) if (p.clientId === clientId && p.status === "active") p.args = { ...args };
    },
  };
}

/** The hostile suite over PostgreSQL: `database` is the test database whose application role the dependencies already use. */
export function postgresHostileEnvironment(database: TestDatabase): HostileEnvironment {
  const world = testWorld();
  return {
    deps: world.deps,
    clock: world.clock,
    sample,
    async reset() {
      await asAdmin(database, async (c) => {
        await c.query("TRUNCATE time_off, idempotency_keys, pending_actions, audit_log, outbox_messages, inbound_messages, conversation_turns, appointments, client_pii, clients");
      });
    },
    async tamperPending(clientId: ClientId, args) {
      await asAdmin(database, async (c) => {
        await c.query("UPDATE pending_actions SET args = $2::jsonb WHERE client_id = $1 AND status = 'active'", [clientId, JSON.stringify(args)]);
      });
    },
  };
}

/**
 * A deliberately broken environment for the negative control: every client transaction runs as a staff member of the salon, so
 * nothing separates one client's rows from another's. The suite must notice.
 */
export function leakyHostileEnvironment(): HostileEnvironment {
  const base = memoryHostileEnvironment();
  const inner = base.deps.db;
  const leaky: Database = {
    channels: inner.channels,
    ping: () => inner.ping(),
    transaction: <T>(actor: Actor, work: (tx: Tx) => Promise<T>) => inner.transaction(actor.kind === "client" ? { kind: "staff", salonId: actor.salonId, staffId: W.staffA1 as StaffId } : actor, work),
  };
  return { ...base, deps: { ...base.deps, db: leaky } };
}
