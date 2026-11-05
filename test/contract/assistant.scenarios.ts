import { describe, expect, it } from "vitest";
import { book, listMyAppointments } from "../../src/application/booking.js";
import { replyJson, ScriptedModel, toolJson } from "../../src/application/assistant/fake-model.js";
import { receiveMessage } from "../../src/application/assistant/inbound.js";
import { DEFAULT_POLICY_CONFIG, PolicyEngine } from "../../src/application/assistant/policy.js";
import type { PiiCipher } from "../../src/application/ports.js";
import type { ServiceId, StaffId } from "../../src/domain/ids.js";
import { MINUTE } from "../../src/domain/time/instant.js";
import { at, newClient, testWorld, type TestWorld } from "../support/deps.js";
import { Chat, PHONES } from "../support/chat.js";
import { W } from "../support/seed.js";

const cut = W.cut;
const staff1 = W.staffA1;
const TUE_10 = "2026-11-10T10:00:00+00:00";
const TUE = "2026-11-10";

const book10 = toolJson("book", { service_id: cut, staff_id: staff1, starts_at: TUE_10 });

async function myAppointments(world: TestWorld, n: number) {
  const actor = await newClient(world.deps, n);
  return listMyAppointments(world.deps, actor);
}

describe("a booking conversation", () => {
  it("finds times, proposes a booking, and books only after a plain yes", async () => {
    const world = testWorld();
    const model = new ScriptedModel([
      toolJson("check_availability", { service_id: cut, date_from: TUE, staff_id: staff1 }),
      replyJson("Tuesday has 10:00 free with Staff A1. Shall I book it?"),
      book10,
    ]);
    const chat = new Chat(world.deps, model);

    const first = await chat.send(PHONES.c1, "Hi, I'd like a haircut on Tuesday", { name: "Sara" });
    expect(first).toMatchObject({ status: "processed", reply: "Tuesday has 10:00 free with Staff A1. Shall I book it?" });
    // the tool result went back to the model as labelled data, with the times in the salon's zone
    const shown = model.requests[1]?.messages.at(-1)?.content ?? "";
    expect(shown).toContain('<untrusted-data kind="tool_result">');
    expect(shown).toContain(TUE_10);

    const second = await chat.send(PHONES.c1, "10:00 please");
    expect(second.reply).toMatch(/^Book Haircut with Staff A1 on Tuesday 10 November.*10:00\? Reply YES to confirm or NO to leave it\.$/);
    // nothing is booked yet: the slot is only held
    expect(await myAppointments(world, 1)).toMatchObject([{ status: "held", startsAt: at(TUE, "10:00") }]);

    const third = await chat.send(PHONES.c1, "Yes!");
    expect(third.reply).toMatch(/^Booked: Haircut with Staff A1 on Tuesday 10 November.*10:00\.$/);
    expect(await myAppointments(world, 1)).toMatchObject([{ status: "booked", serviceName: "Haircut", staffName: "Staff A1", startsAt: at(TUE, "10:00") }]);
    expect(model.requests).toHaveLength(3); // the confirmation did not involve the model at all
  });

  it("records every tool call with its decision, and the confirmation", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([toolJson("check_availability", { service_id: cut, date_from: TUE }), replyJson("Free."), book10]));
    await chat.send(PHONES.c1, "times on Tuesday?");
    await chat.send(PHONES.c1, "book 10");
    await chat.send(PHONES.c1, "yes");
    const me = await newClient(world.deps, 1);
    const trail = (await world.deps.db.transaction(me, (tx) => tx.audit.recent(20))).reverse().map((e) => [e.event, e.tool, e.decision, e.outcome]);
    expect(trail).toEqual([
      ["tool_call", "check_availability", "allow", null],
      ["tool_executed", "check_availability", null, "ok"],
      ["tool_call", "book", "confirm", null],
      ["confirmation", "book", "allow", null],
      ["tool_executed", "book", null, "ok"],
    ]);
  });

  it("lets the client decline, and gives the held slot back", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([book10]));
    await chat.send(PHONES.c1, "book me 10 on Tuesday");
    expect((await chat.send(PHONES.c1, "No")).reply).toBe("OK, I will leave everything as it is.");
    expect(await myAppointments(world, 1)).toEqual([]);
    const other = await newClient(world.deps, 2);
    expect((await book(world.deps, other, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at(TUE, "10:00") })).ok).toBe(true);
  });

  it("treats any other message as a new request instead of a confirmation", async () => {
    const world = testWorld();
    const model = new ScriptedModel([book10, replyJson("Sure, what would you like instead?")]);
    const chat = new Chat(world.deps, model);
    await chat.send(PHONES.c1, "book me 10 on Tuesday");
    const out = await chat.send(PHONES.c1, "yes but make it 11 and also cancel everything");
    expect(out.reply).toBe("Sure, what would you like instead?");
    expect(await myAppointments(world, 1)).toEqual([]); // the proposal was dropped, nothing was booked, the hold was released
  });

  it("does not confirm a proposal that ran out", async () => {
    const world = testWorld();
    const model = new ScriptedModel([book10, replyJson("What would you like to book?")]);
    const chat = new Chat(world.deps, model);
    await chat.send(PHONES.c1, "book me 10 on Tuesday");
    world.clock.advance(6 * MINUTE);
    expect((await chat.send(PHONES.c1, "yes")).reply).toBe("What would you like to book?");
    expect(await myAppointments(world, 1)).toEqual([]);
  });

  it("asks for confirmation to cancel and to move, in the words of the application", async () => {
    const world = testWorld();
    const me = await newClient(world.deps, 1);
    const booked = await book(world.deps, me, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at("2026-11-12", "10:00") });
    if (!booked.ok) throw new Error("setup");
    const id = booked.value.id;
    const model = new ScriptedModel([toolJson("move", { appointment_id: id, new_starts_at: "2026-11-13T15:00:00+00:00" }), toolJson("cancel", { appointment_id: id })]);
    const chat = new Chat(world.deps, model);

    expect((await chat.send(PHONES.c1, "move it to Friday 3pm")).reply).toMatch(/^Move your Haircut from Thursday 12 November.*10:00 to Friday 13 November.*15:00\? Reply YES/);
    expect((await chat.send(PHONES.c1, "yes")).reply).toMatch(/^Done: your Haircut is now on Friday 13 November.*15:00\.$/);
    expect(await myAppointments(world, 1)).toMatchObject([{ startsAt: at("2026-11-13", "15:00"), version: 2 }]);

    expect((await chat.send(PHONES.c1, "actually cancel it")).reply).toMatch(/^Cancel your Haircut on Friday 13 November.*15:00\? Reply YES/);
    expect((await chat.send(PHONES.c1, "yes")).reply).toMatch(/^Done: your Haircut on Friday 13 November.*15:00 is cancelled\.$/);
    expect(await myAppointments(world, 1)).toEqual([]);
  });

  it("speaks Arabic when the client does: the proposal and the confirmation are the application's own Arabic", async () => {
    const world = testWorld();
    const me = await newClient(world.deps, 1);
    const booked = await book(world.deps, me, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at("2026-11-12", "10:00") });
    if (!booked.ok) throw new Error("setup");
    const chat = new Chat(world.deps, new ScriptedModel([toolJson("cancel", { appointment_id: booked.value.id })]));
    const ask = await chat.send(PHONES.c1, "أريد إلغاء موعدي من فضلك");
    expect(ask.reply).toMatch(/^هل تريد إلغاء موعد Haircut يوم .*الخميس.*10:00؟ أرسل «نعم» للتأكيد أو «لا» للإبقاء عليه\.$/);
    const done = await chat.send(PHONES.c1, "نعم");
    expect(done.reply).toMatch(/^تم إلغاء موعد Haircut يوم .*10:00\.$/);
    expect(await myAppointments(world, 1)).toEqual([]);
  });

  it("refuses at once what the rules refuse, in words, without asking for a confirmation", async () => {
    const world = testWorld();
    const soon = toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-09T09:30:00+00:00" });
    const offGrid = toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-10T10:07:00+00:00" });
    const outside = toolJson("book", { service_id: cut, staff_id: staff1, starts_at: "2026-11-14T10:00:00+00:00" });
    const chat = new Chat(world.deps, new ScriptedModel([soon, offGrid, outside]));
    expect((await chat.send(PHONES.c1, "book me in half an hour")).reply).toBe("That is too soon to book in chat. Please call the salon.");
    expect((await chat.send(PHONES.c1, "book 10:07")).reply).toBe("That is not one of the start times I can book. Ask me for the free times and pick one.");
    expect((await chat.send(PHONES.c1, "book saturday")).reply).toBe("That time is outside working hours.");
    expect(await myAppointments(world, 1)).toEqual([]);
  });

  it("says the time was just taken when another client holds it", async () => {
    const world = testWorld();
    const other = await newClient(world.deps, 2);
    await book(world.deps, other, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at(TUE, "10:00") });
    const chat = new Chat(world.deps, new ScriptedModel([book10]));
    expect((await chat.send(PHONES.c1, "book 10 on Tuesday")).reply).toBe("Sorry, that time was just taken. Would you like me to look for another?");
  });

  it("tells the client when the appointment changed between the proposal and the yes", async () => {
    const world = testWorld();
    const me = await newClient(world.deps, 1);
    const booked = await book(world.deps, me, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at("2026-11-12", "10:00") });
    if (!booked.ok) throw new Error("setup");
    const chat = new Chat(world.deps, new ScriptedModel([toolJson("cancel", { appointment_id: booked.value.id })]));
    await chat.send(PHONES.c1, "cancel my haircut");
    // the salon moves the appointment while the client thinks about it
    await world.deps.db.transaction({ kind: "staff", salonId: W.salonA as never, staffId: staff1 as never }, async (tx) => {
      await tx.appointments.reschedule(booked.value.id, { staffId: staff1 as never, startsAt: at("2026-11-12", "11:00"), endsAt: at("2026-11-12", "11:30"), bufferMinutes: 10, now: world.clock.now() });
    });
    expect((await chat.send(PHONES.c1, "yes")).reply).toBe("That appointment changed in the meantime. Please ask me again.");
    expect(await myAppointments(world, 1)).toMatchObject([{ status: "booked", startsAt: at("2026-11-12", "11:00") }]);
  });

  it("stops after the daily limit of confirmed changes", async () => {
    const world = testWorld();
    const me = await newClient(world.deps, 1);
    const a = await book(world.deps, me, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at("2026-11-12", "10:00") });
    const b = await book(world.deps, me, { serviceId: cut as ServiceId, staffId: staff1 as StaffId, startsAt: at("2026-11-12", "14:00") });
    if (!a.ok || !b.ok) throw new Error("setup");
    const chat = new Chat(world.deps, new ScriptedModel([toolJson("cancel", { appointment_id: a.value.id }), toolJson("cancel", { appointment_id: b.value.id })]), {
      policy: new PolicyEngine({ ...DEFAULT_POLICY_CONFIG, stateChangesPerDay: 1 }),
    });
    await chat.send(PHONES.c1, "cancel the first");
    expect((await chat.send(PHONES.c1, "yes")).reply).toMatch(/is cancelled\.$/);
    expect((await chat.send(PHONES.c1, "cancel the second")).reply).toBe("You have reached today's limit of changes. Please call the salon.");
    expect(await myAppointments(world, 1)).toHaveLength(1);
  });
});

