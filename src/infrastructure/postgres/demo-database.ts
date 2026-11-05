import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.js";
import { seedWorld } from "./sample-data.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export interface DemoDatabase {
  readonly name: string;
  /** connection string of the application's own login role: what `compose` takes as `databaseUrl` */
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

function withUser(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/**
 * Creates a scratch database on a server you started for the purpose (the demo script starts a container with no network),
 * applies the migrations, loads the sample salons and creates the unprivileged login role the application uses. `serverAdminUrl`
 * is a superuser URL of that throwaway server: never give this function the address of a real database.
 */
export async function createDemoDatabase(serverAdminUrl: string): Promise<DemoDatabase> {
  const name = `demo_${randomBytes(5).toString("hex")}`;
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
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'booking_app') THEN CREATE ROLE booking_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
    await c.query(`ALTER ROLE booking_app PASSWORD '${password}'`);
    await c.query("GRANT booking_client, booking_staff, booking_system TO booking_app");
  });
  return {
    name,
    appUrl: withUser(serverAdminUrl, name, "booking_app", password),
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
      } finally {
        await s.end();
      }
    },
  };
}
