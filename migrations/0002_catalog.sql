-- Salons are the tenants. Every other table carries salon_id, and the composite foreign keys below make it
-- impossible to link a row of one salon to a staff member, service or client of another.
CREATE TABLE salons (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- IANA zone name; every working hour and every date shown to a client is read in this zone
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' AND char_length(time_zone) <= 64),
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'ar')),
  min_lead_minutes integer NOT NULL DEFAULT 120 CHECK (min_lead_minutes BETWEEN 0 AND 20160),
  cancel_window_minutes integer NOT NULL DEFAULT 1440 CHECK (cancel_window_minutes BETWEEN 0 AND 20160),
  max_advance_days integer NOT NULL DEFAULT 60 CHECK (max_advance_days BETWEEN 1 AND 730),
  slot_granularity_minutes integer NOT NULL DEFAULT 15 CHECK (slot_granularity_minutes BETWEEN 5 AND 240),
  hold_minutes integer NOT NULL DEFAULT 5 CHECK (hold_minutes BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES salons (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (salon_id, id)
);

CREATE TABLE services (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES salons (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  -- kept free after the appointment for the same staff member (cleaning, setup)
  buffer_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (salon_id, id)
);

CREATE TABLE staff_services (
  salon_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (staff_id, service_id),
  FOREIGN KEY (salon_id, staff_id) REFERENCES staff (salon_id, id),
  FOREIGN KEY (salon_id, service_id) REFERENCES services (salon_id, id)
);

-- Opening intervals in the salon's wall-clock time, ISO weekday 1 (Monday) to 7 (Sunday), minutes after local midnight.
-- A lunch break is two rows. The exclusion constraint refuses overlapping rows for one staff member and weekday.
CREATE TABLE working_hours (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salon_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute),
  FOREIGN KEY (salon_id, staff_id) REFERENCES staff (salon_id, id),
  CONSTRAINT working_hours_no_overlap EXCLUDE USING gist (staff_id WITH =, weekday WITH =, int4range(start_minute::int, end_minute::int) WITH &&)
);

CREATE TABLE time_off (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salon_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  during tstzrange NOT NULL CHECK (NOT isempty(during) AND NOT lower_inf(during) AND NOT upper_inf(during)),
  FOREIGN KEY (salon_id, staff_id) REFERENCES staff (salon_id, id)
);
CREATE INDEX time_off_staff_idx ON time_off USING gist (staff_id, during);

-- Which salon a chat channel address belongs to (the number or id messages are sent to). The webhook handler reads it
-- before it knows the salon, so it is the one table the system role may read in full; it holds no personal data.
CREATE TABLE salon_channels (
  channel text NOT NULL CHECK (channel ~ '^[a-z0-9_-]{1,32}$'),
  address text NOT NULL CHECK (char_length(address) BETWEEN 1 AND 64),
  salon_id uuid NOT NULL REFERENCES salons (id),
  PRIMARY KEY (channel, address)
);