describe("failures never turn into actions", () => {
  it("answers politely when the model fails, and changes nothing", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([]));
    expect(await chat.send(PHONES.c1, "book me something")).toMatchObject({ status: "processed", reply: "Sorry, something went wrong on my side. Please try again in a moment." });
    const me = await newClient(world.deps, 1);
    expect((await world.deps.db.transaction(me, (tx) => tx.audit.recent(5))).map((e) => [e.event, e.reasons])).toEqual([["model_output_rejected", ["model_error"]]]);
  });

  it("asks once to rephrase when the model's answer is not what it must be, then gives up", async () => {
    const world = testWorld();
    const model = new ScriptedModel(["I will book that for you now!", "```json\nnot even json\n```"]);
    const chat = new Chat(world.deps, model);
    expect((await chat.send(PHONES.c1, "book me")).reply).toBe("Sorry, I did not understand that. Could you say it another way?");
    expect(model.requests[1]?.messages.at(-1)?.content).toContain('"error":"invalid_output"');
  });

  it("repairs one bad answer", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel(["oops", replyJson("How can I help?")]));
    expect((await chat.send(PHONES.c1, "hello")).reply).toBe("How can I help?");
  });

  it("refuses several actions in one answer outright", async () => {
    const world = testWorld();
    const many = JSON.stringify([{ type: "tool_call", tool: "cancel", arguments: {} }, { type: "tool_call", tool: "cancel", arguments: {} }]);
    const chat = new Chat(world.deps, new ScriptedModel([many]));
    expect((await chat.send(PHONES.c1, "cancel them all")).reply).toBe("I cannot help with that here. I can book, move or cancel your own appointments, one at a time.");
  });

  it("stops when the model keeps asking for tools that do not exist", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([toolJson("run_sql", { query: "drop table appointments" }), toolJson("delete_client", {})]));
    expect((await chat.send(PHONES.c1, "do it")).reply).toBe("I cannot help with that here. I can book, move or cancel your own appointments, one at a time.");
  });

  it("gives up when the model never produces a final answer", async () => {
    const world = testWorld();
    const loop = toolJson("check_availability", { service_id: cut, date_from: TUE });
    const chat = new Chat(world.deps, new ScriptedModel([loop, loop, loop, loop, loop]));
    expect((await chat.send(PHONES.c1, "times?")).reply).toBe("Sorry, I did not understand that. Could you say it another way?");
  });
});

