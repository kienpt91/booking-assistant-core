# 0003. Row level security with a role and claims per transaction

Status: accepted

## Context

The owner's worry is one client seeing or changing another client's data, including through the assistant. Filtering in the application is one lock; the database should be a second one.

## Decision

Three NOLOGIN roles, none able to bypass row level security and none owning a table: `booking_client` (own rows), `booking_staff` (the salon), `booking_system` (the webhook handler and the dispatcher). The application logs in with one role that is a member of the three and starts every transaction with `SET LOCAL ROLE <role>` (the role comes from a fixed map, never from input) and `set_config('app.salon_id' ...)` for the claims. Policies read the claims through small SQL functions; a missing claim is NULL and matches nothing. All 16 tables have `ENABLE` and `FORCE ROW LEVEL SECURITY`. Grants are per command and, for appointments, per column: the identity columns cannot be updated by any application role. A trigger enforces the status machine (a cancelled appointment never comes back). Every repository query also carries the salon and, for a client, the client in its WHERE clause.

There are no SECURITY DEFINER functions. Availability needs to know when a staff member is busy but not who with, so it reads the calendar as the system role and reads the client's own appointments as the client.

## Consequences

- `test/integration/rls.test.ts` (36 tests) attacks the policies directly: cross-client and cross-tenant reads, updates, inserts, moving a row to another client, forged audit rows, a missing or malformed claim, `SET ROLE` to a role the login is not a member of.
- What this does not stop: code that can run arbitrary SQL as the login role can `SET ROLE` or `set_config` anything. Keep SQL in the repositories; a SQL injection there defeats the policies. The system role reads `client_pii` in full because the dispatcher needs the number.
