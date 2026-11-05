import type http from "node:http";
import { createRuntime, receiveMessage } from "../application/assistant/inbound.js";
import { dispatchAll, releaseExpiredHolds, applyRetention } from "../application/messaging.js";
import { createWebhookServer } from "../infrastructure/http/server.js";
import { RelayChannel } from "../infrastructure/http/relay-channel.js";
import { HttpChatModel } from "../infrastructure/model/http-chat-model.js";
import { compose } from "./compose.js";

export interface ServeConfig {
  readonly databaseUrl: string;
  readonly piiKey: string;
  readonly phoneHashKey: string;
  readonly webhookSecrets: readonly string[];
  readonly channel: string;
  readonly host: string;
  readonly port: number;
  readonly modelBaseUrl: string;
  readonly modelApiKey: string;
  readonly modelName: string;
  readonly relayUrl: string;
  readonly relayToken: string;
  readonly defaultCountryCode: string | undefined;
}

const REQUIRED = ["DATABASE_URL", "PII_KEY", "PHONE_HASH_KEY", "WEBHOOK_SECRETS", "MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME", "RELAY_URL", "RELAY_TOKEN"] as const;

/** Reads the configuration of `serve` from the environment. A missing variable is named; no value is ever printed. */
export function readServeConfig(env: Readonly<Record<string, string | undefined>>): ServeConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const get = (name: (typeof REQUIRED)[number]): string => env[name] as string;
  const secrets = get("WEBHOOK_SECRETS").split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.some((s) => s.length < 32)) throw new Error("every webhook secret must be at least 32 characters");
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number");
  return {
    databaseUrl: get("DATABASE_URL"),
    piiKey: get("PII_KEY"),
    phoneHashKey: get("PHONE_HASH_KEY"),
    webhookSecrets: secrets,
    channel: env["CHANNEL"] ?? "whatsapp",
    host: env["HOST"] ?? "127.0.0.1",
    port,
    modelBaseUrl: get("MODEL_BASE_URL"),
    modelApiKey: get("MODEL_API_KEY"),
    modelName: get("MODEL_NAME"),
    relayUrl: get("RELAY_URL"),
    relayToken: get("RELAY_TOKEN"),
    defaultCountryCode: env["DEFAULT_COUNTRY_CODE"],
  };
}

export interface Running {
  readonly server: http.Server;
  stop(): Promise<void>;
}

/** Starts the webhook server and the background jobs: the outbox dispatcher, the release of unconfirmed holds and retention. */
export async function startServer(config: ServeConfig, write: (line: string) => void): Promise<Running> {
  const { deps, close } = compose({ databaseUrl: config.databaseUrl, piiKey: config.piiKey, phoneHashKey: config.phoneHashKey, poolMax: 10, write });
  const runtime = createRuntime(new HttpChatModel({ baseUrl: config.modelBaseUrl, apiKey: config.modelApiKey, model: config.modelName }), { defaultCountryCode: config.defaultCountryCode });
  const channel = new RelayChannel({ url: config.relayUrl, token: config.relayToken });
  const server = createWebhookServer({
    secrets: config.webhookSecrets,
    channel: config.channel,
    handler: { receive: (message) => receiveMessage(deps, runtime, message), ready: () => deps.db.ping() },
    clock: deps.clock,
    logger: deps.logger,
  });
  const every = (ms: number, job: () => Promise<unknown>, name: string): NodeJS.Timeout =>
    setInterval(() => void job().catch((error: unknown) => deps.logger.error("job.failed", { job: name, error: error instanceof Error ? error.name : "unknown" })), ms).unref();
  const timers = [
    every(2_000, () => dispatchAll(deps, channel), "dispatch"),
    every(60_000, async () => {
      for (const salon of await deps.db.channels.salonsWithChannels()) await releaseExpiredHolds(deps, salon);
    }, "release-holds"),
    every(60 * 60_000, async () => {
      for (const salon of await deps.db.channels.salonsWithChannels()) await applyRetention(deps, salon);
    }, "retention"),
  ];
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(config.port, config.host, resolve);
  await promise;
  deps.logger.info("server.listening", { host: config.host, port: config.port });
  return {
    server,
    async stop() {
      for (const t of timers) clearInterval(t);
      await new Promise<void>((done) => server.close(() => done()));
      await close();
    },
  };
}