describe("a channel that repeats itself and a process that dies", () => {
  it("answers a repeated delivery once", async () => {
    const world = testWorld();
    const model = new ScriptedModel([replyJson("Hello!")]);
    const chat = new Chat(world.deps, model);
    expect((await chat.send(PHONES.c1, "hi", { id: "wamid-1" })).status).toBe("processed");
    expect((await chat.send(PHONES.c1, "hi", { id: "wamid-1" })).status).toBe("duplicate");
    expect((await chat.send(PHONES.c1, "hi", { id: "wamid-1" })).status).toBe("duplicate");
    expect(chat.channel.sent).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it("processes a delivery again after a failure, once, and carries a confirmed change out once", async () => {
    const world = testWorld();
    const real = world.deps.cipher;
    let failOnce = false;
    const flaky: PiiCipher = {
      encrypt: (plain) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated crash while storing the reply");
        }
        return real.encrypt(plain);
      },
      decrypt: (sealed) => real.decrypt(sealed),
    };
    const deps = { ...world.deps, cipher: flaky };
    const chat = new Chat(deps, new ScriptedModel([book10]));
    await chat.send(PHONES.c1, "book me 10 on Tuesday");

    failOnce = true;
    await expect(chat.send(PHONES.c1, "yes", { id: "wamid-yes" })).rejects.toThrow("simulated crash");
    // the confirmation was carried out before the crash, but its answer was never stored
    expect((await myAppointments(world, 1))[0]?.status).toBe("booked");

    const retry = await chat.send(PHONES.c1, "yes", { id: "wamid-yes" });
    expect(retry).toMatchObject({ status: "processed" });
    expect(retry.reply).toMatch(/^Booked: Haircut with Staff A1/);
    expect(chat.channel.sent.filter((m) => m.text.startsWith("Booked:"))).toHaveLength(1);
    expect(await myAppointments(world, 1)).toHaveLength(1);
    expect((await chat.send(PHONES.c1, "yes", { id: "wamid-yes" })).status).toBe("duplicate");
    // the quota counts the executed change once, not once per attempt
    const me = await newClient(world.deps, 1);
    const executed = (await world.deps.db.transaction(me, (tx) => tx.audit.recent(50))).filter((e) => e.event === "tool_executed" && e.tool === "book");
    expect(executed).toHaveLength(1);
  });

  it("lets a delivery be taken over once the lease of a dead worker has run out", async () => {
    const world = testWorld();
    const system = { kind: "system", salonId: W.salonA as never } as const;
    await world.deps.db.transaction(system, (tx) => tx.inbox.claim("chat", "wamid-dead", world.clock.now(), 2 * MINUTE));
    const chat = new Chat(world.deps, new ScriptedModel([replyJson("Hello again!")]));
    expect((await chat.send(PHONES.c1, "hi", { id: "wamid-dead" })).status).toBe("duplicate"); // another worker may still be on it
    world.clock.advance(3 * MINUTE);
    expect(await chat.send(PHONES.c1, "hi", { id: "wamid-dead" })).toMatchObject({ status: "processed", reply: "Hello again!" });
  });
});

