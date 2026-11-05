import type { Instant } from "../domain/time/instant.js";
import type { Database } from "./store.js";

/** The only source of "now". Nothing in the domain or application layers reads the system clock. */
export interface Clock {
  now(): Instant;
}

/** A source of new identifiers (UUIDs). */
export interface IdGenerator {
  next(): string;
}

/** Structured logging. Fields are redacted by the implementation, but callers still never pass names, numbers or message text. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Encryption of personal data at rest. The key never reaches the database. */
export interface PiiCipher {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export interface Hasher {
  /** keyed hash of a phone number (HMAC): the lookup key stored in the database */
  phoneKey(e164: string): string;
  /** unkeyed SHA-256 of a text, hex: for digests of requests and arguments, not for secrets */
  digest(text: string): string;
}

/** What every use case needs. */
export interface Deps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: Hasher;
  readonly cipher: PiiCipher;
  readonly logger: Logger;
}

/** A message leaving through a channel (a WhatsApp adapter, an SMS gateway, the fake used in tests). At least once. */
export interface OutboundMessage {
  /** stable for one outbox row: a channel that can de-duplicate uses it so a retried send is not delivered twice */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly text: string;
}

export interface OutboundChannel {
  /** resolves when the channel accepted the message, throws otherwise */
  send(message: OutboundMessage): Promise<void>;
}
