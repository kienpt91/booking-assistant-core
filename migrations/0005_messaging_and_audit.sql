-- Messages the webhook has seen, so that a delivery the channel repeats is answered once. A row is "processing" while
-- a worker holds the lease and "done" afterwards; a crashed worker's lease expires and the next delivery takes over.
CREATE TABLE inbound_messages (
  salon_id uuid NOT NULL REFERENCES salons (id),
  channel text NOT NULL,
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('processing', 'done')),
  attempts integer NOT NULL DEFAULT 1,
  lease_until timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (salon_id, channel, message_id)
);

-- Replies waiting to be sent (the outbox pattern): written in the same transaction as the state change that caused
-- them, sent by a separate dispatcher, at least once. dedupe_key makes a retried webhook enqueue a reply only once.
-- The recipient is an encrypted envelope, never a plain number.
CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL,
  client_id uuid NOT NULL,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  recipient_enc text NOT NULL CHECK (recipient_enc ~ '^v[0-9]+:'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id),
  UNIQUE (salon_id, dedupe_key)
);
CREATE INDEX outbox_due_idx ON outbox_messages (salon_id, next_attempt_at) WHERE status = 'pending';

-- A short window of the conversation, so "the afternoon" can follow "which day?". Text is stored redacted (e-mail
-- addresses and phone numbers masked), capped, and deleted with the client.
CREATE TABLE conversation_turns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salon_id uuid NOT NULL,
  client_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('client', 'assistant')),
  body text NOT NULL CHECK (char_length(body) <= 2000),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id)
);
CREATE INDEX conversation_turns_client_idx ON conversation_turns (client_id, id DESC);

-- Every tool call the assistant made or was refused, with the decision and the reasons. Arguments are stored after
-- redaction (see src/domain/pii.ts), never free text and never a phone number. Append-only for the application roles.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  -- arrival order: several entries of one request share a timestamp
  seq bigint GENERATED ALWAYS AS IDENTITY,
  salon_id uuid NOT NULL REFERENCES salons (id),
  client_id uuid,
  occurred_at timestamptz NOT NULL,
  message_id text,
  step integer NOT NULL DEFAULT 0,
  event text NOT NULL CHECK (char_length(event) <= 40),
  tool text CHECK (tool IS NULL OR char_length(tool) <= 40),
  decision text CHECK (decision IS NULL OR decision IN ('allow', 'confirm', 'deny')),
  reasons text[] NOT NULL DEFAULT '{}',
  args jsonb,
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 80),
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id)
);
CREATE INDEX audit_log_client_idx ON audit_log (client_id, occurred_at);
