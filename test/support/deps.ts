import { randomBytes } from "node:crypto";
import type { Clock, Deps, IdGenerator } from "../../src/application/ports.js";
import { resolveClient } from "../../src/application/clients.js";
import type { ClientActor } from "../../src/domain/actor.js";
import { asId, type SalonId } from "../../src/domain/ids.js";
import { normalizePhone } from "../../src/domain/phone.js";
import type { Instant } from "../../src/domain/time/instant.js";
import { AesGcmCipher, HmacHasher } from "../../src/infrastructure/crypto.js";
import { JsonLogger } from "../../src/infrastructure/system.js";
import type { Database } from "../../src/application/store.js";
import { MemoryDatabase } from "./memory-db.js";
import { W } from "./seed.js";

export class FakeClock implements Clock {
  private t: Instant;

  constructor(start: Instant) {
    this.t = start;
  }

  now(): Instant {
    return this.t;
  }

  set(t: Instant): void {
    this.t = t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

/** Identifiers 00000000-0000-4000-8000-000000000001, ...000002 and so on: stable across runs. */
export class SequentialIds implements IdGenerator {
  private n = 0;

  next(): string {
    this.n++;
    return `e0000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

/** Monday 2026-11-09 09:00 in London (winter time, UTC+0). */
export const MONDAY_9 = Date.UTC(2026, 10, 9, 9, 0);

/** An instant on a London winter day: `at("2026-11-10", "10:30")`. London is UTC+0 from late October to late March. */
export function at(date: string, time: string): Instant {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return Date.UTC(y, m - 1, d, h, mi);
}

export interface TestWorld {
  readonly deps: Deps;
  readonly clock: FakeClock;
  readonly db: MemoryDatabase;
  readonly logs: string[];
}

/** Dependencies for the use cases over the in-memory database, with real encryption and hashing and keys made at run time. */
export function testWorld(over: { db?: Database; now?: Instant } = {}): TestWorld {
  const clock = new FakeClock(over.now ?? MONDAY_9);
  const db = new MemoryDatabase();
  const logs: string[] = [];
  const deps: Deps = {
    db: over.db ?? db,
    clock,
    ids: new SequentialIds(),
    hasher: new HmacHasher(randomBytes(32)),
    cipher: new AesGcmCipher({ k1: randomBytes(32) }, "k1"),
    logger: new JsonLogger((line) => logs.push(line), clock),
  };
  return { deps, clock, db, logs };
}

/** A client of salon A with a made-up number +44 7700 9000NN. */
export async function newClient(deps: Deps, n: number, salon: string = W.salonA, name?: string): Promise<ClientActor> {
  const phone = normalizePhone(`+44 7700 9000${String(n).padStart(2, "0")}`);
  if (!phone) throw new Error("bad test phone");
  return (await resolveClient(deps, asId<"SalonId">(salon) as SalonId, phone, name)).actor;
}
