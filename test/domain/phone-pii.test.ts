import { describe, expect, it } from "vitest";
import { maskPhone, normalizePhone } from "../../src/domain/phone.js";
import { redactText, redactValue } from "../../src/domain/pii.js";

describe("normalizePhone", () => {
  it.each([
    ["+44 7700 900123", undefined, "+447700900123"],
    ["+44 (0) 7700-900-123", undefined, "+4407700900123"],
    ["0044 7700 900123", undefined, "+447700900123"],
    ["+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧", undefined, "+966501234567"],
    ["+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷", undefined, "+966501234567"],
    ["＋９６６５０１２３４５６７", undefined, "+966501234567"],
    ["\u200e+966 50 123 4567\u200f", undefined, "+966501234567"],
    ["07700 900123", "44", "+447700900123"],
    ["0501234567", "966", "+966501234567"],
  ])("accepts %s", (raw, cc, expected) => {
    // "+44 (0) 7700..." keeps the trunk zero: nothing here knows the numbering plans, and a wrong guess would merge two clients
    expect(normalizePhone(raw, cc)).toBe(expected);
  });

  it.each([
    ["", undefined],
    ["12345", undefined],
    ["+0123456789", undefined],
    ["+1234567", undefined],
    ["+1234567890123456", undefined],
    ["07700 900123", undefined],
    ["07700 900123", "0044"],
    ["+44 7700 CALL ME", undefined],
    ["+44 7700 900123 ext 5", undefined],
    ["+44;7700900123", undefined],
    ["'+447700900123'; drop table clients;--", undefined],
    ["+".padEnd(60, "1"), undefined],
  ])("refuses %s", (raw, cc) => {
    expect(normalizePhone(raw, cc)).toBeUndefined();
  });

  it("refuses things that are not strings", () => {
    expect(normalizePhone(undefined)).toBeUndefined();
    expect(normalizePhone(447700900123)).toBeUndefined();
    expect(normalizePhone({ toString: () => "+447700900123" })).toBeUndefined();
  });

  it("makes different spellings of one number equal", () => {
    expect(normalizePhone("+966 50 123 4567")).toBe(normalizePhone("00966501234567"));
    expect(normalizePhone("+966 50 123 4567")).toBe(normalizePhone("+٩٦٦٥٠١٢٣٤٥٦٧"));
  });
});

describe("maskPhone", () => {
  it("keeps the last two digits only", () => {
    expect(maskPhone("+966501234567")).toBe("+**********67");
    expect(maskPhone("+44")).toBe("+**");
    expect(maskPhone("+")).toBe("+**");
  });
});

describe("redactText", () => {
  it("masks e-mail addresses, phone numbers and card numbers", () => {
    expect(redactText("write to sara.k+salon@example.com please")).toBe("write to [email] please");
    expect(redactText("call +966 50 123 4567 now")).toBe("call [phone] now");
    expect(redactText("call 0501234567")).toBe("call [phone]");
    expect(redactText("رقمي ٠٥٠١٢٣٤٥٦٧")).toBe("رقمي [phone]");
    expect(redactText("card 4242 4242 4242 4242 ok")).toBe("card [card] ok");
    expect(redactText("card 4242-4242-4242-4241 ok")).toBe("card [number] ok");
  });

  it("leaves identifiers, dates and small numbers alone", () => {
    const uuid = "3f2b8c1a-0000-4000-8000-000000000001";
    expect(redactText(`appointment ${uuid} on 2026-11-05 at 10:00, 45 minutes, 3 people`)).toBe(
      `appointment ${uuid} on 2026-11-05 at 10:00, 45 minutes, 3 people`,
    );
  });

  it("masks a very long digit run without treating it as a card", () => {
    expect(redactText("1234567890123456789012")).toBe("[number]");
  });
});

describe("redactValue", () => {
  it("redacts sensitive keys and strings, whatever the nesting", () => {
    const out = redactValue({
      appointmentId: "3f2b8c1a-0000-4000-8000-000000000001",
      phone: "+966501234567",
      customer: { displayName: "Sara", note: "call me", contact: "sara@example.com" },
      list: ["+966501234567", 3, true, null],
      authorization: "Bearer abc",
    });
    expect(out).toEqual({
      appointmentId: "3f2b8c1a-0000-4000-8000-000000000001",
      phone: "[redacted]",
      customer: { displayName: "[redacted]", note: "[redacted]", contact: "[email]" },
      list: ["[phone]", 3, true, null],
      authorization: "[redacted]",
    });
  });

  it("bounds depth, breadth and string length and drops what JSON cannot hold", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      cursor["child"] = next;
      cursor = next;
    }
    expect(JSON.stringify(redactValue(deep))).toContain("[truncated]");
    expect((redactValue(Array.from({ length: 500 }, (_, i) => i)) as number[]).length).toBe(50);
    expect((redactValue("x".repeat(1000)) as string).length).toBe(203);
    expect(redactValue(Number.NaN)).toBeNull();
    expect(redactValue(() => 1)).toBe("[unsupported]");
    expect(redactValue(10n)).toBe("[unsupported]");
  });
});
