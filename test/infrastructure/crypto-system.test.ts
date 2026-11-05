import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher, HmacHasher, parseKey } from "../../src/infrastructure/crypto.js";
import { JsonLogger, ManualClock, systemClock, uuidGenerator } from "../../src/infrastructure/system.js";

describe("parseKey", () => {
  it("accepts 32 bytes as hex or base64 and nothing else", () => {
    const bytes = randomBytes(32);
    expect(parseKey(bytes.toString("hex"), "K").equals(bytes)).toBe(true);
    expect(parseKey(bytes.toString("base64"), "K").equals(bytes)).toBe(true);
    expect(parseKey(` ${bytes.toString("hex")}\n`, "K").equals(bytes)).toBe(true);
    for (const bad of ["", "short", randomBytes(16).toString("hex"), randomBytes(33).toString("base64")]) expect(() => parseKey(bad, "PII_KEY")).toThrow(/PII_KEY must be 32 bytes/);
  });
});

describe("AesGcmCipher", () => {
  const key = randomBytes(32);

  it("round-trips any text and never writes it in the clear", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    for (const text of ["+966501234567", "سارة", "", "a".repeat(10_000), "line\nbreak \u0000"]) {
      const sealed = cipher.encrypt(text);
      expect(sealed.startsWith("v1:k1:")).toBe(true);
      expect(sealed).not.toContain(text === "" ? "\u0001" : text);
      expect(cipher.decrypt(sealed)).toBe(text);
    }
  });

  it("uses a fresh nonce each time", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("detects a changed ciphertext, nonce, tag, key id or a different key", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    const [v, id, iv, body, tag] = cipher.encrypt("+966501234567").split(":") as [string, string, string, string, string];
    const flip = (s: string): string => (s.startsWith("A") ? "B" : "A") + s.slice(1);
    for (const tampered of [`${v}:${id}:${iv}:${flip(body)}:${tag}`, `${v}:${id}:${flip(iv)}:${body}:${tag}`, `${v}:${id}:${iv}:${body}:${flip(tag)}`]) {
      expect(() => cipher.decrypt(tampered)).toThrow();
    }
    expect(() => new AesGcmCipher({ k1: randomBytes(32) }, "k1").decrypt(cipher.encrypt("x"))).toThrow();
    for (const bad of ["", "v1:k1", `v2:${id}:${iv}:${body}:${tag}`, `${v}:unknown:${iv}:${body}:${tag}`, "plain text"]) expect(() => cipher.decrypt(bad)).toThrow("cannot decrypt");
  });

  it("rotates: new data uses the active key, old data still opens with the key it was written with", () => {
    const old = new AesGcmCipher({ k1: key }, "k1");
    const sealedOld = old.encrypt("before the rotation");
    const rotated = new AesGcmCipher({ k1: key, k2: randomBytes(32) }, "k2");
    expect(rotated.decrypt(sealedOld)).toBe("before the rotation");
    expect(rotated.encrypt("after").startsWith("v1:k2:")).toBe(true);
  });

  it("refuses a bad key ring", () => {
    expect(() => new AesGcmCipher({ k1: randomBytes(16) }, "k1")).toThrow("32 bytes");
    expect(() => new AesGcmCipher({ k1: key }, "k9")).toThrow("not in the key ring");
    expect(() => new AesGcmCipher({ "bad id!": key }, "bad id!")).toThrow("invalid key id");
  });
});

describe("HmacHasher", () => {
  it("is deterministic per key and gives different keys different hashes", () => {
    const a = new HmacHasher(randomBytes(32));
    const b = new HmacHasher(randomBytes(32));
    expect(a.phoneKey("+966501234567")).toBe(a.phoneKey("+966501234567"));
    expect(a.phoneKey("+966501234567")).toMatch(/^[0-9a-f]{64}$/);
    expect(a.phoneKey("+966501234567")).not.toBe(a.phoneKey("+966501234568"));
    expect(a.phoneKey("+966501234567")).not.toBe(b.phoneKey("+966501234567"));
  });

  it("separates the phone key from the plain digest and refuses a short key", () => {
    const hasher = new HmacHasher(randomBytes(32));
    expect(hasher.digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hasher.digest("+966501234567")).not.toBe(hasher.phoneKey("+966501234567"));
    expect(() => new HmacHasher(randomBytes(31))).toThrow("at least 32 bytes");
  });
});

describe("system adapters", () => {
  it("produce real time and unique uuids", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
    const a = uuidGenerator.next();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidGenerator.next()).not.toBe(a);
  });

  it("moves a manual clock only when told to", () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(9);
    expect(clock.now()).toBe(9);
  });

  it("writes one JSON line per event with fixed keys, redacting personal data in the fields", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((l) => lines.push(l), new ManualClock(Date.UTC(2026, 10, 9, 9, 0)));
    logger.info("request", { path: "/webhook", phone: "+966501234567", note: "call me", detail: "reach sara@example.com or +44 7700 900123", salonId: "3f2b8c1a-0000-4000-8000-000000000001", ts: "forged", level: "forged", event: "forged" });
    logger.warn("slow", { ms: 1200 });
    logger.error("failed");
    const [first, second, third] = lines.map((l) => JSON.parse(l));
    expect(first).toEqual({
      path: "/webhook",
      phone: "[redacted]",
      note: "[redacted]",
      detail: "reach [email] or [phone]",
      salonId: "3f2b8c1a-0000-4000-8000-000000000001",
      ts: "2026-11-09T09:00:00.000Z",
      level: "info",
      event: "request",
    });
    expect(second).toMatchObject({ level: "warn", event: "slow", ms: 1200 });
    expect(third).toMatchObject({ level: "error", event: "failed" });
    expect(lines.join("")).not.toMatch(/966501234567|sara@|7700 900123/);
  });
});
