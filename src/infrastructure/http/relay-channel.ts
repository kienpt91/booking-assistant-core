import type { OutboundChannel, OutboundMessage } from "../../application/ports.js";

export interface RelayChannelOptions {
  /** where replies are POSTed as JSON {to, text, idempotencyKey}: a small relay you run next to the real chat provider */
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Sends replies to a relay you control, which talks to the real chat provider. This repository ships no code that calls a
 * chat provider's API and holds no provider token. The idempotency key lets the relay drop a repeated send.
 */
export class RelayChannel implements OutboundChannel {
  private readonly options: RelayChannelOptions;

  constructor(options: RelayChannelOptions) {
    this.options = options;
  }

  async send(message: OutboundMessage): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}`, "idempotency-key": message.idempotencyKey },
      body: JSON.stringify({ to: message.to, text: message.text, idempotencyKey: message.idempotencyKey }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`relay answered with status ${response.status}`);
  }
}
