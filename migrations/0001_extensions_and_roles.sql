-- Extensions and the database roles the application uses.
--
-- btree_gist lets an exclusion constraint combine plain equality (same staff member) with range overlap. It ships in
-- the PostgreSQL contrib package of every common distribution and managed service.
--
-- Roles are cluster-wide objects. The application connects with ONE login role (create it yourself, with a password
-- from your secret store, see docs/deployment.md) that is a member of the three roles below and switches into one of
-- them at the start of every transaction (SET LOCAL ROLE). None of them can bypass row level security, and none owns a
-- table, so every policy applies to every statement the application sends.
--
--   booking_client  a chat client: sees and changes only their own rows
--   booking_staff   a signed-in staff member or owner: the whole salon
--   booking_system  the webhook handler and the outbox dispatcher: the whole salon, no client-facing writes
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['booking_client', 'booking_staff', 'booking_system'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', r);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO booking_client, booking_staff, booking_system;
