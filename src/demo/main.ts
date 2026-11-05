import { ScriptedModel, toolJson } from "../application/assistant/fake-model.js";
import { createRuntime, receiveMessage } from "../application/assistant/inbound.js";
import { book, cancelAppointment, moveAppointment } from "../application/booking.js";
import { resolveClient } from "../application/clients.js";
import { RecordingChannel } from "../application/fakes.js";
import { dispatchAll } from "../application/messaging.js";
import type { Outcome } from "../application/outcome.js";
import type { Deps } from "../application/ports.js";
import type { ClientActor } from "../domain/actor.js";
import type { ClientId, SalonId, ServiceId, StaffId } from "../domain/ids.js";
import { normalizePhone } from "../domain/phone.js";
import {
  compose,
  createDemoDatabase,
  createWebhookServer,
  ManualClock,
  SAMPLE_IDS,
  signBody,
  throwawayKeys,
  type DemoDatabase,
} from "../composition/compose.js";
import { runHostileSuite } from "./hostile.js";
import { RaceGate } from "./race.js";

const NOW = Date.UTC(2026, 10, 9, 9, 0);
const ATTEMPTS = 50;
const SALON = SAMPLE_IDS.salonA as SalonId;
const CUT = SAMPLE_IDS.cut as ServiceId;
const STAFF = SAMPLE_IDS.staffA1 as StaffId;
const SLOT = Date.UTC(2026, 10, 10, 10, 0);

