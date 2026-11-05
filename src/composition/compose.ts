import { randomBytes } from "node:crypto";
import type { Deps } from "../application/ports.js";
import { AesGcmCipher, HmacHasher, parseKey } from "../infrastructure/crypto.js";
import { PostgresDatabase, type PostgresOptions } from "../infrastructure/postgres/database.js";
import { JsonLogger, systemClock, uuidGenerator } from "../infrastructure/system.js";

export { migrate } from "../infrastructure/postgres/migrate.js";

export interface CompositionConfig {
  /** connection string of the application's login role (not the schema owner) */
  readonly databaseUrl: string;
  /** 32 bytes, hex or base64: encrypts phone numbers and names at rest */
  readonly piiKey: string;
  /** 32 bytes, hex or base64: the key of the phone number lookup hash */
  readonly phoneHashKey: string;
  readonly poolMax?: number;
  readonly write?: (line: string) => void;
}

export interface Composed {
  readonly deps: Deps;
  readonly database: PostgresDatabase;
  close(): Promise<void>;
}

/** Wires the real adapters into the dependencies every use case takes. Keys come from the environment of the caller, never from the repository. */
export function compose(config: CompositionConfig): Composed {
  const options: PostgresOptions = { url: config.databaseUrl, ...(config.poolMax === undefined ? {} : { poolMax: config.poolMax }) };
  const database = new PostgresDatabase(options);
  const write = config.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deps: Deps = {
    db: database,
    clock: systemClock,
    ids: uuidGenerator,
    hasher: new HmacHasher(parseKey(config.phoneHashKey, "PHONE_HASH_KEY")),
    cipher: new AesGcmCipher({ k1: parseKey(config.piiKey, "PII_KEY") }, "k1"),
    logger: new JsonLogger(write, systemClock),
  };
  return { deps, database, close: () => database.close() };
}

/** A throwaway pair of keys for a demo or a test: fresh random bytes, not stored anywhere. */
export function throwawayKeys(): { piiKey: string; phoneHashKey: string } {
  return { piiKey: randomBytes(32).toString("hex"), phoneHashKey: randomBytes(32).toString("hex") };
}

export { createDemoDatabase, MIGRATIONS_DIR, type DemoDatabase } from "../infrastructure/postgres/demo-database.js";
export { W as SAMPLE_IDS } from "../infrastructure/postgres/sample-data.js";
export { ManualClock, uuidGenerator } from "../infrastructure/system.js";
export { createWebhookServer } from "../infrastructure/http/server.js";
export { signBody } from "../infrastructure/http/signature.js";
export { readServeConfig, startServer, type Running, type ServeConfig } from "./serve.js";
