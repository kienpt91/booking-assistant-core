/**
 * Redaction for text that goes to a log, an audit record or a trace. It is deliberately blunt: a false positive
 * hides a harmless number, a false negative leaks a customer. Identifiers (UUIDs) and ISO dates survive.
 */
const DIGIT = "[0-9\\u0660-\\u0669\\u06f0-\\u06f9]";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const EMAIL = "[\\p{L}\\p{N}._%+'-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}";
const NUMBERISH = `(?<![\\p{N}+])\\+?${DIGIT}(?:[ ().-]?${DIGIT}){6,22}(?![\\p{N}])`;
const REDACTOR = new RegExp(`(${UUID})|(${EMAIL})|(${NUMBERISH})`, "gu");

function asciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces e-mail addresses, card-like numbers and phone-like numbers with a label; leaves UUIDs alone. */
export function redactText(text: string): string {
  return text.replace(REDACTOR, (match, uuid: string | undefined, email: string | undefined) => {
    if (uuid !== undefined) return match;
    if (email !== undefined) return "[email]";
    const digits = asciiDigits(match).replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "[card]";
    const explicitPlus = match.startsWith("+");
    // an ISO date (8 digits) or a short number is not a phone number; a plus or nine digits and more is
    if (digits.length >= 8 && digits.length <= 15 && (explicitPlus || digits.length >= 9)) return "[phone]";
    if (digits.length > 15) return "[number]";
    return match;
  });
}

const SENSITIVE_KEY = /phone|msisdn|e164|email|name|text|body|message|note|token|secret|password|passphrase|authorization|signature|address|card/i;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 200;

/**
 * A JSON-safe copy of `value` for logs and the audit trail: values under sensitive keys (phone, name, text, message,
 * notes, tokens, secrets...) are replaced, every other string is redacted and capped, and depth and breadth are bounded.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}...` : redacted;
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}