describe("what the pipeline accepts", () => {
  it("rejects malformed messages without touching anything", async () => {
    const world = testWorld();
    const model = new ScriptedModel([]);
    const chat = new Chat(world.deps, model);
    const deps = world.deps;
    const base = { channel: "chat", messageId: "m1", to: "salon-a", from: PHONES.c1, text: "hi" };
    const runtime = chat.runtime;
    for (const bad of [
      { ...base, channel: "Chat!" },
      { ...base, messageId: "" },
      { ...base, messageId: "a b" },
      { ...base, messageId: "x".repeat(201) },
      { ...base, to: "x".repeat(65) },
      { ...base, from: "not a number" },
      { ...base, from: "07700 900001" },
      { ...base, from: 5 as unknown as string },
    ]) {
      expect((await receiveMessage(deps, runtime, bad)).status, JSON.stringify(bad)).toBe("invalid");
    }
    expect((await receiveMessage(deps, runtime, { ...base, to: "nobody" })).status).toBe("unknown_recipient");
    expect(model.requests).toHaveLength(0);
  });

  it("accepts a national number when the country is configured", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([replyJson("Hi!")]), { defaultCountryCode: "44" });
    expect((await chat.send("07700 900001", "hello")).reply).toBe("Hi!");
    expect(await myAppointments(world, 1)).toEqual([]); // the same client as +44 7700 900001
  });

  it("answers a message that is not text, empty, or too long without calling the model", async () => {
    const world = testWorld();
    const model = new ScriptedModel([]);
    const chat = new Chat(world.deps, model);
    expect((await chat.send(PHONES.c1, undefined)).reply).toBe("Please write your request as a text message.");
    expect((await chat.send(PHONES.c1, { sticker: true })).reply).toBe("Please write your request as a text message.");
    expect((await chat.send(PHONES.c1, "\u200b\u200e  \u202e")).reply).toBe("Please write your request as a text message.");
    expect((await chat.send(PHONES.c1, "x".repeat(1_001))).reply).toBe("That message is too long for me. Could you send a shorter one?");
    expect((await chat.send(PHONES.c1, "ا".repeat(5_000))).reply).toBe("هذه الرسالة طويلة جدًا. هل يمكنك إرسال رسالة أقصر؟");
    expect(model.requests).toHaveLength(0);
  });

  it("slows a client who sends too many messages and stays silent", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel(() => replyJson("ok")));
    const statuses: string[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await chat.send(PHONES.c1, `hello ${i}`)).status);
    expect(statuses.filter((s) => s === "processed")).toHaveLength(20);
    expect(statuses.slice(20)).toEqual(["rate_limited", "rate_limited"]);
    expect(chat.channel.sent).toHaveLength(20);
    world.clock.advance(61_000);
    expect((await chat.send(PHONES.c1, "hello again")).status).toBe("processed");
  });

  it("keeps a short conversation, stored without e-mail addresses and phone numbers, and shows it to the model", async () => {
    const world = testWorld();
    const model = new ScriptedModel([replyJson("Noted."), replyJson("Anything else?")]);
    const chat = new Chat(world.deps, model);
    await chat.send(PHONES.c1, "my email is sara@example.com and my other number is +966 50 123 4567");
    await chat.send(PHONES.c1, "thanks");
    const earlier = model.requests[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(earlier).toContain("my email is [email] and my other number is [phone]");
    expect(earlier).not.toContain("sara@example.com");
    expect(earlier).not.toContain("123 4567");
  });

  it("masks phone numbers and e-mail addresses in what the model writes, but not times and ids", async () => {
    const world = testWorld();
    const chat = new Chat(world.deps, new ScriptedModel([replyJson("Call +966 50 123 4567 or mail owner@salon.example. Tuesday 2026-11-10 at 10:00, appointment 3f2b8c1a-0000-4000-8000-000000000001.")]));
    expect((await chat.send(PHONES.c1, "who do I call?")).reply).toBe("Call [phone] or mail [email]. Tuesday 2026-11-10 at 10:00, appointment 3f2b8c1a-0000-4000-8000-000000000001.");
  });
});
