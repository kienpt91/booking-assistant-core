# Adapting this to a salon, a clinic or a consultant

The repository is a reference core, not a product. This is the order in which a client project usually goes, what to change, and what is deliberately left out.

## 1. Put the client's business into the catalog (an afternoon)

Everything business-specific is rows, not code.

```sql
-- the tenant: name, IANA time zone, language of the replies, and the rules
INSERT INTO salons (id, name, time_zone, default_language, min_lead_minutes, cancel_window_minutes, max_advance_days, slot_granularity_minutes, hold_minutes)
VALUES (gen_random_uuid(), 'Clinic X', 'Asia/Riyadh', 'ar', 120, 1440, 60, 15, 5);
-- staff members (providers), services with their duration and the buffer kept free after them
INSERT INTO services (id, salon_id, name, duration_minutes, buffer_minutes) VALUES (...);
INSERT INTO staff_services (salon_id, staff_id, service_id) VALUES (...);          -- who offers what
INSERT INTO working_hours (salon_id, staff_id, weekday, start_minute, end_minute) VALUES (...);  -- 1=Monday..7=Sunday; a lunch break is two rows
INSERT INTO time_off (salon_id, staff_id, during) VALUES (...);                    -- tstzrange
INSERT INTO salon_channels (channel, address, salon_id) VALUES ('whatsapp', '<the id the provider sends as the recipient>', '<salon id>');
```

Every table has `FORCE ROW LEVEL SECURITY` and no policy names the schema owner, so a non-superuser owner can neither read nor write these tables. Do the first onboarding of a salon (`salons`, `staff`, `services`) once, in a session of a superuser or BYPASSRLS role that is not the service's login, and keep that role out of the application. After that a staff member can maintain the catalog as `booking_staff` with the salon claim set (see `test/support/pg.ts` `withClaims`). `src/infrastructure/postgres/sample-data.ts` is the sample the tests use (run as a superuser); replace it, do not load it.

| The client is | Change |
| --- | --- |
| a salon | staff members are stylists; buffer = cleaning time; usually granularity 15 and a cancellation window of 24 hours |
| a clinic | staff members are doctors; services are visit types with their own length; a long lead time and a short horizon; consider requiring a call for first visits (the policy can refuse `book` for a service: see the policy engine below) |
| a consultant | one staff member; granularity 30 or 60; a buffer between calls; `max_advance_days` as the real booking window |
| several locations | one salon row per location (a salon is the tenant: its clients, staff and calendar are separate); one `salon_channels` row per address |

## 2. Decide the rules that are not rows

- **Booking rules** (`src/domain/rules.ts`, `availability.ts`): lead time, cancellation window, horizon, grid, buffers. Add a rule by returning a `BookingErrorCode` from `checkSlot`/`checkCancel` and a sentence for it in `messages.ts`.
- **What the assistant may do** (`src/application/assistant/policy.ts`): the tool allowlist per role, the quotas (`stateChangesPerDay`, `proposalsPerDay`), the call rate, argument limits. To forbid online booking of a service, add a rule that denies `book` for its id; the denial is audited and the model is told "not allowed".
- **Tools**: five, in `tools.ts`. A new tool means a schema, an effect (`read` or `write`), a case in the policy, and (for a write) a proposal and a confirmation path in `turn.ts` and `confirmation.ts`. Keep identity out of the arguments.

## 3. Languages and wording

Every sentence the application writes is in `src/application/assistant/messages.ts` in English and Arabic. Add a language by extending `Language` (`domain/untrusted-text.ts`), the detector, the confirmation words (`matchConfirmation`) and the `picker` in `messages.ts`. Have a native speaker review the sentences before a client sees them; the Arabic in this repository has not been reviewed. The system prompt (`prompt.ts`) is in English and tells the model to answer in the client's language.

## 4. The model

The assistant talks to an `AssistantModel` (`src/application/assistant/model.ts`): `complete(request): Promise<string>`. `HttpChatModel` implements it for an HTTP chat API (`POST {MODEL_BASE_URL}/chat/completions`, text in `choices[0].message.content`); it has only been run against a fake server. To use another service, implement the interface: send `system` and `messages`, return the text, throw on any failure, own the timeout. Whatever you use, the output must be one JSON object (`parseModelOutput`); a model that wraps it in prose is retried once, then the client is asked to rephrase. Before go-live: run `eval`-style scenarios of your own against the real model (copy `src/demo/hostile.ts`, whose scripts stand in for a compromised model) and read the audit log of a week of test conversations.

## 5. The channel

The webhook server speaks a WhatsApp-Cloud-shaped body (`infrastructure/http/whatsapp-shape.ts`); the shape is from public documentation and was never run against the real service. The usual design is a small relay you own: it receives the provider's webhook, verifies the provider's own signature, and forwards the message to `POST /webhook/messages` signed with `x-signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (`signBody` shows it). Replies go the other way: `RelayChannel` POSTs `{to, text, idempotencyKey}` to your relay, which calls the provider. Another channel (SMS, web chat) needs only a different parser; `InboundMessage` is channel-agnostic. This repository holds no provider token and makes no provider call.

## 6. Production readiness checklist

- Create the login role with a password from your secret store (docs/deployment.md), run `migrate` as the schema owner, never run the service as the owner.
- Generate `PII_KEYS`, `MESSAGE_KEYS` and `PHONE_HASH_KEY` as three different keys (`openssl rand -hex 32` each), keep them in a secret manager, back them up separately from the database. Losing `PII_KEYS` loses every number and name (the replies cannot be sent); losing `MESSAGE_KEYS` loses the queued replies and the conversation window; changing `PHONE_HASH_KEY` makes every client look new.
- Put TLS and a request limit in front of the webhook; do not trust `X-Forwarded-For` for the application's per-address limit.
- Decide the retention periods (`DEFAULT_RETENTION` in `messaging.ts`) with the client and tell them what is stored.
- Read `SECURITY.md` "What is not guaranteed" to the client.

## What is deliberately left out

No staff or owner dashboard and no login for staff (the `booking_staff` role and the staff cancel use case exist so you can build one). No payments, deposits or no-show fees. No reminders (the outbox is the place to enqueue them). No calendar sync (Google, Outlook). No multi-service bookings in one visit. No waiting list. No encryption of free text (ADR 0006). No provider SDK, no provider call, no token. No shared rate limiter between instances. These are the usual paid extensions.
