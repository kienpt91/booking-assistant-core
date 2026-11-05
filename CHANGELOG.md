# Changelog

## 0.1.0

First release.

- PostgreSQL schema in plain SQL migrations (`migrations/`): salons as tenants, staff, services, working hours, time off, clients split from encrypted personal data, appointments with exclusion constraints against double booking, pending proposals, idempotency keys, inbox, outbox, audit log; row level security on every table with three roles.
- Use cases: availability, hold, book, confirm, move, cancel, list, client registration, right to erasure, outbox dispatch, hold release, retention. Time zone and daylight saving rules, lead time, cancellation window, horizon, buffers.
- Assistant: five tools with strict schemas, policy engine, application-written confirmations in English and Arabic, audit of every call, scripted model for tests, `HttpChatModel` and `RelayChannel` adapters for a real deployment.
- Webhook server on `node:http` with HMAC verification, timestamp tolerance, size and rate limits, and a parser for a WhatsApp-shaped payload.
- `booking-assistant-core migrate | serve | demo`; `scripts/demo.sh` runs the concurrency proof and the hostile conversations against a throwaway container.
- Tests: 532 (380 without a database), coverage in the README.
