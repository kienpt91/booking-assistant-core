import { dispatchAll } from "../../src/application/messaging.js";
import { createRuntime, receiveMessage, type AssistantRuntime, type ReceiveResult } from "../../src/application/assistant/inbound.js";
import type { AssistantModel } from "../../src/application/assistant/model.js";
import type { Deps } from "../../src/application/ports.js";
import { FakeChannel } from "./channel.js";

export const PHONES = {
  c1: "+44 7700 900001",
  c2: "+44 7700 900002",
  c3: "+44 7700 900003",
} as const;

/** A conversation driver: sends messages through the real inbound pipeline and delivers the replies through a fake channel. */
export class Chat {
  readonly channel = new FakeChannel();
  readonly runtime: AssistantRuntime;
  private readonly deps: Deps;
  private counter = 0;

  constructor(deps: Deps, model: AssistantModel, runtime?: Partial<Omit<AssistantRuntime, "model">>) {
    this.deps = deps;
    this.runtime = createRuntime(model, runtime);
  }

  /** Sends one message and returns the processing status and the reply that was delivered (undefined when there was none). */
  async send(from: string, text: unknown, options: { to?: string; name?: string; id?: string } = {}): Promise<ReceiveResult & { reply: string | undefined }> {
    const before = this.channel.sent.length;
    const result = await receiveMessage(this.deps, this.runtime, {
      channel: "chat",
      messageId: options.id ?? `msg-${++this.counter}`,
      to: options.to ?? "salon-a",
      from,
      text,
      senderName: options.name,
    });
    await dispatchAll(this.deps, this.channel);
    return { ...result, reply: this.channel.sent.length > before ? this.channel.sent.at(-1)?.text : undefined };
  }
}
