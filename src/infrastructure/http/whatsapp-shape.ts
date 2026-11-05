import type { InboundMessage } from "../../application/assistant/inbound.js";

/**
 * Reads a webhook body shaped like the WhatsApp Cloud API's (`entry[].changes[].value.messages[]`) into channel-agnostic messages.
 * This is the SHAPE only, written from public documentation and never run against the real service: a relay or adapter that
 * speaks to the real API is the part you write for a client (docs/adapting.md). The salon is found from `metadata.phone_number_id`
 * through the `salon_channels` table; a message that is not text arrives with undefined text and is answered with "please send text".
 * Returns undefined when the body is not of this shape.
 */
const MAX_ENTRIES = 20;
const MAX_MESSAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWebhookPayload(body: unknown, channel: string): InboundMessage[] | undefined {
  if (!isRecord(body) || body["object"] !== "whatsapp_business_account" || !Array.isArray(body["entry"]) || body["entry"].length > MAX_ENTRIES) return undefined;
  const out: InboundMessage[] = [];
  for (const entry of body["entry"]) {
    if (!isRecord(entry) || !Array.isArray(entry["changes"])) return undefined;
    for (const change of entry["changes"]) {
      if (!isRecord(change) || change["field"] !== "messages" || !isRecord(change["value"])) continue;
      const value = change["value"];
      const metadata = value["metadata"];
      const to = isRecord(metadata) ? metadata["phone_number_id"] : undefined;
      if (typeof to !== "string" || !Array.isArray(value["messages"]) || value["messages"].length > MAX_MESSAGES) return undefined;
      const names = new Map<string, string>();
      for (const contact of Array.isArray(value["contacts"]) ? value["contacts"] : []) {
        if (isRecord(contact) && typeof contact["wa_id"] === "string" && isRecord(contact["profile"]) && typeof contact["profile"]["name"] === "string") names.set(contact["wa_id"], contact["profile"]["name"]);
      }
      for (const message of value["messages"]) {
        if (!isRecord(message) || typeof message["id"] !== "string" || typeof message["from"] !== "string") return undefined;
        const text = message["type"] === "text" && isRecord(message["text"]) && typeof message["text"]["body"] === "string" ? message["text"]["body"] : undefined;
        out.push({
          channel,
          messageId: message["id"],
          to,
          from: /^\d{8,15}$/.test(message["from"]) ? `+${message["from"]}` : message["from"],
          text,
          senderName: names.get(message["from"]),
        });
      }
    }
  }
  return out;
}
