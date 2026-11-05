/** Identifiers are UUIDs. The brand keeps a client id from being passed where a salon id is expected. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SalonId = Brand<string, "SalonId">;
export type StaffId = Brand<string, "StaffId">;
export type ServiceId = Brand<string, "ServiceId">;
export type ClientId = Brand<string, "ClientId">;
export type AppointmentId = Brand<string, "AppointmentId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The canonical (lower case) form of a UUID, or undefined for anything else, including non-strings. */
export function parseUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 36) return undefined;
  const lower = value.toLowerCase();
  return UUID.test(lower) ? lower : undefined;
}

export function parseId<T extends string>(value: unknown): Brand<string, T> | undefined {
  return parseUuid(value) as Brand<string, T> | undefined;
}

/** Marks a string that is already known to be an identifier (read from the database, produced by the generator). */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}
