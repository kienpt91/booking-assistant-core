import { err, ok, type Result } from "../../domain/result.js";
import { field, object, type Issue, type Parsed } from "./schema.js";

/**
 * The whole tool surface of the assistant: five tools, each with a strict argument schema. There is no argument that
 * names a client, a salon, a phone number or a role: the acting identity is the authenticated sender of the chat message
 * and is added by the application, never by the model. A model that supplies one anyway has its call refused.
 */
export const TOOL_NAMES = ["check_availability", "book", "move", "cancel", "my_appointments"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolEffect = "read" | "write";

const schemas = {
  check_availability: object({
    service_id: field.uuid("the id of one of the services"),
    date_from: field.date("first date to search, YYYY-MM-DD"),
    date_to: field.optional(field.date("last date to search, YYYY-MM-DD; defaults to date_from")),
    staff_id: field.optional(field.uuid("the id of a staff member who offers the service")),
  }),
  book: object({
    service_id: field.uuid("the id of one of the services"),
    staff_id: field.uuid("the id of a staff member, copied from check_availability"),
    starts_at: field.instant("start time, copied from check_availability"),
    notes: field.optional(field.text(200, "a short note from the client, at most 200 characters")),
  }),
  move: object({
    appointment_id: field.uuid("the id of one of the client's appointments, from my_appointments"),
    new_starts_at: field.instant("new start time, copied from check_availability"),
    staff_id: field.optional(field.uuid("another staff member who offers the service")),
  }),
  cancel: object({
    appointment_id: field.uuid("the id of one of the client's appointments, from my_appointments"),
  }),
  my_appointments: object({}),
};

export type ToolArgs = { [N in ToolName]: Parsed<(typeof schemas)[N]["shape"]> };
export type ToolCall = { [N in ToolName]: { readonly tool: N; readonly args: ToolArgs[N] } }[ToolName];

export interface ToolDefinition {
  readonly effect: ToolEffect;
  readonly description: string;
}

export const TOOLS: Readonly<Record<ToolName, ToolDefinition>> = {
  check_availability: { effect: "read", description: "List free start times for a service between two dates." },
  book: { effect: "write", description: "Ask to book one appointment. The client is asked to confirm before anything is booked." },
  move: { effect: "write", description: "Ask to move one of the client's appointments. The client is asked to confirm first." },
  cancel: { effect: "write", description: "Ask to cancel one of the client's appointments. The client is asked to confirm first." },
  my_appointments: { effect: "read", description: "List the client's upcoming appointments." },
};

export interface ToolSpec {
  readonly name: ToolName;
  readonly effect: ToolEffect;
  readonly description: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export function toolSpecs(): ToolSpec[] {
  return TOOL_NAMES.map((name) => ({
    name,
    effect: TOOLS[name].effect,
    description: TOOLS[name].description,
    arguments: Object.fromEntries(Object.entries(schemas[name].shape).map(([key, f]) => [key, f.describe])),
  }));
}

export type ToolRejection =
  | { readonly kind: "unknown_tool" }
  | { readonly kind: "invalid_arguments"; readonly issues: readonly Issue[]; readonly identityOverride: boolean };

/** Keys that try to name who is acting. Matched after lower-casing and dropping punctuation: "Client-ID" and "clientId" are the same. */
const IDENTITY_KEYS = new Set(["clientid", "client", "salonid", "salon", "tenantid", "tenant", "phone", "phonenumber", "msisdn", "sender", "user", "userid", "role", "actor", "identity", "owner", "admin", "onbehalfof"]);

function isIdentityKey(name: string): boolean {
  return IDENTITY_KEYS.has(name.toLowerCase().replace(/[^a-z]/g, ""));
}

/** Validates a tool name and its arguments. Never throws, never echoes a value. */
export function parseToolCall(tool: unknown, args: unknown): Result<ToolCall, ToolRejection> {
  if (typeof tool !== "string" || !Object.hasOwn(schemas, tool)) return err({ kind: "unknown_tool" });
  const name = tool as ToolName;
  const parsed = schemas[name].parse(args === undefined ? {} : args);
  if (!parsed.ok) {
    const given = typeof args === "object" && args !== null ? Object.keys(args) : [];
    const identityOverride = given.some((key) => !Object.hasOwn(schemas[name].shape, key) && isIdentityKey(key));
    return err({ kind: "invalid_arguments", issues: parsed.error, identityOverride });
  }
  return ok({ tool: name, args: parsed.value } as ToolCall);
}
