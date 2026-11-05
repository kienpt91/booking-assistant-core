-- A client is split in two. `clients` holds nothing personal and is what appointments point to; `client_pii` holds the
-- phone number and name and can be deleted on its own (right to erasure) without touching the booking history.
--
-- Phone numbers are stored twice, on purpose:
--   phone_hash  HMAC-SHA256 of the E.164 number with a server-side key: the only thing a lookup compares. The key lives
--               in the application's secret store, so a database dump cannot be used to test guessed numbers.
--   phone_enc   AES-256-GCM envelope of the number, written and read by the application only: needed to send a reply.
-- The database never sees a key and never sees a plain number.
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES salons (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'erased')),
  created_at timestamptz NOT NULL,
  erased_at timestamptz,
  UNIQUE (salon_id, id),
  CHECK ((status = 'erased') = (erased_at IS NOT NULL))
);

CREATE TABLE client_pii (
  client_id uuid PRIMARY KEY,
  salon_id uuid NOT NULL,
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  phone_enc text NOT NULL CHECK (phone_enc ~ '^v[0-9]+:'),
  name_enc text CHECK (name_enc IS NULL OR name_enc ~ '^v[0-9]+:'),
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id),
  UNIQUE (salon_id, phone_hash)
);
