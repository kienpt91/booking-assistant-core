import { aad } from "../../src/application/aad.js";
import type { Deps } from "../../src/application/ports.js";
import type { NewOutbound, StoredTurn } from "../../src/application/store.js";
import type { ClientId } from "../../src/domain/ids.js";

let counter = 0;

/** A row for `outbox.enqueue` with the recipient and the text encrypted the way the application does it. */
export function outboundRow(deps: Deps, salonId: string, o: { id: string; clientId: ClientId; dedupeKey: string; to: string; text: string; now: number }): NewOutbound {
  return {
    id: o.id,
    clientId: o.clientId,
    dedupeKey: o.dedupeKey,
    recipientEnc: deps.cipher.encrypt(o.to, aad.recipient(salonId, o.id)),
    bodyEnc: deps.messageCipher.encrypt(o.text, aad.outboxBody(salonId, o.id)),
    now: o.now,
  };
}

/** A row for `conversation.append`, with a fresh uuid. */
export function turnRow(deps: Deps, salonId: string, o: { clientId: ClientId; role: "client" | "assistant"; text: string; now: number }): StoredTurn & { clientId: ClientId; now: number } {
  const id = `e5000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
  return { id, clientId: o.clientId, role: o.role, bodyEnc: deps.messageCipher.encrypt(o.text, aad.turn(salonId, id)), now: o.now };
}
