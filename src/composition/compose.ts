import { randomBytes } from "node:crypto";
import type { Deps } from "../application/ports.js";
import { AesGcmCipher, HmacHasher, parseKey, parseKeyRing } from "../infrastructure/crypto.js";
import { PostgresDatabase, type PostgresOptions } from "../infrastructure/postgres/database.js";
import { JsonLogger, systemClock, uuidGenerator } from "../infrastructure/system.js";

export interface CompositionConfig {
  /** connection string of the application's login role (not the schema owner) */
  readonly databaseUrl: string;
  /** key ring for phone numbers and names: `id=key,id2=key2` (the first is active) or one bare key of 32 bytes */
  readonly piiKeys: string;
  /** key ring for reply and conversation text; it must not share a key with `piiKeys` */
  readonly messageKeys: string;
  /** 32 bytes: the key of the phone number lookup hash */
  readonly phoneHashKey: string;
  readonly poolMax?: number;
  readonly write?: (line: string) => void;
}

export interface Composed {
  readonly deps: Deps;
  readonly database: PostgresDatabase;
  close(): Promise<void>;
}

export { migrate } from "../infrastructure/postgres/migrate.js";

/** Wires the real adapters into the dependencies every use case takes. Keys come from the environment of the caller, never from the repository. */
export function compose(config: CompositionConfig): Composed {
  const pii = parseKeyRing(config.piiKeys, "PII_KEYS");
  const messages = parseKeyRing(config.messageKeys, "MESSAGE_KEYS");
  const phone = parseKey(config.phoneHashKey, "PHONE_HASH_KEY");
  const all = [...Object.values(pii.keys), ...Object.values(messages.keys), phone].map((k) => k.toString("hex"));
  if (new Set(all).size !== all.length) throw new Error("PII_KEYS, MESSAGE_KEYS and PHONE_HASH_KEY must all be different keys");
  const options: PostgresOptions = { url: config.databaseUrl, ...(config.poolMax === undefined ? {} : { poolMax: config.poolMax }) };
  const database = new PostgresDatabase(options);
  const write = config.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deps: Deps = {
    db: database,
    clock: systemClock,
    ids: uuidGenerator,
    hasher: new HmacHasher(phone),
    cipher: new AesGcmCipher(pii.keys, pii.activeId, "pii"),
    messageCipher: new AesGcmCipher(messages.keys, messages.activeId, "message"),
    logger: new JsonLogger(write, systemClock),
  };
  return { deps, database, close: () => database.close() };
}

/** Three throwaway keys for a demo or a test: fresh random bytes, not stored anywhere. */
export function throwawayKeys(): { piiKeys: string; messageKeys: string; phoneHashKey: string } {
  return { piiKeys: randomBytes(32).toString("hex"), messageKeys: randomBytes(32).toString("hex"), phoneHashKey: randomBytes(32).toString("hex") };
}

export { createDemoDatabase, MIGRATIONS_DIR, type DemoDatabase } from "../infrastructure/postgres/demo-database.js";
export { W as SAMPLE_IDS } from "../infrastructure/postgres/sample-data.js";
export { ManualClock, uuidGenerator } from "../infrastructure/system.js";
export { createWebhookServer } from "../infrastructure/http/server.js";
export { signBody } from "../infrastructure/http/signature.js";
export { readServeConfig, type ServeConfig } from "./config.js";
export { startServer, type Running } from "./serve.js";
