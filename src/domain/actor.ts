import type { ClientId, SalonId, StaffId } from "./ids.js";

/**
 * Who is acting. It is built from what the transport authenticated (the sender of a chat message, a signed-in staff
 * member, the system itself) and is never read from the model's output or from a request body.
 */
export type Actor =
  | { readonly kind: "client"; readonly salonId: SalonId; readonly clientId: ClientId }
  | { readonly kind: "staff"; readonly salonId: SalonId; readonly staffId: StaffId }
  | { readonly kind: "system"; readonly salonId: SalonId };

export type ClientActor = Extract<Actor, { kind: "client" }>;
export type StaffActor = Extract<Actor, { kind: "staff" }>;
export type SystemActor = Extract<Actor, { kind: "system" }>;

export function systemOf(actor: Actor): SystemActor {
  return { kind: "system", salonId: actor.salonId };
}
