# Deployment notes

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_ADMIN_URL` | `migrate` | schema owner's connection string; used only to apply the migrations |
| `DATABASE_URL` | `serve` | the application's login role (not the owner, not a superuser) |
| `PGPASSWORD` | both | database password, if it is not in a `.pgpass` file; never put a password in a URL in a file you commit |
| `PII_KEY`, `PHONE_HASH_KEY` | `serve` | 32 bytes each, hex or base64 |
| `WEBHOOK_SECRETS` | `serve` | comma-separated shared secrets, at least 32 characters, newest first; list the old one while a sender still uses it |
| `CHANNEL`, `HOST`, `PORT` | `serve` | channel name of the `salon_channels` rows (default `whatsapp`), listen address (default `127.0.0.1`), port (default 8080) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | `serve` | the HTTP chat API |
| `RELAY_URL`, `RELAY_TOKEN` | `serve` | where replies are POSTed |
| `DEFAULT_COUNTRY_CODE` | `serve` | optional, for senders whose number arrives in national form |
| `DEMO_ADMIN_URL` | `demo` | superuser URL of a throwaway server (`scripts/demo.sh` sets it up) |

A missing variable is named in the error; no value is ever printed.

## The database role

Roles are cluster-wide; the first migration creates `booking_client`, `booking_staff` and `booking_system` (it needs a role that may create roles; on a managed service run the CREATE ROLE part as the admin and the rest as the owner). Create the login role yourself:

```sql
CREATE ROLE booking_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '<from your secret store>';
GRANT booking_client, booking_staff, booking_system TO booking_app;
```

`btree_gist` must be installable (`CREATE EXTENSION`); it is part of PostgreSQL's contrib and of the common managed services. Tested on PostgreSQL 16.14 only.

## Behind a reverse proxy

Terminate TLS at the proxy and forward to `127.0.0.1:8080`. The server limits requests per socket address, so behind a proxy every sender shares the proxy's address: set a request limit at the proxy as well and size `requestsPerMinute` (`createWebhookServer`) for the proxy. The server never reads `X-Forwarded-For`. Keep the body limit (64 KiB) at the proxy too. `GET /healthz` is liveness, `GET /readyz` checks the database.

## Background jobs

`serve` runs three timers in the process: the outbox dispatcher every 2 seconds, the release of unconfirmed holds every minute, retention every hour. With several instances the database coordinates the first two (leases, `SKIP LOCKED`); running retention twice is harmless.

## Backups

Back up the database with your provider's tooling and the two keys separately, to different places: a database backup without `PII_KEY` cannot be turned back into phone numbers, which is the point. Erasure (`eraseClientByPhone`) does not reach existing backups; keep their life short or document that a restored backup must be followed by the erasures made since (the audit log records each one with its date).

## Key rotation

`PII_KEY`: the envelope names its key (`v1:k1:...`); add a second key to the key ring in `compose` and make it active; old rows still open with the first, and a script can re-encrypt them. `PHONE_HASH_KEY`: changing it makes every existing client unreachable by number; plan a re-hash from the decrypted numbers if you must. `WEBHOOK_SECRETS`: add the new secret first, switch the sender, remove the old one.
