# 0006. Personal data: separate, keyed, encrypted, redacted, erasable

Status: accepted

## Decision

- `clients` holds nothing personal; `client_pii` holds the phone number and the profile name and can be deleted alone. The phone number is stored as an HMAC-SHA256 with a server-side key (the lookup) and as an AES-256-GCM envelope (to send a reply); the name as an envelope. Keys come from the environment; the database never sees one. Envelopes name their key, so keys can be rotated.
- Numbers are normalised to E.164 (Arabic-Indic digits and full-width forms included) before hashing, so every spelling of a number is one client.
- Logs and audit arguments go through `redactValue`: sensitive keys are replaced, strings lose e-mail addresses, card-like and phone-like numbers (UUIDs and ISO dates survive). The conversation window stores text after the same masking. Error messages are fixed sentences keyed by a code; none carries data.
- Erasure (`eraseClient`, `eraseClientByPhone`): deletes the personal data, the conversation, queued replies, pending proposals and stored answers; cancels future appointments; removes the notes; keeps the shape of the history under a client id that points to nobody, and the audit log (which holds no personal data). Retention (`applyRetention`) deletes old conversation text, sent replies, message ids, stored answers, proposals and audit rows.

## Known gaps (stated, not hidden)

Free text is not encrypted: the reply text in `outbox_messages.body` and `conversation_turns.body` (a model reply can address the client by name; numbers and e-mail addresses are masked) and the notes on appointments. They are removed by erasure and retention. `test/integration/adapter.pg.test.ts` scans every text column of the database after a full conversation and allows exactly those two columns to contain a name. If your threat model needs more, encrypt those columns in the repositories with the same cipher.
