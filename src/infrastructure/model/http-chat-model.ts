import type { AssistantModel, ModelRequest } from "../../application/assistant/model.js";

export interface HttpChatModelOptions {
  /** base URL of an HTTP chat API that accepts `POST {baseUrl}/chat/completions` with messages and returns `choices[0].message.content` */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  /** replaceable for tests */
  readonly fetch?: typeof fetch;
}

/**
 * The integration point for a hosted model, over plain HTTP with the global fetch (no SDK). It sends the system prompt and the
 * conversation, with tool results as labelled user messages (the assistant uses a JSON protocol, not a vendor tool-calling API),
 * and returns the text of the first choice. It has only been run against a fake HTTP server in this repository, never against
 * a hosted service. Errors carry the HTTP status only: never the body, which could hold the conversation.
 */
export class HttpChatModel implements AssistantModel {
  private readonly options: HttpChatModelOptions;

  constructor(options: HttpChatModelOptions) {
    this.options = options;
  }

  async complete(request: ModelRequest): Promise<string> {
    const send = this.options.fetch ?? fetch;
    const response = await send(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        max_tokens: this.options.maxTokens ?? 600,
        messages: [{ role: "system", content: request.system }, ...request.messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content }))],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`model request failed with status ${response.status}`);
    const json: unknown = await response.json();
    const content = typeof json === "object" && json !== null && "choices" in json && Array.isArray(json.choices) ? (json.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined;
    if (typeof content !== "string") throw new Error("model response had no text");
    return content;
  }
}
