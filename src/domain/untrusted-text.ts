/**
 * Text written by a client (a message, a profile name, an appointment note) is data, never instructions. Three small
 * tools: clean it before it is stored or shown to the model, flag blunt injection attempts for the audit trail, and
 * recognise a plain yes or no. None of them is a security boundary: the boundary is the policy engine, which does
 * not read this text.
 */
export interface SanitizedText {
  readonly text: string;
  /** a character was removed or replaced */
  readonly changed: boolean;
  readonly truncated: boolean;
}

// controls, format characters (zero width, bidi overrides, soft hyphen, tag characters), private use, unassigned, lone surrogates
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu;

export function sanitizeUntrusted(input: unknown, maxCodePoints: number): SanitizedText {
  if (typeof input !== "string") return { text: "", changed: input !== undefined && input !== null, truncated: false };
  // bound the work first: nobody needs the normal form of ten megabytes
  const bounded = input.length > maxCodePoints * 4 ? input.slice(0, maxCodePoints * 4) : input;
  const cleaned = bounded.normalize("NFKC").replace(INVISIBLE, (c) => (c === "\n" || c === "\t" || c === "\r" ? " " : "")).replace(/\s+/gu, " ").trim();
  const points = Array.from(cleaned);
  const truncated = points.length > maxCodePoints || bounded.length < input.length;
  const text = points.length > maxCodePoints ? points.slice(0, maxCodePoints).join("") : cleaned;
  return { text, changed: cleaned !== input || truncated, truncated };
}

const INJECTION_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["override_instructions", /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b.{0,40}\b(instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?)\b/i],
  ["role_markup", /<\/?\s*(system|assistant|tool|developer|instructions?|admin|client|user)\b|\[\/?(system|inst)\]|<\|[a-z_]+\|>|^\s*(system|assistant|developer)\s*:/im],
  ["claims_authority", /\bi\s*(?:am|'m)\s+(?:the\s+|a\s+)?(owner|admin|administrator|manager|developer|staff|salon\s+owner)\b/i],
  ["prompt_extraction", /\b(system|hidden|initial|secret)\s+prompt\b|\byour\s+(?:instructions|rules)\b|\brepeat\s+(?:the\s+)?(?:text|words)\s+above\b/i],
  ["other_client_data", /\b(previous|last|other|another|next)\s+(client|customer)\b.{0,40}\b(number|phone|name|appointment|booking|details)\b|\b(number|phone|name|appointments?|bookings?|details)\b.{0,40}\b(previous|last|other|another|next)\s+(client|customer)\b/i],
  ["bulk_action", /\b(all|every|everyone'?s?|each)\b.{0,24}\b(bookings?|appointments?|clients?|customers?)\b|\b(cancel|delete|remove|wipe)\b.{0,12}\b(everything|everyone|all)\b/i],
  ["override_instructions", /تجاهل.{0,30}(التعليمات|الأوامر|القواعد)|انسَ?\s+.{0,20}(التعليمات|القواعد)/u],
  ["claims_authority", /أنا\s+(?:ال)?(مالك|مالكة|مدير|مديرة|صاحب|صاحبة|مسؤول)/u],
  ["other_client_data", /(رقم|اسم|حجز).{0,25}(العميل|الزبون|العميلة)\s+(السابق|الآخر|التالي)/u],
  ["bulk_action", /(كل|جميع)\s+(ال)?(حجوزات|مواعيد|عملاء|زبائن)/u],
];

/** The names of the blunt injection patterns found in the text (empty when none). Used to flag, never to allow. */
export function injectionFlags(text: string): string[] {
  const hit = new Set<string>();
  for (const [name, pattern] of INJECTION_RULES) if (pattern.test(text)) hit.add(name);
  return [...hit];
}

export type Language = "en" | "ar";

/** Arabic when Arabic letters outnumber Latin letters, English otherwise. Used to pick a reply template. */
export function detectLanguage(text: string): Language {
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\p{Script=Arabic}/u.test(ch) && /\p{L}/u.test(ch)) arabic++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  return arabic > latin ? "ar" : "en";
}

function plain(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const YES = new Set(["yes", "y", "yep", "yeah", "yup", "ok", "okay", "sure", "confirm", "confirmed", "yes please", "yes confirm", "please confirm", "نعم", "ايوه", "ايوا", "اوكي", "تمام", "موافق", "اكد", "تاكيد", "نعم اكد", "نعم تاكيد", "نعم من فضلك", "اكد الحجز"]);
const NO = new Set(["no", "n", "nope", "nah", "no thanks", "no thank you", "not now", "never mind", "dont", "stop", "لا", "كلا", "لا شكرا", "لا تحجز"]);

/**
 * "yes" or "no" only when the whole message is a plain answer. "yes, but make it five" is neither: it is a new request,
 * so it goes through the model and the policy again instead of confirming what was asked before.
 */
export function matchConfirmation(text: string): "yes" | "no" | undefined {
  const answer = plain(text);
  if (YES.has(answer)) return "yes";
  if (NO.has(answer)) return "no";
  return undefined;
}
