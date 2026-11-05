# 0005. Retries are normal: dedupe on the way in, an outbox on the way out, keys in between

Status: accepted

## Context

Chat providers deliver a webhook more than once, workers die, networks drop. The owner must not get two bookings or two replies, and must not lose a reply.

## Decision

- Inbound: `inbound_messages` (salon, channel, message id) is claimed with a lease. A repeated delivery is a duplicate; a worker that died is taken over after its lease. On an unexpected failure the claim is released and the error is rethrown, so the channel's retry processes the message again.
- State changes carry idempotency keys (`idempotency_keys`, serialised with an advisory lock, per client): the same key and request returns the stored answer, the same key with another request is refused, a refusal is never stored. The key of a confirmed proposal derives from the proposal id.
- Outbound: the reply, the conversation turns and the completion of the inbound message are written in one transaction; the reply goes into `outbox_messages` with a dedupe key. A dispatcher leases due rows (`FOR UPDATE SKIP LOCKED`), sends outside any transaction, and retries with a growing delay until a row is dead. Delivery is at least once; the outbox id is the idempotency key for a channel that can drop a repeat.
- A confirmation is carried out before its reply is stored and the proposal is marked used after, so a crash in between replays the stored answer instead of losing the reply. The audit entry of an executed change has a deterministic id, so a replay is not counted twice against the daily quota.

## Consequences

Tested in `test/contract/assistant.scenarios.ts` (repeated delivery, crash and retry, lease takeover), `test/integration/concurrency.test.ts` (30 simultaneous deliveries, five dispatchers over 40 messages, 20 simultaneous identical bookings) and `test/application/clients-messaging.test.ts` (backoff, dead letters, leases).