const tally = (results: readonly Outcome<unknown>[]): string => {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.ok ? "booked" : r.error.code, (counts.get(r.ok ? "booked" : r.error.code) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}=${n}`).join(" ");
};

async function clients(deps: Deps, count: number): Promise<ClientActor[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const phone = normalizePhone(`+44 7700 91${String(i).padStart(4, "0")}`);
      if (!phone) throw new Error("bad demo number");
      return (await resolveClient(deps, SALON, phone, undefined)).actor;
    }),
  );
}

async function raceOnce(demo: DemoDatabase, out: (line: string) => void, label: string): Promise<number> {
  const keys = throwawayKeys();
  const app = compose({ databaseUrl: demo.appUrl, ...keys, poolMax: 60, write: () => undefined });
  try {
    const deps: Deps = { ...app.deps, clock: new ManualClock(NOW) };
    const people = await clients(deps, ATTEMPTS);
    const raced: Deps = { ...deps, db: new RaceGate(deps.db, ATTEMPTS) };
    const results = await Promise.all(people.map((c) => book(raced, c, { serviceId: CUT, staffId: STAFF, startsAt: SLOT })));
    const rows = await demo.countAppointments("booked");
    out(`  ${label.padEnd(34)} ${tally(results).padEnd(34)} rows booked in the database: ${rows}`);
    return rows;
  } finally {
    await app.close();
  }
}

/** Runs the whole demonstration against a throwaway server and returns the process exit code: 0 when every claim held. */
export async function runDemo(serverAdminUrl: string, out: (line: string) => void): Promise<number> {
  const main = await createDemoDatabase(serverAdminUrl);
  const control = await createDemoDatabase(serverAdminUrl);
  let failures = 0;
  const app = compose({ databaseUrl: main.appUrl, ...throwawayKeys(), poolMax: 20, write: () => undefined });
  try {
    out("booking-assistant-core demo");
    out(`database: PostgreSQL ${main.serverVersion}, a throwaway server with no network; model: scripted, no hosted model is called`);
    out("");
    out(`1. ${ATTEMPTS} clients book the same slot at the same moment (every attempt has already seen the slot free)`);
    const rows = await raceOnce(main, out, "with the exclusion constraints");
    await control.dropExclusionConstraints();
    const controlRows = await raceOnce(control, out, "control: constraints dropped");
    if (rows !== 1) failures++;
    if (controlRows !== ATTEMPTS) failures++;
    out(`  -> exactly one booking survives; the control shows the race is real: without the constraint all ${ATTEMPTS} were booked.`);
    out("");

    out("2. a move races a cancel of the same appointment, 30 times");
    const deps: Deps = { ...app.deps, clock: new ManualClock(NOW) };
    await main.reset();
    const [me] = await clients(deps, 1);
    const outcomes = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const made = await book(deps, me as ClientActor, { serviceId: CUT, staffId: STAFF, startsAt: Date.UTC(2026, 10, 12 + (i % 2), i < 15 ? 10 : 14, 0) });
      if (!made.ok) throw new Error(`demo setup failed: ${made.error.code}`);
      const [moved, cancelled] = await Promise.all([
        moveAppointment(deps, me as ClientActor, { appointmentId: made.value.id, startsAt: Date.UTC(2026, 10, 16, 9 + (i % 7), 0) }),
        cancelAppointment(deps, me as ClientActor, { appointmentId: made.value.id }),
      ]);
      const key = moved.ok ? "moved, then cancelled" : `cancel first, move refused (${moved.error.code})`;
      outcomes.set(cancelled.ok ? key : "cancel failed", (outcomes.get(cancelled.ok ? key : "cancel failed") ?? 0) + 1);
      if (!cancelled.ok || (await main.countAppointments("booked")) !== 0) failures++;
      await main.clearAppointments();
    }
    for (const [k, n] of outcomes) out(`  ${String(n).padStart(2)} x ${k}`);
    out("  -> in every run the appointment ends cancelled and nothing is left booked.");
    out("");

    out("3. hostile conversations (a compromised model plus an attacker; the rules are in code, not in the prompt)");
    const clock = new ManualClock(NOW);
    const results = await runHostileSuite({
      deps: { ...app.deps, clock },
      clock,
      reset: () => main.reset(),
      tamperPending: async (clientId: ClientId, args) => main.tamperPending(clientId, args),
      sample: { salonA: SALON, salonB: SAMPLE_IDS.salonB as SalonId, cut: CUT, cutB: SAMPLE_IDS.cutB as ServiceId, staffA1: STAFF, staffB1: SAMPLE_IDS.staffB1 as StaffId },
    });
    for (const r of results) {
      out(`  ${r.held ? "HELD  " : "BROKEN"} ${r.id}: ${r.attack}`);
      for (const e of r.evidence) out(`           + ${e}`);
      for (const f of r.failures) out(`           ! ${f}`);
      if (!r.held) failures++;
    }
    out(`  -> ${results.filter((r) => r.held).length} of ${results.length} scenarios held`);
    out("");

    out("4. the webhook, end to end on loopback: signature, replay, size limit, delivered reply");
    await main.reset();
    const secret = "demo-webhook-secret-".padEnd(40, "d");
    const channel = new RecordingChannel();
    const model = new ScriptedModel([toolJson("book", { service_id: CUT, staff_id: STAFF, starts_at: "2026-11-10T10:00:00+00:00" })]);
    const runtime = createRuntime(model);
    const webhookClock = new ManualClock(NOW);
    const server = createWebhookServer({
      secrets: [secret],
      channel: "chat",
      handler: { receive: (m) => receiveMessage({ ...app.deps, clock: webhookClock }, runtime, m), ready: () => app.deps.db.ping() },
      clock: webhookClock,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const { promise: listening, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await listening;
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "salon-a" }, contacts: [{ wa_id: "447700900123", profile: { name: "Demo Client" } }], messages: [{ id: "wamid.demo.1", from: "447700900123", timestamp: "1", type: "text", text: { body: "Book me a haircut on Tuesday at 10" } }] } }] }],
    });
    const post = async (label: string, payload: string, signature: string): Promise<void> => {
      const res = await fetch(`${base}/webhook/messages`, { method: "POST", headers: { "content-type": "application/json", "x-signature": signature }, body: payload });
      out(`  ${label.padEnd(42)} -> HTTP ${res.status} ${await res.text()}`);
    };
    await post("signed message", body, signBody(secret, NOW, body));
    await post("the same message delivered again", body, signBody(secret, NOW, body));
    await post("wrong signature", body, signBody("not-the-secret".padEnd(32, "n"), NOW, body));
    await post("signature from ten minutes ago", body, signBody(secret, NOW - 600_000, body));
    const big = "x".repeat(70_000);
    await post("70 KB body", big, signBody(secret, NOW, big));
    await dispatchAll({ ...app.deps, clock: webhookClock }, channel);
    out(`  reply that was delivered (once): ${JSON.stringify(channel.sent.map((m) => m.text))}`);
    if (channel.sent.length !== 1) failures++;
    await new Promise<void>((done) => server.close(() => done()));
    out("");
    out(failures === 0 ? "RESULT: every claim held." : `RESULT: ${failures} claim(s) did not hold.`);
  } finally {
    await app.close();
    await main.drop();
    await control.drop();
  }
  return failures === 0 ? 0 : 1;
}
