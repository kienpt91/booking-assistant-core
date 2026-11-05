import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher, HmacHasher, parseKey, parseKeyRing } from "../../src/infrastructure/crypto.js";
import { JsonLogger, ManualClock, systemClock, uuidGenerator } from "../../src/infrastructure/system.js";

const CTX = "client_pii.phone_enc|salon-1|client-1";

describe("parseKey (review finding: lenient key parsing)", () => {
  it("accepts 32 random bytes as hex or canonical base64 and nothing else", () => {
    const bytes = randomBytes(32);
    expect(parseKey(bytes.toString("hex"), "K").equals(bytes)).toBe(true);
    expect(parseKey(bytes.toString("base64"), "K").equals(bytes)).toBe(true);
    expect(parseKey(` ${bytes.toString("hex")}\n`, "K").equals(bytes)).toBe(true);
    for (const bad of ["", "short", randomBytes(16).toString("hex"), randomBytes(33).toString("base64"), randomBytes(32).toString("base64").replace("=", ""), randomBytes(32).toString("base64url")]) {
      expect(() => parseKey(bad, "PII_KEYS"), bad).toThrow(/PII_KEYS must be 32 bytes/);
    }
  });
  it("refuses a key that is plainly not random, even when it has the right length", () => {
    for (const weak of ["A".repeat(43) + "=", "a".repeat(64), "0".repeat(64), "ab".repeat(32)]) expect(() => parseKey(weak, "K"), weak).toThrow("does not look random");
  });
  it("reads a key ring: the first key is active, a bare key is k1, duplicates and bad ids are refused", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const ring = parseKeyRing(`k2=${a.toString("hex")}, k1=${b.toString("base64")}`, "R");
    expect(ring.activeId).toBe("k2");
    expect(ring.keys["k1"]?.equals(b)).toBe(true);
    expect(parseKeyRing(a.toString("hex"), "R")).toMatchObject({ activeId: "k1" });
    expect(parseKeyRing(a.toString("base64"), "R")).toMatchObject({ activeId: "k1" });
    expect(() => parseKeyRing(`k1=${a.toString("hex")},k1=${b.toString("hex")}`, "R")).toThrow("twice");
    expect(() => parseKeyRing(`bad id=${a.toString("hex")}`, "R")).toThrow();
    expect(() => parseKeyRing(" , ", "R")).toThrow("empty");
  });
});

