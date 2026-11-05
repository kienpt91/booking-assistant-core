import http from "node:http";
import type { InboundMessage, ReceiveResult } from "../../application/assistant/inbound.js";
import { SlidingWindowLimiter } from "../../application/assistant/limits.js";
import type { Clock, Logger } from "../../application/ports.js";
import { verifySignature } from "./signature.js";
import { parseWebhookPayload } from "./whatsapp-shape.js";

export interface WebhookHandler {
  receive(message: InboundMessage): Promise<ReceiveResult>;
  /** resolves when the service can do its work (the database answers), rejects otherwise */
  ready(): Promise<void>;
}

export interface WebhookServerOptions {
  /** shared secrets, newest first; any of them verifies a request, so a secret can be rotated without downtime */
  readonly secrets: readonly string[];
  /** the `channel` name of the salon_channels rows this endpoint serves */
  readonly channel: string;
  readonly handler: WebhookHandler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxBodyBytes?: number;
  readonly toleranceMs?: number;
  /** requests per client address per minute, before anything is read */
  readonly requestsPerMinute?: number;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function reply(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

/** Reads at most `limit` bytes. Resolves undefined (and stops reading) as soon as the body is bigger. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | undefined>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      resolve(undefined);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
  return promise;
}

/**
 * The HTTP face of the booking core, on node:http only. POST /webhook/messages takes a signed, size-limited, rate-limited JSON
 * body, checks the signature over the raw bytes before parsing anything, and hands each message to the inbound pipeline,
 * which de-duplicates by message id. A failure while processing answers 500 without detail, so the sender retries and the
 * de-duplication makes the retry safe. GET /healthz and GET /readyz are for the platform. Nothing is echoed back from the request.
 */
export function createWebhookServer(options: WebhookServerOptions): http.Server {
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const tolerance = options.toleranceMs ?? 5 * 60_000;
  const limiter = new SlidingWindowLimiter(60_000, options.requestsPerMinute ?? 120, 10_000);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.logger.error("http.unhandled", { error: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) reply(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return reply(res, 200, { status: "ok" });
    if (req.method === "GET" && path === "/readyz") {
      try {
        await options.handler.ready();
        return reply(res, 200, { status: "ready" });
      } catch {
        return reply(res, 503, { status: "not_ready" });
      }
    }
    if (path !== "/webhook/messages") return reply(res, 404, { error: "not_found" });
    if (req.method !== "POST") return reply(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    if (!limiter.hit(req.socket.remoteAddress ?? "unknown", options.clock.now())) return reply(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return reply(res, 415, { error: "unsupported_media_type" });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBody) return reply(res, 413, { error: "payload_too_large" }, { connection: "close" });
    const body = await readBody(req, maxBody);
    if (body === undefined) return reply(res, 413, { error: "payload_too_large" }, { connection: "close" });

    const header = req.headers["x-signature"];
    const verdict = verifySignature(typeof header === "string" ? header : undefined, body, options.secrets, options.clock.now(), tolerance);
    if (verdict !== "ok") {
      options.logger.warn("http.signature_refused", { reason: verdict });
      return reply(res, 401, { error: "invalid_signature" });
    }
    let json: unknown;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      return reply(res, 400, { error: "invalid_json" });
    }
    const messages = parseWebhookPayload(json, options.channel);
    if (!messages) return reply(res, 400, { error: "invalid_payload" });

    const counts: Record<string, number> = {};
    try {
      for (const message of messages) {
        const { status } = await options.handler.receive(message);
        counts[status] = (counts[status] ?? 0) + 1;
      }
    } catch (error) {
      options.logger.error("http.processing_failed", { error: error instanceof Error ? error.name : "unknown" });
      return reply(res, 500, { error: "internal_error" });
    }
    return reply(res, 200, { received: messages.length, results: counts });
  }

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
