import type { Brand } from "./ids.js";

/** A phone number in E.164 form: "+" and 8 to 15 digits, no spaces, no leading zero after the plus. */
export type E164 = Brand<string, "E164">;

const FORMAT_AND_SPACING = /[\s\u00a0\u200e\u200f\u202a-\u202e\u2066-\u2069().-]/gu;
const ARABIC_INDIC = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_INDIC = /[\u06f0-\u06f9]/g;
const DIGITS = /^[1-9][0-9]{7,14}$/;

/**
 * Turns what a chat channel delivers into E.164, or returns undefined. Accepts "+44 7700 900123", "0044 7700 900123",
 * full-width and Arabic-Indic digits ("+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧"), and a national number with one leading zero when the caller
 * names the country calling code ("07700 900123" with "44"). Nothing else is guessed: letters, extensions and numbers
 * without a country are refused. This is a shape check, not a check that the number is assigned.
 */
export function normalizePhone(raw: unknown, defaultCountryCode?: string): E164 | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 40) return undefined;
  // "+44 (0) 7700 ..." writes the trunk digit that the international form drops. Which digit that is depends on the country, so the
  // number is refused rather than turned into a second client for the same person.
  if (/\(\s*0\s*\)/.test(raw)) return undefined;
  const text = raw
    .normalize("NFKC")
    .replace(FORMAT_AND_SPACING, "")
    .replace(ARABIC_INDIC, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (c) => String(c.charCodeAt(0) - 0x06f0));
  let digits: string;
  if (text.startsWith("+")) digits = text.slice(1);
  else if (text.startsWith("00")) digits = text.slice(2);
  else if (defaultCountryCode !== undefined && /^[1-9][0-9]{0,2}$/.test(defaultCountryCode) && /^0[1-9]/.test(text)) {
    digits = defaultCountryCode + text.slice(1);
  } else return undefined;
  return DIGITS.test(digits) ? (`+${digits}` as E164) : undefined;
}

/** "+966501234567" becomes "+**********67": enough to tell two numbers of one client apart in a support call, not to call. */
export function maskPhone(phone: string): string {
  const digits = phone.startsWith("+") ? phone.slice(1) : phone;
  if (digits.length <= 2) return "+**";
  return `+${"*".repeat(digits.length - 2)}${digits.slice(-2)}`;
}
