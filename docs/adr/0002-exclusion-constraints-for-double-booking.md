# 0002. The database refuses double bookings; the application only gives friendly answers

Status: accepted

## Context

Two clients can ask for the same slot in the same millisecond. A check ("is it free?") followed by an insert has a gap; anything built on it books the slot twice under load.

## Decision

`appointments` has two exclusion constraints (extension `btree_gist`): one staff member cannot have two `held` or `booked` rows whose time overlaps, the buffer after the appointment included (`blocked_until = ends_at + buffer`, enforced by a CHECK); one client cannot either. Cancelled, expired and completed rows do not block. The application checks availability first, only to answer politely, and maps the constraint violation (`23P01`, by constraint name) to `slot_unavailable` or `client_overlap`. Inserts run inside a savepoint so the transaction survives the refusal.

A hold (`held`, five minutes by default) reserves a slot while the client confirms; unconfirmed holds are released by the next booking attempt (`releaseExpiredHolds`) and by a timer, because a constraint cannot read the clock.

Competing inserts for the same staff member or client take transaction-scoped advisory locks first (client, then staff). Without them, two overlapping inserts wait on each other's uncommitted rows and PostgreSQL resolves the deadlock by aborting one after a second. The locks only avoid that wait; the constraints stay the arbiter.

## Consequences

- `test/integration/concurrency.test.ts`: 50 clients, one slot, a barrier that makes every attempt pass its own availability check first: exactly one success and 49 `slot_unavailable`; the same without the barrier and with a pool of five; a control with the constraints dropped, where all 50 succeed (so the test can fail).
- A transaction that hits a deadlock or serialization failure anyway is run again up to three times (`PostgresDatabase.transaction`, tested).
- Working hours, time off, lead time and the cancellation window are application rules: the database cannot know "now" or the salon's calendar. They are tested in `test/domain/rules-availability.test.ts`.
