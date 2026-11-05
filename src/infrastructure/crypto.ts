import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Hasher, PiiCipher } from "../application/ports.js";

const BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const HEX = /^[0-9a-fA-F]{64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
const MIN_DISTINCT_BYTES = 12;

/**
 * A key of exactly 32 bytes, given as 64 hex characters or as canonical base64 (44 characters with one "="). Anything else is
 * refused, and so is a key that is obviously not random (fewer than 12 different byte values): a configuration error must not
 * start a service with a guessable key.
 */
export function parseKey(text: string, name: string): Buffer {
  const trimmed = text.trim();
  const key = HEX.test(trimmed) ? Buffer.from(trimmed, "hex") : BASE64.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
  if (key === undefined || key.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex characters or canonical base64)`);
  if (new Set(key).size < MIN_DISTINCT_BYTES) throw new Error(`${name} does not look random`);
  return key;
}

export interface KeyRing {
  readonly keys: Readonly<Record<string, Buffer>>;
  /** the key that encrypts new data; the others only decrypt */
  readonly activeId: string;
}

/** `id=key,id2=key2`: the first is active. A bare key is the ring `k1=key`. Add a key at the front to rotate; remove an old one once nothing uses it. */
export function parseKeyRing(text: string, name: string): KeyRing {
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${name} is empty`);
  const keys: Record<string, Buffer> = {};
  let activeId = "";
  for (const entry of entries) {
    const named = /^([A-Za-z0-9_-]{1,16})=(.+)$/.exec(entry);
    const id = named ? (named[1] as string) : "k1";
    const value = named ? (named[2] as string) : entry;
    if (!KEY_ID.test(id)) throw new Error(`${name} has an invalid key id`);
    if (id in keys) throw new Error(`${name} lists the key id ${id} twice`);
    keys[id] = parseKey(value, name);
    if (activeId === "") activeId = id;
  }
  return { keys, activeId };
}

/**
 * AES-256-GCM for data at rest. The stored text is `v2:KEYID:IV:CIPHERTEXT:TAG` (base64url): a 12 byte random IV and a 16 byte tag,
 * both length-checked. `context` (table, column, salon, row id: see application/aad.ts) is authenticated with the data, and so is
 * the purpose of this cipher, so a value cannot be moved to another row, column, salon or purpose. Keys are named, so a new key
 * can be made active while old rows still open with the key they were written with.
 */
export class AesGcmCipher implements PiiCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly activeId: string;
  private readonly purpose: string;

  constructor(keys: Readonly<Record<string, Buffer>>, activeId: string, purpose = "pii") {
    for (const [id, key] of Object.entries(keys)) {
      if (!KEY_ID.test(id)) throw new Error("invalid key id");
      if (key.length !== 32) throw new Error("encryption keys must be 32 bytes");
    }
    if (!(activeId in keys)) throw new Error("the active key id is not in the key ring");
    this.keys = new Map(Object.entries(keys));
    this.activeId = activeId;
    this.purpose = purpose;
  }

  private additionalData(context: string): Buffer {
    return Buffer.from(`booking-assistant-core|v2|${this.purpose}|${context}`);
  }

  encrypt(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeId) as Buffer, iv, { authTagLength: 16 });
    cipher.setAAD(this.additionalData(context));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v2", this.activeId, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
  }

  decrypt(sealed: string, context: string): string {
    const parts = sealed.split(":");
    const [version, keyId, ivText, bodyText, tagText] = parts;
    const key = keyId === undefined ? undefined : this.keys.get(keyId);
    if (parts.length !== 5 || version !== "v2" || key === undefined || ivText === undefined || bodyText === undefined || tagText === undefined) {
      throw new Error("cannot decrypt: unknown format or key");
    }
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("cannot decrypt: unknown format or key");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(this.additionalData(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** HMAC-SHA256 with a server-side key for phone numbers, separated by salon (the same number in two salons has two different hashes), and plain SHA-256 for digests. */
export class HmacHasher implements Hasher {
  private readonly phoneSecret: Buffer;

  constructor(phoneSecret: Buffer) {
    if (phoneSecret.length < 32) throw new Error("the phone hash key must be at least 32 bytes");
    this.phoneSecret = phoneSecret;
  }

  phoneKey(salonId: string, e164: string): string {
    return createHmac("sha256", this.phoneSecret).update(`phone:${salonId}:${e164}`).digest("hex");
  }

  digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}
