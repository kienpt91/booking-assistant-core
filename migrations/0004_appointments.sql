-- Appointments. The two exclusion constraints are the guarantee against double booking: PostgreSQL itself refuses a
-- second blocking row for the same staff member whose time overlaps, whatever the application does and however many
-- transactions race. The application checks availability first only to give a friendly answer.
CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  client_id uuid NOT NULL,
  service_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('held', 'booked', 'cancelled', 'expired', 'completed')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- copied from the service when the appointment is made, so later edits of the service do not rewrite history
  buffer_minutes integer NOT NULL CHECK (buffer_minutes BETWEEN 0 AND 240),
  -- ends_at plus the buffer: the time the appointment occupies for the staff member. A CHECK, not a generated column,
  -- because timestamptz + interval is not immutable and a generated column must be.
  blocked_until timestamptz NOT NULL,
  hold_expires_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  CHECK (ends_at > starts_at),
  CHECK (blocked_until = ends_at + make_interval(mins => buffer_minutes)),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- the staff member, client and service must all belong to the appointment's salon
  FOREIGN KEY (salon_id, staff_id) REFERENCES staff (salon_id, id),
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id),
  FOREIGN KEY (salon_id, service_id) REFERENCES services (salon_id, id),
  -- one staff member cannot be in two places: held and booked rows may not overlap, buffer included
  CONSTRAINT appointments_staff_no_overlap EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  ) WHERE (status IN ('held', 'booked')),
  -- nor can a client
  CONSTRAINT appointments_client_no_overlap EXCLUDE USING gist (
    client_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('held', 'booked'))
);
CREATE INDEX appointments_client_upcoming_idx ON appointments (client_id, starts_at) WHERE status IN ('held', 'booked');
CREATE INDEX appointments_salon_idx ON appointments (salon_id, starts_at);

-- The status machine, enforced by the database too: a cancelled or expired appointment never comes back, and nothing
-- skips a step. A row can change in place (notes scrubbed, time moved) while its status stays the same.
CREATE FUNCTION appointments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.salon_id <> OLD.salon_id OR NEW.client_id <> OLD.client_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'appointment identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'held' AND NEW.status IN ('booked', 'expired', 'cancelled'))
    OR (OLD.status = 'booked' AND NEW.status IN ('cancelled', 'completed'))
  ) THEN
    RAISE EXCEPTION 'appointment status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER appointments_guard BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_guard();

-- What the assistant proposed and is waiting for the client to confirm. One active proposal per client. The arguments
-- were validated before they were stored, and the digest ties the confirmation to exactly those arguments.
CREATE TABLE pending_actions (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL,
  client_id uuid NOT NULL,
  tool text NOT NULL CHECK (tool IN ('book', 'move', 'cancel')),
  args jsonb NOT NULL,
  args_digest text NOT NULL,
  hold_appointment_id uuid REFERENCES appointments (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'declined', 'superseded', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id)
);
CREATE UNIQUE INDEX pending_actions_one_active ON pending_actions (client_id) WHERE status = 'active';

-- Retry safety for the use cases: the same key with the same request returns the stored answer instead of acting twice.
-- actor_id is the client (or staff member) that made the request, so a key can never replay another actor's answer.
CREATE TABLE idempotency_keys (
  salon_id uuid NOT NULL REFERENCES salons (id),
  actor_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (salon_id, actor_id, key)
);
