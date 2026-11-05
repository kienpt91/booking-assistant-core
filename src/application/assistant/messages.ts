import type { BookingErrorCode } from "../../domain/errors.js";
import type { Instant } from "../../domain/time/instant.js";
import type { Language } from "../../domain/untrusted-text.js";

/**
 * Every sentence the application itself writes to a client, in English and Arabic. Anything that changes a booking is
 * announced and confirmed with these, never with text the model wrote, so a model cannot misdescribe what is about to
 * happen or what happened. The model only writes the free conversation (questions, listing times).
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** "Tuesday 10 November, 10:00" in the salon's zone; Arabic names of days and months with Latin digits. */
export function formatWhen(zone: string, at: Instant, language: Language): string {
  const key = `${zone}|${language}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(language === "ar" ? "ar-u-nu-latn" : "en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(key, f);
  }
  return f.format(at);
}

export interface Described {
  readonly service: string;
  readonly staff: string;
  readonly when: string;
}

type Pick = <T>(en: T, ar: T) => T;

const picker =
  (language: Language): Pick =>
  (en, ar) =>
    language === "ar" ? ar : en;

export const say = {
  confirmBook(language: Language, d: Described): string {
    const t = picker(language);
    return t(`Book ${d.service} with ${d.staff} on ${d.when}? Reply YES to confirm or NO to leave it.`, `هل تريد حجز ${d.service} مع ${d.staff} يوم ${d.when}؟ أرسل «نعم» للتأكيد أو «لا» للإلغاء.`);
  },
  confirmMove(language: Language, d: { service: string; from: string; to: string }): string {
    const t = picker(language);
    return t(`Move your ${d.service} from ${d.from} to ${d.to}? Reply YES to confirm or NO to leave it.`, `هل تريد نقل موعد ${d.service} من ${d.from} إلى ${d.to}؟ أرسل «نعم» للتأكيد أو «لا» لتركه كما هو.`);
  },
  confirmCancel(language: Language, d: { service: string; when: string }): string {
    const t = picker(language);
    return t(`Cancel your ${d.service} on ${d.when}? Reply YES to confirm or NO to keep it.`, `هل تريد إلغاء موعد ${d.service} يوم ${d.when}؟ أرسل «نعم» للتأكيد أو «لا» للإبقاء عليه.`);
  },
  booked(language: Language, d: Described): string {
    const t = picker(language);
    return t(`Booked: ${d.service} with ${d.staff} on ${d.when}.`, `تم تأكيد حجزك: ${d.service} مع ${d.staff} يوم ${d.when}.`);
  },
  moved(language: Language, d: { service: string; to: string }): string {
    const t = picker(language);
    return t(`Done: your ${d.service} is now on ${d.to}.`, `تم نقل موعد ${d.service} إلى ${d.to}.`);
  },
  cancelled(language: Language, d: { service: string; when: string }): string {
    const t = picker(language);
    return t(`Done: your ${d.service} on ${d.when} is cancelled.`, `تم إلغاء موعد ${d.service} يوم ${d.when}.`);
  },
  declined(language: Language): string {
    return picker(language)("OK, I will leave everything as it is.", "حسنًا، سأترك كل شيء كما هو.");
  },
  genericError(language: Language): string {
    return picker(language)("Sorry, something went wrong on my side. Please try again in a moment.", "عذرًا، حدث خطأ من جهتي. يرجى المحاولة مرة أخرى بعد قليل.");
  },
  cannotUnderstand(language: Language): string {
    return picker(language)("Sorry, I did not understand that. Could you say it another way?", "عذرًا، لم أفهم طلبك. هل يمكنك إعادة صياغته؟");
  },
  notAllowed(language: Language): string {
    return picker(language)(
      "I cannot help with that here. I can book, move or cancel your own appointments, one at a time.",
      "لا أستطيع المساعدة في ذلك هنا. يمكنني حجز مواعيدك أو نقلها أو إلغاءها، موعدًا واحدًا في كل مرة.",
    );
  },
  tooManyMessages(language: Language): string {
    return picker(language)("You are sending messages very fast. Please wait a moment and try again.", "أنت ترسل الرسائل بسرعة كبيرة. يرجى الانتظار قليلًا ثم المحاولة مرة أخرى.");
  },
  tooLong(language: Language): string {
    return picker(language)("That message is too long for me. Could you send a shorter one?", "هذه الرسالة طويلة جدًا. هل يمكنك إرسال رسالة أقصر؟");
  },
  textOnly(language: Language): string {
    return picker(language)("Please write your request as a text message.", "يرجى كتابة طلبك كرسالة نصية.");
  },
  /** why the rules refused, in words a client can act on */
  refusal(language: Language, code: BookingErrorCode): string {
    const t = picker(language);
    switch (code) {
      case "slot_unavailable":
        return t("Sorry, that time was just taken. Would you like me to look for another?", "عذرًا، هذا الوقت لم يعد متاحًا. هل تريد أن أبحث عن وقت آخر؟");
      case "client_overlap":
        return t("You already have an appointment at that time.", "لديك موعد آخر في هذا الوقت.");
      case "not_on_grid":
        return t("That is not one of the start times I can book. Ask me for the free times and pick one.", "هذا ليس من أوقات الحجز المتاحة. اطلب مني الأوقات الفارغة واختر واحدًا منها.");
      case "outside_working_hours":
        return t("That time is outside working hours.", "هذا الوقت خارج ساعات العمل.");
      case "time_off":
        return t("That staff member is not available then.", "الموظف غير متاح في هذا الوقت.");
      case "in_the_past":
        return t("That time has already passed.", "هذا الوقت قد مضى.");
      case "lead_time":
        return t("That is too soon to book in chat. Please call the salon.", "هذا الوقت قريب جدًا للحجز عبر المحادثة. يرجى الاتصال بالصالون.");
      case "too_far_ahead":
        return t("That is too far ahead to book yet.", "هذا الموعد بعيد جدًا للحجز الآن.");
      case "cancellation_window":
        return t("It is too late to change that appointment in chat. Please call the salon.", "فات وقت تعديل هذا الموعد عبر المحادثة. يرجى الاتصال بالصالون.");
      case "not_found":
        return t("I could not find that appointment.", "لم أجد هذا الموعد.");
      case "not_active":
        return t("That appointment is no longer active.", "هذا الموعد لم يعد قائمًا.");
      case "stale":
        return t("That appointment changed in the meantime. Please ask me again.", "تغيّر هذا الموعد في الأثناء. يرجى طلبه مرة أخرى.");
      case "hold_expired":
        return t("The reservation timed out. Please ask me again.", "انتهت مهلة الحجز المؤقت. يرجى طلبه مرة أخرى.");
      case "quota_exceeded":
        return t("You have reached today's limit of changes. Please call the salon.", "لقد وصلت إلى الحد اليومي للتغييرات. يرجى الاتصال بالصالون.");
      case "invalid_input":
      case "forbidden":
      case "idempotency_mismatch":
        return t("Sorry, I could not do that.", "عذرًا، لم أستطع تنفيذ ذلك.");
    }
  },
};
