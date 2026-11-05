import type { Instant } from "../../domain/time/instant.js";

/**
 * A sliding-window rate limiter with bounded memory: at most `max` hits per key in any `windowMs`, at most `maxKeys` keys
 * (the least recently used key is forgotten first) and at most `max` timestamps per key. State is in this process only: for
 * several instances put a shared limit in front (see docs/deployment.md); the daily quotas live in the database and are shared.
 */
export class SlidingWindowLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, Instant[]>();

  constructor(windowMs: number, max: number, maxKeys = 10_000) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
  }

  /** Records a hit and returns whether it is within the limit. A refused hit is not recorded. */
  hit(key: string, now: Instant): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.delete(key);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.hits.size;
  }
}
