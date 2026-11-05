import { once } from "node:events";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, toolJson } from "../../src/application/assistant/fake-model.js";
import { createRuntime, receiveMessage, type InboundMessage, type ReceiveResult } from "../../src/application/assistant/inbound.js";
import { dispatchAll } from "../../src/application/messaging.js";
import { createWebhookServer, type WebhookHandler } from "../../src/infrastructure/http/server.js";
import { signBody, verifySignature } from "../../src/infrastructure/http/signature.js";
import { parseWebhookPayload } from "../../src/infrastructure/http/whatsapp-shape.js";
import { HttpChatModel } from "../../src/infrastructure/model/http-chat-model.js";
import { RelayChannel } from "../../src/infrastructure/http/relay-channel.js";
import { ManualClock } from "../../src/infrastructure/system.js";
import { FakeChannel } from "../support/channel.js";
import { memoryWorld } from "../support/deps.js";
import { W } from "../support/seed.js";

const SECRET = "test-secret-".padEnd(40, "x");
const NOW = Date.UTC(2026, 10, 9, 9, 0);

function payload(over: { id?: string; from?: string; body?: string; type?: string; to?: string } = {}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: over.to ?? "salon-a" },
              contacts: [{ wa_id: over.from ?? "447700900001", profile: { name: "Sara" } }],
              messages: [{ id: over.id ?? "wamid.1", from: over.from ?? "447700900001", timestamp: "1", type: over.type ?? "text", text: { body: over.body ?? "hello" } }],
            },
          },
        ],
      },
    ],
  });
}

describe("signature", () => {
  const body = Buffer.from('{"a":1}');
  it("accepts a fresh signature made with any listed secret", () => {
    const header = signBody("old-secret".padEnd(32, "o"), NOW, body);
    expect(verifySignature(header, body, [SECRET, "old-secret".padEnd(32, "o")], NOW + 1000, 300_000)).toBe("ok");
  });
  it("refuses a wrong secret, a changed body, a malformed header and a missing header", () => {
    const header = signBody(SECRET, NOW, body);
    expect(verifySignature(header, body, ["another".padEnd(32, "a")], NOW, 300_000)).toBe("mismatch");
    expect(verifySignature(header, Buffer.from('{"a":2}'), [SECRET], NOW, 300_000)).toBe("mismatch");
    for (const bad of ["", "t=1", "v1=abc", `${header},extra=1`, `t=abc,v1=${"0".repeat(64)}`, `t=1,v1=${"0".repeat(63)}`, `T=1,v1=${"0".repeat(64)}`]) expect(verifySignature(bad, body, [SECRET], NOW, 300_000)).toBe("malformed");
    expect(verifySignature(undefined, body, [SECRET], NOW, 300_000)).toBe("malformed");
  });
  it("refuses a signature outside the tolerance, in the past or in the future", () => {
    const header = signBody(SECRET, NOW, body);
    expect(verifySignature(header, body, [SECRET], NOW + 301_000, 300_000)).toBe("stale");
    expect(verifySignature(header, body, [SECRET], NOW - 301_000, 300_000)).toBe("stale");
    expect(verifySignature(header, body, [SECRET], NOW + 299_000, 300_000)).toBe("ok");
  });
});

describe("payload shape", () => {
  it("reads messages, the sender name and the salon address, and makes the number international", () => {
    expect(parseWebhookPayload(JSON.parse(payload()), "chat")).toEqual([{ channel: "chat", messageId: "wamid.1", to: "salon-a", from: "+447700900001", text: "hello", senderName: "Sara" }]);
  });
  it("gives non-text messages undefined text", () => {
    expect(parseWebhookPayload(JSON.parse(payload({ type: "image" })), "chat")?.[0]?.text).toBeUndefined();
  });
  it("refuses other shapes and oversized lists", () => {
    for (const bad of [null, 5, [], {}, { object: "other", entry: [] }, { object: "whatsapp_business_account", entry: "x" }, { object: "whatsapp_business_account", entry: [{}] }, { object: "whatsapp_business_account", entry: Array(21).fill({ changes: [] }) }]) {
      expect(parseWebhookPayload(bad, "chat")).toBeUndefined();
    }
    const noId = JSON.parse(payload());
    delete noId.entry[0].changes[0].value.messages[0].id;
    expect(parseWebhookPayload(noId, "chat")).toBeUndefined();
    expect(parseWebhookPayload({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "statuses", value: {} }] }] }, "chat")).toEqual([]);
  });
});

