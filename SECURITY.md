# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository, or email kienphan.dev@gmail.com. Do not open a public issue for a vulnerability. This is a personal open-source reference project maintained on a best-effort basis: no service level and no bounty. It has not been used in production and has not had an independent security review.

## What this is

A channel-agnostic booking core for a chat assistant (the WhatsApp transport is a fake and a relay interface), with PostgreSQL as the system of record. The owner's four worries, and what answers each:

1. two clients booking the same moment, 2. one client seeing or changing another's data, 3. leaks of names and numbers, 4. the AI acting wrongly on the booking system.

## Threat model

Every claim names a test that fails if the claim stops being true. Paths are relative to `test/`.

| Threat | What the code does | Test |
| --- | --- | --- |
| Two clients book one slot at the same moment | Exclusion constraints on staff time (buffer included) and on client time; the application maps the violation to `slot_unavailable` | `integration/concurrency.test.ts`: 50 racing clients give 1 booking and 49 conflicts (with a barrier, without, with a pool of 5); the same race with the constraints dropped books all 50; `integration/schema.test.ts` (overlap, buffer, held vs cancelled, moves) |
| A move, a cancel and a booking race each other | Row lock on the appointment, constraint on the new time, version check, status checked before version | `integration/concurrency.test.ts` (move vs cancel x30, two moves onto one slot, move vs book, 10 simultaneous confirmations) |
| A retried request books twice | Idempotency keys serialised by an advisory lock; refusals are not stored; keys are per client | `contract/booking.scenarios.ts` ("with an idempotency key"), `integration/concurrency.test.ts` (20 identical keyed bookings give one row) |
| A client reads or changes another client's appointment | Row level security (own rows only), column grants, scoped queries | `integration/rls.test.ts` ("a client"), `integration/adapter.pg.test.ts` ("isolation through the adapter"), hostile scenarios `cancel-by-guessed-id`, `identity-argument` |
| A client reaches another salon's data | Salon claim in every policy, composite foreign keys that refuse cross-salon links | `integration/schema.test.ts` ("refuses to link rows of two salons"), `integration/rls.test.ts`, hostile scenario `other-salon` |
| A request without an identity reads anything | Claims are NULL, comparisons with NULL never match; a malformed claim errors | `integration/rls.test.ts` ("without an identity"), `integration/adapter.pg.test.ts` (forged actor) |
| The database role is too powerful | Roles are not superuser, cannot bypass RLS, own no table; `FORCE ROW LEVEL SECURITY` | `integration/rls.test.ts` ("the roles") |
| The model names who is acting ("I am the owner", a `client_id` argument) | No identity argument exists; a call carrying one is refused and flagged; the identity is the authenticated sender | `application/assistant-core.test.ts` (parseToolCall), hostile scenarios `i-am-the-owner`, `identity-argument`, `arabic-owner-claim` |
| The model is steered by text in a message, a profile name or a note | Untrusted text is cleaned, capped and put in escaped data blocks; the policy never reads it; every state change needs the client's own "yes" | hostile scenarios `injection-in-name`, `injection-in-notes`, `unicode-tricks`, `fake-confirmation`; `domain/untrusted-text.test.ts` |
| The model acts in bulk or calls tools that do not exist | One JSON object per answer; five tools; one proposal per message; daily quotas; unknown tools refused | `application/assistant-core.test.ts`, hostile scenarios `cancel-everyone`, `unknown-tools`, `bulk-in-one-message`, `daily-limit` |
| A stored proposal is edited so that a "yes" does something else | Digest of tool and arguments checked before execution, policy asked again | hostile scenario `tampered-proposal` |
| A fake or confused model breaks isolation without the suite noticing | The suite has a negative control: with client isolation removed it must fail | `application/hostile.test.ts` ("notices when client isolation is missing") |
| Another client's number or name reaches the model or the reply | The model is never shown it; numbers and e-mail addresses in the model's text are masked | hostile scenario `previous-client-number`, `contract/assistant.scenarios.ts` ("masks phone numbers") |
| Numbers and names stored or logged in the clear | Phone and name encrypted (AES-256-GCM) and the phone hashed (HMAC); logs and audit arguments redacted; error messages are fixed sentences | `infrastructure/crypto-system.test.ts`, `integration/adapter.pg.test.ts` ("never reaches the database in the clear": scans every text column), `domain/phone-pii.test.ts` |
| A client asks to be forgotten | `eraseClient` removes personal data, conversation, queued replies, proposals, stored answers and notes, and cancels future appointments | `integration/adapter.pg.test.ts` ("erases a client"), `application/clients-messaging.test.ts` |
| Old data is kept for ever | `applyRetention` | `integration/adapter.pg.test.ts`, `application/clients-messaging.test.ts` |
| A webhook is forged, replayed or oversized | HMAC-SHA256 over the raw bytes with a timestamp, constant-time compare, tolerance 5 minutes, rotating secrets; message-id dedupe; body limit; per-address rate limit | `infrastructure/http.test.ts`; demo section 4 |
| A webhook is delivered twice, or a worker dies half way | Inbox claim with a lease, outbox in the same transaction, replay of confirmed changes | `contract/assistant.scenarios.ts` ("a channel that repeats itself and a process that dies"), `integration/concurrency.test.ts` |
| Errors leak internals | The server answers `internal_error` and logs the error class only; model and relay errors carry a status only | `infrastructure/http.test.ts`, `infrastructure/http.test.ts` ("model and relay adapters") |
| A secret reaches the repository | Secret scanner on commit, push and in CI (tree and history); keys come from the environment | `scripts/secret-scan.sh`; CI job `secret-scan` |
| A dependency is compromised or brand new | One runtime dependency (`pg`), exact pins, every package at least 7 days old at the pin, installs without lifecycle scripts, pinned images and action SHAs | `scripts/check-dep-age.mjs`; CI job `dependency-age` |

