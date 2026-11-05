import type { AssistantModel, ModelRequest } from "./model.js";

/** What a scripted model answers: a fixed list (one entry per call) or a function of the request, which may inspect everything the model was shown. */
export type Script = readonly string[] | ((request: ModelRequest, call: number) => string | Promise<string>);

/**
 * A deterministic stand-in for a language model, for tests and demos. It never calls anything: it returns what the
 * script says, so a test can make it behave as well, as badly or as gullibly as it likes, and then check that the
 * application's own rules held. `requests` records everything it was shown. No hosted model is involved.
 */
export class ScriptedModel implements AssistantModel {
  readonly requests: ModelRequest[] = [];
  private calls = 0;
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    const call = this.calls++;
    if (typeof this.script === "function") return this.script(request, call);
    const answer = this.script[call];
    if (answer === undefined) throw new Error("the scripted model has no answer left");
    return answer;
  }
}

/** The JSON of a reply, as a model would send it. */
export function replyJson(text: string): string {
  return JSON.stringify({ type: "reply", text });
}

/** The JSON of a tool call, as a model would send it. */
export function toolJson(tool: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "tool_call", tool, arguments: args });
}
