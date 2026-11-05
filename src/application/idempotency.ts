import { canonicalJson } from "./canonical.js";
import { refuse, succeed, type Outcome } from "./outcome.js";
import type { Hasher } from "./ports.js";
import type { Tx } from "./store.js";
import type { Instant } from "../domain/time/instant.js";

const KEY = /^[\x21-\x7e]{1,200}$/;

/** Printable ASCII, 1 to 200 characters: what a client or an inbound message id can safely be. */
export function isValidIdempotencyKey(key: string): boolean {
  return KEY.test(key);
}

/**
 * Makes a state change safe to retry. With a key: the first request runs and its successful answer is stored in the same
 * transaction as the change; the same key and request later returns that answer without acting again; the same key with
 * a different request is refused. Requests with the same key are serialised, so two copies of a retry arriving together
 * cannot both act. Refusals are not stored: a retry after "that time is taken" is evaluated again.
 */
export async function idempotent<T>(
  tx: Tx,
  hasher: Hasher,
  now: Instant,
  key: string | undefined,
  request: unknown,
  run: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  if (key === undefined) return run();
  if (!isValidIdempotencyKey(key)) return refuse("invalid_input");
  await tx.idempotency.lock(key);
  const digest = hasher.digest(canonicalJson(request));
  const seen = await tx.idempotency.find(key);
  if (seen) return seen.requestDigest === digest ? succeed(seen.response as T) : refuse("idempotency_mismatch");
  const result = await run();
  if (result.ok) await tx.idempotency.store(key, digest, result.value, now);
  return result;
}
