# Deployment notes

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_ADMIN_URL` | `migrate` | schema owner's connection string; used only to apply the migrations |
| `DATABASE_URL` | `serve` | the application's login role (not the owner, not a superuser) |
| `PGPASSWORD` | both | database password, if it is not in a `.pgpass` file; never put a password in a URL in a file you commit |
| `PII_KEYS`, `MESSAGE_KEYS` | `serve` | key rings of 32 random bytes (hex or canonical base64): `id=key,id2=key2` with the active key first, or one bare key. `PII_KEYS` encrypts phone numbers, names and recipients; `MESSAGE_KEYS` encrypts reply and conversation text |
| `PHONE_HASH_KEY` | `serve` | 32 random bytes: the key of the phone lookup hash. The three keys must all differ |
| `WEBHOOK_REQUESTS_PER_MINUTE`, `WEBHOOK_MAX_BODY_BYTES`, `WEBHOOK_TOLERANCE_SECONDS` | `serve` | authenticated requests per sender address (default 600), body limit (default 65536), signature tolerance (default 300) |
| `TRUSTED_PROXY_HOPS` | `serve` | reverse proxies in front that append to `X-Forwarded-For` (default 0: the header is ignored); with 1, the sender address is the entry the proxy added |
| `WEBHOOK_SECRETS` | `serve` | comma-separated shared secrets, at least 32 characters, newest first; list the old one while a sender still uses it |
| `CHANNEL`, `HOST`, `PORT` | `serve` | channel name of the `salon_channels` rows (default `whatsapp`), listen address (default `127.0.0.1`), port (default 8080) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | `serve` | the HTTP chat API; the URL must be https (http only for localhost). The prompt carries the client's name, messages and notes to this provider |
| `RELAY_URL`, `RELAY_TOKEN` | `serve` | where replies are POSTed; the URL must be https (http only for localhost) |
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

Terminate TLS at the proxy and forward to `127.0.0.1:8080`. The server counts authenticated requests per sender address, after the signature is verified, so unsigned traffic from the proxy's address cannot use up the relay's budget; failed signatures are counted per address only to answer 429 and to stop logging, and never block a valid one. Set `TRUSTED_PROXY_HOPS=1` when exactly one proxy sits in front and writes `X-Forwarded-For`: the sender address is then the entry that proxy added, and a value the client wrote is ignored. Leave it at 0 otherwise: the header is then ignored, so a spoofed one buys nothing. Flood protection for unauthenticated traffic is the proxy's job (request rate, connection limits, a body limit of 64 KiB or less); this server bounds the work per request (body size, read timeouts) but does not rate-limit unsigned requests. `GET /healthz` is liveness, `GET /readyz` checks the database.

## Database connection

Use `sslmode=verify-full` (and a CA file) in `DATABASE_URL` unless the database is on the same host; the URL carries the user, the password goes in `PGPASSWORD` or a `.pgpass` file.

## Background jobs

`serve` runs three timers in the process: the outbox dispatcher every 2 seconds, the release of unconfirmed holds every minute, retention every hour. With several instances the database coordinates the first two (leases, `SKIP LOCKED`); running retention twice is harmless.

## Backups

Back up the database with your provider's tooling and the two keys separately, to different places: a database backup without `PII_KEY` cannot be turned back into phone numbers, which is the point. Erasure (`eraseClientByPhone`) does not reach existing backups; keep their life short or document that a restored backup must be followed by the erasures made since (the audit log records each one with its date).

## Key rotation

`PII_KEYS` and `MESSAGE_KEYS` are rings: put the new key first (`k2=<new>,k1=<old>`) and restart; new data is written with `k2`, old rows still open with `k1`. A script that reads each row and writes it again re-encrypts them, after which `k1` can be removed (a value is bound to its row, so re-encrypt in place, never by copying between rows). `PHONE_HASH_KEY` has no key id: changing it makes every existing client unreachable by number, so re-hash from the decrypted numbers first. `WEBHOOK_SECRETS`: add the new secret first, switch the sender, remove the old one.
