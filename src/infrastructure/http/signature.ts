import { createHmac, timingSafeEqual } from "node:crypto";

/** The header looks like `t=1762678800,v1=<64 hex>`: a Unix time in seconds and the HMAC-SHA256 of "<t>.<raw body>" with the shared secret. */
const HEADER = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

export type SignatureVerdict = "ok" | "malformed" | "stale" | "mismatch";

function mac(secret: string, seconds: string, body: Buffer): Buffer {
  return createHmac("sha256", secret).update(seconds).update(".").update(body).digest();
}

/** Builds the header a sender must send. Used by tests, the demo and any relay you write. */
export function signBody(secret: string, atMs: number, body: Buffer | string): string {
  const seconds = String(Math.floor(atMs / 1000));
  return `t=${seconds},v1=${mac(secret, seconds, Buffer.from(body)).toString("hex")}`;
}

/**
 * Checks a webhook signature over the exact bytes received. Every secret in the list is tried (so the secret can be rotated
 * without downtime) and the comparison is constant-time. A signature older or newer than `toleranceMs` is refused, which limits
 * how long a captured request can be replayed; the message-id de-duplication is what stops a replay inside the window.
 */
export function verifySignature(header: string | undefined, body: Buffer, secrets: readonly string[], nowMs: number, toleranceMs: number): SignatureVerdict {
  const match = header === undefined ? null : HEADER.exec(header);
  if (!match) return "malformed";
  const [, seconds, given] = match as unknown as [string, string, string];
  const givenBytes = Buffer.from(given, "hex");
  let matched = false;
  for (const secret of secrets) {
    // no early exit: the time taken does not say which secret matched
    if (timingSafeEqual(mac(secret, seconds, body), givenBytes)) matched = true;
  }
  if (!matched) return "mismatch";
  return Math.abs(nowMs - Number(seconds) * 1000) > toleranceMs ? "stale" : "ok";
}
