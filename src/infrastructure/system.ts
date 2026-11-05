import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator, Logger } from "../application/ports.js";
import { redactValue } from "../domain/pii.js";

export const systemClock: Clock = { now: () => Date.now() };

export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

/**
 * One JSON object per line with a timestamp, a level, an event name and the fields, which are redacted on the way out
 * (see `redactValue`): sensitive keys are replaced and strings lose e-mail addresses and phone numbers.
 */
export class JsonLogger implements Logger {
  private readonly write: (line: string) => void;
  private readonly clock: Clock;

  constructor(write: (line: string) => void, clock: Clock) {
    this.write = write;
    this.clock = clock;
  }

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("warn", event, fields);
  }

  error(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("error", event, fields);
  }

  private emit(level: string, event: string, fields: Readonly<Record<string, unknown>> | undefined): void {
    this.write(JSON.stringify({ ...(redactValue(fields ?? {}) as Record<string, unknown>), ts: new Date(this.clock.now()).toISOString(), level, event }));
  }
}
