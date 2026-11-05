import type { Instant } from "../domain/time/instant.js";
import type { Clock, OutboundChannel, OutboundMessage } from "./ports.js";

/** A clock that can be moved: what the demo and the hostile suite need to reach the end of a hold without waiting. */
export interface ControllableClock extends Clock {
  set(at: Instant): void;
  advance(ms: number): void;
}

/**
 * The fake transport: an outbound channel that keeps what it was asked to send. This is what stands in for a real chat provider
 * in the tests and the demo; no message ever leaves the process.
 */
export class RecordingChannel implements OutboundChannel {
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}
