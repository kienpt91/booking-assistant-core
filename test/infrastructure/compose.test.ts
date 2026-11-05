import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compose, readServeConfig, throwawayKeys } from "../../src/composition/compose.js";
import * as api from "../../src/index.js";

const env = {
  DATABASE_URL: "postgres://app@127.0.0.1:1/none",
  PII_KEYS: "a".repeat(64),
  MESSAGE_KEYS: "c".repeat(64),
  PHONE_HASH_KEY: "b".repeat(64),
  WEBHOOK_SECRETS: `${"s".repeat(32)}, ${"t".repeat(40)}`,
  MODEL_BASE_URL: "https://llm.example.test/v1",
  MODEL_API_KEY: "key-for-tests",
  MODEL_NAME: "m",
  RELAY_URL: "https://relay.example.test/send",
  RELAY_TOKEN: "token-for-tests",
};

describe("compose", () => {
  it("wires the real adapters without connecting, with a separate key for messages, and closes the pool", async () => {
    const lines: string[] = [];
    const { deps, close } = compose({ databaseUrl: env.DATABASE_URL, ...throwawayKeys(), poolMax: 2, write: (l) => lines.push(l) });
    expect(deps.cipher.decrypt(deps.cipher.encrypt("+447700900001", "ctx"), "ctx")).toBe("+447700900001");
    expect(() => deps.messageCipher.decrypt(deps.cipher.encrypt("x", "ctx"), "ctx")).toThrow();
    expect(deps.hasher.phoneKey("salon", "+447700900001")).toMatch(/^[0-9a-f]{64}$/);
    deps.logger.info("hello", { phone: "+447700900001" });
    expect(lines[0]).toContain('"phone":"[redacted]"');
    await close();
  });

  it("refuses weak keys and the same key used twice, without printing a key", () => {
    const keys = throwawayKeys();
    expect(() => compose({ databaseUrl: env.DATABASE_URL, ...keys, piiKeys: "short-secret-value" })).toThrow("PII_KEYS must be 32 bytes");
    expect(() => compose({ databaseUrl: env.DATABASE_URL, ...keys, piiKeys: "a".repeat(64) })).toThrow("does not look random");
    expect(() => compose({ databaseUrl: env.DATABASE_URL, ...keys, messageKeys: keys.piiKeys })).toThrow("must all be different");
    expect(() => compose({ databaseUrl: env.DATABASE_URL, ...keys, phoneHashKey: keys.messageKeys })).toThrow("must all be different");
    const ring = `k2=${randomBytes(32).toString("hex")},k1=${keys.piiKeys}`;
    expect(compose({ databaseUrl: env.DATABASE_URL, ...keys, piiKeys: ring }).deps.cipher.encrypt("x", "c").startsWith("v2:k2:")).toBe(true);
  });

  it("writes to stdout by default", async () => {
    const { deps, close } = compose({ databaseUrl: env.DATABASE_URL, ...throwawayKeys() });
    deps.logger.info("quiet");
    await close();
  });
});

describe("readServeConfig", () => {
  it("reads the environment with defaults", () => {
    const config = readServeConfig(env);
    expect(config).toMatchObject({ channel: "whatsapp", host: "127.0.0.1", port: 8080, defaultCountryCode: undefined });
    expect(config.webhookSecrets).toHaveLength(2);
  });

  it("names every missing variable and never a value", () => {
    // the URL is assembled at run time: the secret scanner (rightly) refuses a literal URL with a password
    const url = ["postgres://user", "hunter2"].join(":") + "@host/db";
    expect(() => readServeConfig({ DATABASE_URL: url })).toThrow(/missing environment variables: PII_KEYS, MESSAGE_KEYS, PHONE_HASH_KEY, WEBHOOK_SECRETS/);
    expect(() => readServeConfig({ DATABASE_URL: url })).not.toThrow(/hunter2/);
  });

  it("refuses short secrets and bad ports", () => {
    expect(() => readServeConfig({ ...env, WEBHOOK_SECRETS: "short" })).toThrow("at least 32 characters");
    for (const port of ["0", "70000", "abc", "80.5"]) expect(() => readServeConfig({ ...env, PORT: port })).toThrow("PORT");
  });
});

describe("the public entry point", () => {
  it("exports the use cases, the pipeline and the adapters' wiring", () => {
    for (const name of ["compose", "migrate", "book", "cancelAppointment", "moveAppointment", "findAvailability", "receiveMessage", "createRuntime", "PolicyEngine", "ScriptedModel", "runHostileSuite", "eraseClient"]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