describe("webhook server", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function start(over: { handler?: WebhookHandler; requestsPerMinute?: number; maxBodyBytes?: number } = {}) {
    const clock = new ManualClock(NOW);
    const seen: InboundMessage[] = [];
    const logs: string[] = [];
    const handler: WebhookHandler = over.handler ?? {
      receive: async (m) => {
        seen.push(m);
        return { status: "processed" } as ReceiveResult;
      },
      ready: async () => undefined,
    };
    const logger = { info: (e: string) => logs.push(e), warn: (e: string, f?: object) => logs.push(`${e} ${JSON.stringify(f)}`), error: (e: string, f?: object) => logs.push(`${e} ${JSON.stringify(f)}`) };
    const server = createWebhookServer({ secrets: [SECRET], channel: "chat", handler, clock, logger, ...(over.requestsPerMinute ? { requestsPerMinute: over.requestsPerMinute } : {}), ...(over.maxBodyBytes ? { maxBodyBytes: over.maxBodyBytes } : {}) });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: string, headers: Record<string, string> = {}, path = "/webhook/messages") =>
      fetch(base + path, { method: "POST", body, headers: { "content-type": "application/json", "x-signature": signBody(SECRET, NOW, body), ...headers } });
    return { base, post, seen, logs, clock };
  }

  it("accepts a signed message and hands it to the handler", async () => {
    const s = await start();
    const res = await s.post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, results: { processed: 1 } });
    expect(s.seen[0]).toMatchObject({ messageId: "wamid.1", from: "+447700900001" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a missing, wrong or stale signature without calling the handler, and says nothing about why", async () => {
    const s = await start();
    for (const headers of [{ "x-signature": "" }, { "x-signature": signBody("wrong".padEnd(32, "w"), NOW, payload()) }, { "x-signature": signBody(SECRET, NOW - 600_000, payload()) }]) {
      const res = await s.post(payload(), headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }
    expect(s.seen).toHaveLength(0);
  });

  it("limits the size of the body, by the declared length and by what actually arrives", async () => {
    const s = await start({ maxBodyBytes: 1000 });
    const big = "x".repeat(5000);
    expect((await s.post(big)).status).toBe(413);
    // a body that lies about its length (chunked, no content-length)
    const res = await new Promise<number>((resolve) => {
      const req = http.request(s.base + "/webhook/messages", { method: "POST", headers: { "content-type": "application/json", "x-signature": signBody(SECRET, NOW, big) } }, (r) => resolve(r.statusCode ?? 0));
      req.on("error", () => resolve(413));
      req.write(big.slice(0, 2500));
      req.write(big.slice(2500));
      req.end();
    });
    expect(res).toBe(413);
    expect(s.seen).toHaveLength(0);
  });

  it("checks the method, the path and the content type", async () => {
    const s = await start();
    expect((await fetch(s.base + "/webhook/messages")).status).toBe(405);
    expect((await fetch(s.base + "/nope")).status).toBe(404);
    expect((await s.post(payload(), { "content-type": "text/plain" })).status).toBe(415);
  });

  it("answers 400 for a signed body that is not JSON or not the expected shape", async () => {
    const s = await start();
    expect((await s.post("not json")).status).toBe(400);
    expect(await (await s.post("{}")).json()).toEqual({ error: "invalid_payload" });
  });

  it("limits requests per client address and tells the sender when to come back", async () => {
    const s = await start({ requestsPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await s.post(payload({ id: `m${i}` }))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await s.post(payload({ id: "again" }))).headers.get("retry-after")).toBe("60");
    s.clock.advance(61_000);
    expect((await s.post(payload({ id: "later" }))).status).toBe(200);
  });

  it("answers 500 with no detail when processing fails, and logs only the error class", async () => {
    const s = await start({
      handler: {
        receive: async () => {
          throw new Error("database password is hunter2 for +447700900001");
        },
        ready: async () => undefined,
      },
    });
    const res = await s.post(payload());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(s.logs.join("\n")).not.toMatch(/hunter2|7700900001/);
  });

  it("reports health and readiness", async () => {
    const ok = await start();
    expect((await fetch(ok.base + "/healthz")).status).toBe(200);
    expect(await (await fetch(ok.base + "/readyz")).json()).toEqual({ status: "ready" });
    const down = await start({ handler: { receive: async () => ({ status: "processed" }), ready: async () => Promise.reject(new Error("db down")) } });
    expect((await fetch(down.base + "/readyz")).status).toBe(503);
  });

  it("runs end to end: signed webhook, the real pipeline over the in-memory store, a scripted model, a delivered reply; a replay is a duplicate", async () => {
    const world = memoryWorld();
    const model = new ScriptedModel([toolJson("book", { service_id: W.cut, staff_id: W.staffA1, starts_at: "2026-11-10T10:00:00+00:00" })]);
    const runtime = createRuntime(model);
    const channel = new FakeChannel();
    const s = await start({ handler: { receive: (m) => receiveMessage(world.deps, runtime, m), ready: () => world.deps.db.ping() } });
    const first = await s.post(payload({ id: "wamid.77", body: "book me tuesday at 10" }));
    expect(await first.json()).toEqual({ received: 1, results: { processed: 1 } });
    const replay = await s.post(payload({ id: "wamid.77", body: "book me tuesday at 10" }));
    expect(await replay.json()).toEqual({ received: 1, results: { duplicate: 1 } });
    await dispatchAll(world.deps, channel);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toMatch(/^Book Haircut with Staff A1/);
    expect(channel.sent[0]?.to).toBe("+447700900001");
  });
});

