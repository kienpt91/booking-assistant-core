import type { OutboundChannel, OutboundMessage } from "../../src/application/ports.js";

/** A channel that records what it was asked to send and fails on demand. */
export class FakeChannel implements OutboundChannel {
  readonly sent: OutboundMessage[] = [];
  failures = 0;

  async send(message: OutboundMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("simulated channel outage for +447700900001");
    }
    this.sent.push(message);
  }
}
