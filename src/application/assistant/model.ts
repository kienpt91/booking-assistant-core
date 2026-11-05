import { err, ok, type Result } from "../../domain/result.js";
import type { ToolSpec } from "./tools.js";

export interface ModelMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
}

/**
 * The integration point for a language model. Implement `complete` with whatever service you use (see docs/adapting.md):
 * send `system` and `messages`, return the text the model produced. The model is given no tools of its own and no
 * credentials; its answer is untrusted text that this package parses and checks before anything happens. An
 * implementation owns the timeout and the retry of the network call, and must throw rather than return partial output.
 */
export interface AssistantModel {
  complete(request: ModelRequest): Promise<string>;
}

export type ModelAction =
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "tool_call"; readonly tool: unknown; readonly arguments: unknown };

export type ModelOutputProblem = "empty" | "too_large" | "not_json" | "multiple_actions" | "not_an_object" | "unknown_type" | "invalid_shape";

export const MAX_MODEL_OUTPUT = 8_000;
export const MAX_REPLY_LENGTH = 1_500;

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/**
 * The model must answer with exactly one JSON object: {"type":"reply","text":"..."} or
 * {"type":"tool_call","tool":"...","arguments":{...}}. One level of ```json fencing is tolerated. A list of actions,
 * two objects, extra keys, prose around the JSON and anything oversized are refused.
 */
export function parseModelOutput(raw: string): Result<ModelAction, ModelOutputProblem> {
  if (raw.length > MAX_MODEL_OUTPUT) return err("too_large");
  let body = raw.trim();
  if (body === "") return err("empty");
  const fenced = FENCE.exec(body);
  if (fenced) body = (fenced[1] ?? "").trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return err(/\}\s*\{/.test(body) ? "multiple_actions" : "not_json");
  }
  if (Array.isArray(value)) return err("multiple_actions");
  if (typeof value !== "object" || value === null) return err("not_an_object");
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (record["type"] === "reply") {
    const text = record["text"];
    if (keys.length !== 2 || typeof text !== "string" || text.trim() === "" || text.length > MAX_REPLY_LENGTH) return err("invalid_shape");
    return ok({ type: "reply", text });
  }
  if (record["type"] === "tool_call") {
    if (keys.some((k) => k !== "type" && k !== "tool" && k !== "arguments") || typeof record["tool"] !== "string") return err("invalid_shape");
    return ok({ type: "tool_call", tool: record["tool"], arguments: record["arguments"] });
  }
  return err("unknown_type");
}
