import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Hasher, PiiCipher } from "../application/ports.js";

/** A 32 byte key given as 64 hex characters or as base64. Anything shorter is refused: a weak key is a configuration error. */
export function parseKey(text: string, name: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex characters or base64)`);
  return key;
}

const AAD = Buffer.from("booking-assistant-core:pii:v1");
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * AES-256-GCM for personal data at rest. The stored text is `v1:KEYID:IV:CIPHERTEXT:TAG` (base64url). Each encryption
 * uses a fresh random IV; the tag makes a changed ciphertext fail to decrypt. Keys are named, so a new key can be
 * added and made active while old rows still decrypt with the key they were written with.
 */
export class AesGcmCipher implements PiiCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly activeId: string;

  constructor(keys: Readonly<Record<string, Buffer>>, activeId: string) {
    for (const [id, key] of Object.entries(keys)) {
      if (!KEY_ID.test(id)) throw new Error("invalid key id");
      if (key.length !== 32) throw new Error("encryption keys must be 32 bytes");
    }
    if (!(activeId in keys)) throw new Error("the active key id is not in the key ring");
    this.keys = new Map(Object.entries(keys));
    this.activeId = activeId;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeId) as Buffer, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", this.activeId, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
  }

  decrypt(sealed: string): string {
    const parts = sealed.split(":");
    const [version, keyId, iv, body, tag] = parts;
    const key = keyId === undefined ? undefined : this.keys.get(keyId);
    if (parts.length !== 5 || version !== "v1" || key === undefined || iv === undefined || body === undefined || tag === undefined) {
      throw new Error("cannot decrypt: unknown format or key");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** HMAC-SHA256 with a server-side key for phone numbers (a database dump cannot be used to test guessed numbers), and plain SHA-256 for digests. */
export class HmacHasher implements Hasher {
  private readonly phoneSecret: Buffer;

  constructor(phoneSecret: Buffer) {
    if (phoneSecret.length < 32) throw new Error("the phone hash key must be at least 32 bytes");
    this.phoneSecret = phoneSecret;
  }

  phoneKey(e164: string): string {
    return createHmac("sha256", this.phoneSecret).update(`phone:${e164}`).digest("hex");
  }

  digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}