describe("AesGcmCipher", () => {
  const key = randomBytes(32);

  it("round-trips any text and never writes it in the clear", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    for (const text of ["+966501234567", "سارة", "", "a".repeat(10_000), "line\nbreak \u0000"]) {
      const sealed = cipher.encrypt(text, CTX);
      expect(sealed.startsWith("v2:k1:")).toBe(true);
      expect(sealed).not.toContain(text === "" ? "\u0001" : text);
      expect(cipher.decrypt(sealed, CTX)).toBe(text);
    }
  });

  it("uses a fresh nonce each time", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    expect(cipher.encrypt("same", CTX)).not.toBe(cipher.encrypt("same", CTX));
  });

  it("is bound to its context: a value moved to another row, column or salon does not decrypt (review finding: constant AAD)", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    const sealed = cipher.encrypt("+966501234567", "client_pii.phone_enc|salon-1|client-1");
    for (const other of ["client_pii.phone_enc|salon-1|client-2", "client_pii.name_enc|salon-1|client-1", "client_pii.phone_enc|salon-2|client-1", "outbox_messages.recipient_enc|salon-1|client-1", ""]) {
      expect(() => cipher.decrypt(sealed, other), other).toThrow();
    }
  });

  it("is bound to its purpose: a message cipher cannot open a value of the phone cipher, even with the same key and context", () => {
    const pii = new AesGcmCipher({ k1: key }, "k1", "pii");
    const message = new AesGcmCipher({ k1: key }, "k1", "message");
    expect(() => message.decrypt(pii.encrypt("x", CTX), CTX)).toThrow();
  });

  it("detects a changed ciphertext, nonce, tag, tag length or key id, and a different key", () => {
    const cipher = new AesGcmCipher({ k1: key }, "k1");
    const [v, id, iv, body, tag] = cipher.encrypt("+966501234567", CTX).split(":") as [string, string, string, string, string];
    const flip = (s: string): string => (s.startsWith("A") ? "B" : "A") + s.slice(1);
    for (const tampered of [`${v}:${id}:${iv}:${flip(body)}:${tag}`, `${v}:${id}:${flip(iv)}:${body}:${tag}`, `${v}:${id}:${iv}:${body}:${flip(tag)}`]) expect(() => cipher.decrypt(tampered, CTX)).toThrow();
    // a shortened tag (review finding: tag length not pinned) and a shortened nonce are refused before any decryption
    expect(() => cipher.decrypt(`${v}:${id}:${iv}:${body}:${Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url")}`, CTX)).toThrow("cannot decrypt");
    expect(() => cipher.decrypt(`${v}:${id}:${Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url")}:${body}:${tag}`, CTX)).toThrow("cannot decrypt");
    expect(() => new AesGcmCipher({ k1: randomBytes(32) }, "k1").decrypt(cipher.encrypt("x", CTX), CTX)).toThrow();
    for (const bad of ["", "v2:k1", `v1:${id}:${iv}:${body}:${tag}`, `${v}:unknown:${iv}:${body}:${tag}`, "plain text"]) expect(() => cipher.decrypt(bad, CTX)).toThrow("cannot decrypt");
  });

  it("rotates: new data uses the active key, old data still opens with the key it was written with", () => {
    const old = new AesGcmCipher({ k1: key }, "k1");
    const sealedOld = old.encrypt("before the rotation", CTX);
    const rotated = new AesGcmCipher({ k2: randomBytes(32), k1: key }, "k2");
    expect(rotated.decrypt(sealedOld, CTX)).toBe("before the rotation");
    expect(rotated.encrypt("after", CTX).startsWith("v2:k2:")).toBe(true);
  });

  it("refuses a bad key ring", () => {
    expect(() => new AesGcmCipher({ k1: randomBytes(16) }, "k1")).toThrow("32 bytes");
    expect(() => new AesGcmCipher({ k1: key }, "k9")).toThrow("not in the key ring");
    expect(() => new AesGcmCipher({ "bad id!": key }, "bad id!")).toThrow("invalid key id");
  });
});

describe("HmacHasher", () => {
  it("is deterministic per key and salon, and differs between keys, salons and numbers (review finding: no tenant separation)", () => {
    const a = new HmacHasher(randomBytes(32));
    const b = new HmacHasher(randomBytes(32));
    expect(a.phoneKey("salon-1", "+966501234567")).toBe(a.phoneKey("salon-1", "+966501234567"));
    expect(a.phoneKey("salon-1", "+966501234567")).toMatch(/^[0-9a-f]{64}$/);
    expect(a.phoneKey("salon-1", "+966501234567")).not.toBe(a.phoneKey("salon-1", "+966501234568"));
    expect(a.phoneKey("salon-1", "+966501234567")).not.toBe(a.phoneKey("salon-2", "+966501234567"));
    expect(a.phoneKey("salon-1", "+966501234567")).not.toBe(b.phoneKey("salon-1", "+966501234567"));
  });

  it("separates the phone key from the plain digest and refuses a short key", () => {
    const hasher = new HmacHasher(randomBytes(32));
    expect(hasher.digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hasher.digest("+966501234567")).not.toBe(hasher.phoneKey("salon-1", "+966501234567"));
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
    expect(first).toEqual({ path: "/webhook", phone: "[redacted]", note: "[redacted]", detail: "reach [email] or [phone]", salonId: "3f2b8c1a-0000-4000-8000-000000000001", ts: "2026-11-09T09:00:00.000Z", level: "info", event: "request" });
    expect(second).toMatchObject({ level: "warn", event: "slow", ms: 1200 });
    expect(third).toMatchObject({ level: "error", event: "failed" });
    expect(lines.join("")).not.toMatch(/966501234567|sara@|7700 900123/);
  });
});