describe("model and relay adapters", () => {
  it("asks an HTTP chat API for one completion and returns its text, mapping tool results to user messages", async () => {
    let seen: { url: string; auth: string | null; body: { messages: { role: string }[]; temperature: number } } | undefined;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"reply","text":"hi"}' } }] }), { status: 200 });
    };
    const model = new HttpChatModel({ baseUrl: "https://llm.example.test/v1/", apiKey: "key-for-tests", model: "m", fetch: fake });
    expect(await model.complete({ system: "s", messages: [{ role: "user", content: "a" }, { role: "tool", content: "b" }], tools: [] })).toBe('{"type":"reply","text":"hi"}');
    expect(seen?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(seen?.auth).toBe("Bearer key-for-tests");
    expect(seen?.body.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(seen?.body.temperature).toBe(0);
  });
  it("throws on an error status or an answer without text, never quoting the body", async () => {
    const failing = new HttpChatModel({ baseUrl: "https://x.test", apiKey: "k", model: "m", fetch: async () => new Response("secret conversation echoed", { status: 500 }) });
    await expect(failing.complete({ system: "", messages: [], tools: [] })).rejects.toThrow("status 500");
    await expect(failing.complete({ system: "", messages: [], tools: [] })).rejects.not.toThrow(/secret/);
    const empty = new HttpChatModel({ baseUrl: "https://x.test", apiKey: "k", model: "m", fetch: async () => new Response("{}", { status: 200 }) });
    await expect(empty.complete({ system: "", messages: [], tools: [] })).rejects.toThrow("no text");
  });
  it("posts a reply to the relay with an idempotency key and fails on an error status", async () => {
    const calls: { headers: Headers; body: string }[] = [];
    const ok = new RelayChannel({ url: "https://relay.test/send", token: "t", fetch: async (_u, init) => (calls.push({ headers: new Headers(init?.headers), body: String(init?.body) }), new Response("", { status: 202 })) });
    await ok.send({ idempotencyKey: "k1", to: "+447700900001", text: "hello" });
    expect(calls[0]?.headers.get("idempotency-key")).toBe("k1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ to: "+447700900001", text: "hello", idempotencyKey: "k1" });
    const bad = new RelayChannel({ url: "https://relay.test/send", token: "t", fetch: async () => new Response("", { status: 502 }) });
    await expect(bad.send({ idempotencyKey: "k", to: "x", text: "y" })).rejects.toThrow("502");
  });
});
