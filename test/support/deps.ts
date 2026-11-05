import { randomBytes } from "node:crypto";
import { resolveClient } from "../../src/application/clients.js";
import type { Clock, Deps, IdGenerator } from "../../src/application/ports.js";
import type { Database } from "../../src/application/store.js";
import type { ClientActor } from "../../src/domain/actor.js";
import { asId, type SalonId } from "../../src/domain/ids.js";
import { normalizePhone } from "../../src/domain/phone.js";
import type { Instant } from "../../src/domain/time/instant.js";
import { AesGcmCipher, HmacHasher } from "../../src/infrastructure/crypto.js";
import { JsonLogger } from "../../src/infrastructure/system.js";
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

/** Identifiers e0000000-0000-4000-8000-000000000001, ...000002 and so on: stable across runs. */
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

/**
 * Where the use case scenarios run. The default is the in-memory double; the PostgreSQL suites register a backend over a
 * real database, so that the same scenarios prove the double and the real thing agree.
 */
export interface Backend {
  create(): Database;
  addTimeOff(db: Database, staffId: string, start: Instant, end: Instant): Promise<void>;
}

const memoryBackend: Backend = {
  create: () => new MemoryDatabase(),
  addTimeOff: async (db, staffId, start, end) => (db as MemoryDatabase).addTimeOff(staffId, { start, end }),
};

let backend: Backend = memoryBackend;

export function useBackend(next: Backend | undefined): void {
  backend = next ?? memoryBackend;
}

export interface TestWorld {
  readonly deps: Deps;
  readonly clock: FakeClock;
  readonly db: Database;
  readonly logs: string[];
  addTimeOff(staffId: string, start: Instant, end: Instant): Promise<void>;
}

export interface MemoryWorld extends TestWorld {
  readonly db: MemoryDatabase;
}

function build(db: Database, now: Instant | undefined): { deps: Deps; clock: FakeClock; logs: string[] } {
  const clock = new FakeClock(now ?? MONDAY_9);
  const logs: string[] = [];
  const deps: Deps = {
    db,
    clock,
    ids: new SequentialIds(),
    hasher: new HmacHasher(randomBytes(32)),
    cipher: new AesGcmCipher({ k1: randomBytes(32) }, "k1"),
    logger: new JsonLogger((line) => logs.push(line), clock),
  };
  return { deps, clock, logs };
}

/** Dependencies for the use cases on the current backend, with real encryption and hashing and keys made at run time. */
export function testWorld(over: { now?: Instant } = {}): TestWorld {
  const db = backend.create();
  return { ...build(db, over.now), db, addTimeOff: (staffId, start, end) => backend.addTimeOff(db, staffId, start, end) };
}

/** The same, always on the in-memory double, for tests that look inside it. */
export function memoryWorld(over: { now?: Instant } = {}): MemoryWorld {
  const db = new MemoryDatabase();
  return { ...build(db, over.now), db, addTimeOff: async (staffId, start, end) => db.addTimeOff(staffId, { start, end }) };
}

/** A client of salon A with a made-up number +44 7700 9000NN. */
export async function newClient(deps: Deps, n: number, salon: string = W.salonA, name?: string): Promise<ClientActor> {
  const phone = normalizePhone(`+44 7700 9000${String(n).padStart(2, "0")}`);
  if (!phone) throw new Error("bad test phone");
  return (await resolveClient(deps, asId<"SalonId">(salon) as SalonId, phone, name)).actor;
}
