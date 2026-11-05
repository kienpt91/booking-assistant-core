import type { Actor } from "../../src/domain/actor.js";
import type { ChannelDirectory, Database, Tx } from "../../src/application/store.js";

/**
 * Wraps a database so that the transactions of client actors wait just before they insert an appointment until `parties` of
 * them have arrived. Every one of them has then already read the calendar and seen the slot free: the race that the database
 * constraint has to settle is certain to happen, not left to timing.
 */
export class BarrierDatabase implements Database {
  readonly channels: ChannelDirectory;
  private readonly inner: Database;
  private readonly parties: number;
  private arrived = 0;
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(inner: Database, parties: number) {
    this.inner = inner;
    this.parties = parties;
    this.channels = inner.channels;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.released = promise;
    this.release = resolve;
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }

  transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inner.transaction(actor, (tx) => {
      if (actor.kind !== "client") return work(tx);
      const gate = async <R>(next: () => Promise<R>): Promise<R> => {
        this.arrived++;
        if (this.arrived >= this.parties) this.release();
        await this.released;
        return next();
      };
      return work({ ...tx, appointments: { ...tx.appointments, insert: (a) => gate(() => tx.appointments.insert(a)), reschedule: (id, change) => gate(() => tx.appointments.reschedule(id, change)) } });
    });
  }
}