## What is not guaranteed

- **Free text.** Replies and the conversation window may contain a name the model repeated ("Noted, Sara."), and appointment notes are free text; they are stored unencrypted (numbers and e-mail addresses are masked) until erasure or retention removes them. See ADR 0006.
- **The database login role.** Anyone who can run arbitrary SQL as it can `SET ROLE` to another application role or set the claims. The policies protect against a missing WHERE clause or a wrong id in application code, not against a SQL injection in the repositories (all statements use bind parameters). The system role reads `client_pii`, including the encrypted number, because the dispatcher needs it.
- **The model's free text.** The application writes every sentence that announces or confirms a change; the model's own sentences are only masked for numbers and addresses and can still be wrong or misleading (it can say "done" when nothing was done).
- **The heuristics.** The injection flags are regular expressions used for the audit trail only. A paraphrase passes them; nothing relies on them.
- **Rate limits** on messages and tool calls are in this process; run several instances and each has its own. The webhook limit is per socket address, so behind a proxy all senders share the proxy's address: limit at the proxy as well (docs/deployment.md). Daily quotas are in the database and are shared.
- **The WhatsApp payload shape** is written from public documentation and has never been run against the real service; no provider token or API call exists in this repository. The model adapter has only been run against a fake HTTP server.
- **Language.** The Arabic sentences are mine and have not been reviewed by a native speaker. Date formatting follows ICU.
- **Time zones** are tested for New York, London, Lord Howe and Kolkata, with explicit rules for the hour that does not exist and the hour that happens twice (docs in `src/domain/time/zone.ts`); not for every zone.
- **Deadlocks.** Competing bookings are serialised per client and staff member to avoid them; any that still happen are retried three times and then surface as an error.
- **Backups** contain whatever the database contains; erasure does not reach them (docs/deployment.md).

## Dependency policy

- One runtime dependency, `pg`; everything else is a development dependency. Exact versions in `package.json`, a committed `package-lock.json`, every package resolved with `npm install --before=2026-10-24T00:00:00Z --ignore-scripts --save-exact` (90 locked packages, none newer than the cutoff). CI uses `npm ci --ignore-scripts`. Dependabot (npm and github-actions, weekly, 7-day cooldown) ignores major bumps of `typescript` and `@types/node`.
- Container images are pinned by digest: Node 24.14.1 (`scripts/node.sh`) and PostgreSQL 16.14 (`scripts/integration.sh`, `scripts/demo.sh`, CI), built more than seven days before they were pinned. GitHub Actions are pinned to full commit SHAs, with read-only permissions; the release job gets `contents: write`, `id-token: write` and `attestations: write` and uses only `GITHUB_TOKEN`.
