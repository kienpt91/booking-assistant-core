import type http from "node:http";
import { createRuntime, receiveMessage } from "../application/assistant/inbound.js";
import { applyRetention, dispatchAll, releaseExpiredHolds } from "../application/messaging.js";
import { RelayChannel } from "../infrastructure/http/relay-channel.js";
import { createWebhookServer } from "../infrastructure/http/server.js";
import { HttpChatModel } from "../infrastructure/model/http-chat-model.js";
import { compose } from "./compose.js";
import type { ServeConfig } from "./config.js";

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
