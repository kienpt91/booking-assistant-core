// Tests written before the fixes they cover (the independent review of 2026-11): each one failed on the code it was written against.
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readServeConfig } from "../../src/composition/config.js";
import { normalizePhone } from "../../src/domain/phone.js";
import { createDemoDatabase } from "../../src/infrastructure/postgres/demo-database.js";
import { createWebhookServer, type WebhookServerOptions } from "../../src/infrastructure/http/server.js";
import { signBody } from "../../src/infrastructure/http/signature.js";
import { HttpChatModel } from "../../src/infrastructure/model/http-chat-model.js";
import { ManualClock } from "../../src/infrastructure/system.js";

const SECRET = "hardening-secret-".padEnd(40, "h");
const NOW = Date.UTC(2026, 10, 9, 9, 0);
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [] }] });

describe("webhook limits (review finding: the shared pre-authentication bucket)", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  });
  async function start(over: Partial<WebhookServerOptions> = {}) {
    const clock = new ManualClock(NOW);
    const logs: string[] = [];
    const server = createWebhookServer({
      secrets: [SECRET],
      channel: "chat",
      handler: { receive: async () => ({ status: "processed" }), ready: async () => undefined },
      clock,
      logger: { info: () => undefined, warn: (e: string) => logs.push(e), error: () => undefined },
      ...over,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (headers: Record<string, string> = {}, payload = body) =>
      fetch(`${base}/webhook/messages`, { method: "POST", body: payload, headers: { "content-type": "application/json", "x-signature": signBody(SECRET, NOW, payload), ...headers } });
    return { post, clock, logs };
  }

  it("a flood of unsigned requests from the same address does not stop the signed relay", async () => {
    const s = await start();
    let lastGarbage = 0;
    for (let i = 0; i < 200; i++) lastGarbage = (await s.post({ "x-signature": "t=1,v1=" + "0".repeat(64) })).status;
    expect(lastGarbage).toBe(429); // the failures are counted and answered with 429 ...
    expect((await s.post()).status).toBe(200); // ... but a valid signature always gets through
    expect(s.logs.filter((l) => l === "http.signature_refused").length).toBeLessThanOrEqual(30); // and the log does not flood
  });

  it("limits authenticated requests per sender address, with a configurable limit", async () => {
    const s = await start({ requestsPerMinute: 2 });
    expect([(await s.post()).status, (await s.post()).status, (await s.post()).status]).toEqual([200, 200, 429]);
    s.clock.advance(61_000);
    expect((await s.post()).status).toBe(200);
  });

  it("ignores X-Forwarded-For unless a trusted proxy is configured, and uses the entry the proxy added when one is", async () => {
    const plain = await start({ requestsPerMinute: 1 });
    expect((await plain.post({ "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    expect((await plain.post({ "x-forwarded-for": "198.51.100.2" })).status).toBe(429); // a spoofed header buys nothing
    const proxied = await start({ requestsPerMinute: 1, trustedProxyHops: 1 });
    expect((await proxied.post({ "x-forwarded-for": "203.0.113.9, 198.51.100.1" })).status).toBe(200);
    expect((await proxied.post({ "x-forwarded-for": "203.0.113.9, 198.51.100.2" })).status).toBe(200); // another sender behind the proxy
    expect((await proxied.post({ "x-forwarded-for": "evil, 198.51.100.1" })).status).toBe(429); // the part the client wrote does not count
  });

  it("takes the body limit and the signature tolerance from its options", async () => {
    const small = await start({ maxBodyBytes: 100 });
    expect((await small.post({}, "x".repeat(500))).status).toBe(413);
    const strict = await start({ toleranceMs: 1_000 });
    expect((await strict.post({ "x-signature": signBody(SECRET, NOW - 5_000, body) })).status).toBe(401);
  });
});

describe("serve configuration (review findings: unreachable knobs, plain-http endpoints)", () => {
  const env = {
    DATABASE_URL: "postgres://app@db.internal:5432/booking",
    PII_KEYS: "a".repeat(64),
    MESSAGE_KEYS: "c".repeat(64),
    PHONE_HASH_KEY: "b".repeat(64),
    WEBHOOK_SECRETS: "s".repeat(32),
    MODEL_BASE_URL: "https://llm.example.test/v1",
    MODEL_API_KEY: "k",
    MODEL_NAME: "m",
    RELAY_URL: "https://relay.example.test/send",
    RELAY_TOKEN: "t",
  };
  it("reads the webhook limits and the trusted proxy depth from the environment, with defaults", () => {
    expect(readServeConfig(env)).toMatchObject({ requestsPerMinute: 600, maxBodyBytes: 65_536, toleranceMs: 300_000, trustedProxyHops: 0 });
    expect(readServeConfig({ ...env, WEBHOOK_REQUESTS_PER_MINUTE: "50", WEBHOOK_MAX_BODY_BYTES: "2000", WEBHOOK_TOLERANCE_SECONDS: "60", TRUSTED_PROXY_HOPS: "1" })).toMatchObject({
      requestsPerMinute: 50,
      maxBodyBytes: 2000,
      toleranceMs: 60_000,
      trustedProxyHops: 1,
    });
    for (const [name, value] of [["WEBHOOK_REQUESTS_PER_MINUTE", "0"], ["WEBHOOK_MAX_BODY_BYTES", "12"], ["WEBHOOK_TOLERANCE_SECONDS", "x"], ["TRUSTED_PROXY_HOPS", "9"]] as const) {
      expect(() => readServeConfig({ ...env, [name]: value }), name).toThrow(name);
    }
  });
  it("requires https for the model and the relay, except on loopback", () => {
    expect(() => readServeConfig({ ...env, MODEL_BASE_URL: "http://llm.example.test/v1" })).toThrow("MODEL_BASE_URL must be an https URL");
    expect(() => readServeConfig({ ...env, RELAY_URL: "http://relay.example.test/send" })).toThrow("RELAY_URL must be an https URL");
    expect(() => readServeConfig({ ...env, RELAY_URL: "not a url" })).toThrow("RELAY_URL must be an https URL");
    expect(readServeConfig({ ...env, MODEL_BASE_URL: "http://127.0.0.1:9000/v1", RELAY_URL: "http://localhost:9001/send" }).relayUrl).toBe("http://localhost:9001/send");
  });
});

describe("model response size (review finding)", () => {
  it("refuses a response bigger than the cap without reading it all", async () => {
    const huge = new Response("x".repeat(600_000), { status: 200, headers: { "content-type": "application/json" } });
    const model = new HttpChatModel({ baseUrl: "https://x.test", apiKey: "k", model: "m", fetch: async () => huge });
    await expect(model.complete({ system: "", messages: [], tools: [] })).rejects.toThrow("too large");
  });
});

describe("phone numbers with a trunk digit (review finding)", () => {
  it("refuses '(0)' instead of making a second client out of the same person", () => {
    expect(normalizePhone("+44 (0) 7700 900123")).toBeUndefined();
    expect(normalizePhone("+44(0)7700900123")).toBeUndefined();
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
  });
});

describe("the demo refuses a server that is not on this machine (review finding)", () => {
  it("throws before connecting when the host is not loopback", async () => {
    await expect(createDemoDatabase("postgres://postgres@db.example.test:5432/postgres")).rejects.toThrow("loopback");
    await expect(createDemoDatabase("postgres://postgres@10.0.0.5:5432/postgres")).rejects.toThrow("loopback");
  });
});
