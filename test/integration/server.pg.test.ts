import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { startServer } from "../../src/composition/serve.js";
import { throwawayKeys } from "../../src/composition/compose.js";
import { signBody } from "../../src/infrastructure/http/signature.js";
import { usePostgresBackend } from "../support/pg-backend.js";
import { W } from "../support/seed.js";
import { addDays, isoWeekday } from "../../src/domain/time/civil.js";
import { formatIsoWithOffset, localDate, wallOnDate, wallStartInstant } from "../../src/domain/time/zone.js";

const backend = usePostgresBackend();
const SECRET = "integration-secret-".padEnd(40, "i");

/** 10:00 London time on the first weekday at least a week from now: inside the working hours and the booking horizon, whatever day this runs. */
function nextWorkingSlot(): string {
  let date = addDays(localDate("Europe/London", Date.now()), 7);
  while (isoWeekday(date) > 5) date = addDays(date, 1);
  return formatIsoWithOffset("Europe/London", wallStartInstant("Europe/London", wallOnDate(date, 600)));
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("the real server, wired from configuration, over PostgreSQL", () => {
  it("answers a signed webhook through an HTTP model and delivers the reply through the relay", async () => {
    // a fake chat API that proposes one booking, and a fake relay that records what it is asked to send
    const modelCalls: string[] = [];
    const model = await listen((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        modelCalls.push(raw);
        const content = JSON.stringify({ type: "tool_call", tool: "book", arguments: { service_id: W.cut, staff_id: W.staffA1, starts_at: nextWorkingSlot() } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    const sent: { to: string; text: string }[] = [];
    const relay = await listen((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        sent.push(JSON.parse(raw));
        res.writeHead(202).end();
      });
    });
    const keys = throwawayKeys();
    const lines: string[] = [];
    const running = await startServer(
      { databaseUrl: backend.appUrl, ...keys, webhookSecrets: [SECRET], channel: "chat", host: "127.0.0.1", port: 0, modelBaseUrl: model.url, modelApiKey: "k", modelName: "m", relayUrl: relay.url, relayToken: "t", defaultCountryCode: undefined, requestsPerMinute: 600, maxBodyBytes: 65_536, toleranceMs: 300_000, trustedProxyHops: 0 },
      (line) => lines.push(line),
    );
    try {
      const base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      const body = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "salon-a" }, messages: [{ id: "wamid.int.1", from: "447700900555", type: "text", text: { body: "book me" } }] } }] }],
      });
      const res = await fetch(`${base}/webhook/messages`, { method: "POST", headers: { "content-type": "application/json", "x-signature": signBody(SECRET, Date.now(), body) }, body });
      expect(await res.json()).toEqual({ received: 1, results: { processed: 1 } });
      for (let i = 0; i < 40 && sent.length === 0; i++) await sleep(250);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("+447700900555");
      expect(sent[0]?.text).toMatch(/^Book Haircut with Staff A1 on .*Reply YES to confirm/);
      expect(modelCalls).toHaveLength(1);
      expect(lines.join("\n")).not.toMatch(/7700900555|book me/);
    } finally {
      await running.stop();
      model.server.close();
      relay.server.close();
    }
  });
});
