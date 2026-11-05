import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.js";
import { seedWorld } from "./sample-data.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export interface DemoDatabase {
  readonly name: string;
  /** connection string of a login role made for this run alone: what `compose` takes as `databaseUrl` */
  readonly appUrl: string;
  readonly serverVersion: string;
  /** empties every table the application writes to; keeps the sample salons */
  reset(): Promise<void>;
  /** rewrites the arguments of a client's active proposal behind the application's back */
  tamperPending(clientId: string, args: Readonly<Record<string, unknown>>): Promise<void>;
  /** drops the two overlap constraints: the control of the concurrency proof */
  dropExclusionConstraints(): Promise<void>;
  /** deletes every appointment and keeps the clients */
  clearAppointments(): Promise<void>;
  countAppointments(status: string): Promise<number>;
  drop(): Promise<void>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The demo creates databases and roles and runs the migrations (which create the cluster-wide application roles) with a superuser
 * connection. It therefore only talks to a server on this machine: a loopback address or a unix socket directory. The scripts
 * start a throwaway container whose network is the demo's own; there is no switch to point it elsewhere.
 */
export function assertThrowawayServer(serverAdminUrl: string): void {
  let url: URL;
  try {
    url = new URL(serverAdminUrl);
  } catch {
    throw new Error("the demo server URL is not a valid URL");
  }
  const socket = url.searchParams.get("host");
  const local = LOOPBACK.has(url.hostname) || (url.hostname === "" && socket !== null && socket.startsWith("/")) || (socket !== null && socket.startsWith("/") && url.hostname === "");
  if (!local) throw new Error("the demo only runs against a server on loopback or a unix socket: it creates roles and databases as a superuser");
}

function withUser(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/**
 * Creates a scratch database on a throwaway server, applies the migrations, loads the sample salons and creates a login role
 * with a name made for this run (never an existing role: nothing here alters a role that was there before). `drop` removes the
 * database and the role.
 */
export async function createDemoDatabase(serverAdminUrl: string): Promise<DemoDatabase> {
  assertThrowawayServer(serverAdminUrl);
  const suffix = randomBytes(5).toString("hex");
  const name = `demo_${suffix}`;
  const role = `booking_demo_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const server = new pg.Client({ connectionString: serverAdminUrl });
  await server.connect();
  let serverVersion = "unknown";
  try {
    await server.query(`CREATE DATABASE ${name}`);
    serverVersion = String((await server.query("SHOW server_version")).rows[0]?.server_version ?? "unknown");
  } finally {
    await server.end();
  }
  const adminUrl = withUser(serverAdminUrl, name);
  await migrate(adminUrl, MIGRATIONS_DIR);
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  await admin(async (c) => {
    await seedWorld(c);
    await c.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
    await c.query(`GRANT booking_client, booking_staff, booking_system TO ${role}`);
  });
  return {
    name,
    appUrl: withUser(serverAdminUrl, name, role, password),
    serverVersion,
    reset: () =>
      admin(async (c) => {
        await c.query("TRUNCATE time_off, idempotency_keys, pending_actions, audit_log, outbox_messages, inbound_messages, conversation_turns, appointments, client_pii, clients");
      }),
    tamperPending: (clientId, args) =>
      admin(async (c) => {
        await c.query("UPDATE pending_actions SET args = $2::jsonb WHERE client_id = $1 AND status = 'active'", [clientId, JSON.stringify(args)]);
      }),
    dropExclusionConstraints: () =>
      admin(async (c) => {
        await c.query("ALTER TABLE appointments DROP CONSTRAINT appointments_staff_no_overlap, DROP CONSTRAINT appointments_client_no_overlap");
      }),
    clearAppointments: () =>
      admin(async (c) => {
        await c.query("DELETE FROM appointments");
      }),
    countAppointments: (status) => admin(async (c) => Number((await c.query("SELECT count(*)::int AS n FROM appointments WHERE status = $1", [status])).rows[0]?.n)),
    async drop() {
      const s = new pg.Client({ connectionString: serverAdminUrl });
      await s.connect();
      try {
        await s.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await s.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await s.end();
      }
    },
  };
}
