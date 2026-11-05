-- Row level security and grants.
--
-- The application sets the identity of the request at the start of every transaction:
--     SET LOCAL ROLE booking_client;
--     SELECT set_config('app.salon_id', '<uuid>', true), set_config('app.client_id', '<uuid>', true);
-- and every policy below reads it through the helper functions. A missing or empty claim is NULL, a comparison with NULL
-- is never true, so a request without an identity sees nothing (it fails closed).
--
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table owner as well. Only a superuser or a role with
-- BYPASSRLS skips them, and the application never connects as one.
--
-- What this does and does not protect: it stops a query that forgot a WHERE clause, or was given the wrong id, from
-- reading or changing another client's or another salon's rows. It does not stop code that is able to run
-- arbitrary SQL as the login role from issuing SET ROLE or set_config itself: keep that SQL in the repositories.
CREATE FUNCTION app_salon_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.salon_id', true), '')::uuid $$;
CREATE FUNCTION app_client_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.client_id', true), '')::uuid $$;
CREATE FUNCTION app_staff_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.staff_id', true), '')::uuid $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'salons', 'staff', 'services', 'staff_services', 'working_hours', 'time_off', 'salon_channels',
    'clients', 'client_pii', 'appointments', 'pending_actions', 'idempotency_keys',
    'inbound_messages', 'outbox_messages', 'conversation_turns', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END
$$;

-- Catalog: everyone reads their own salon; only staff change it.
GRANT SELECT ON salons, staff, services, staff_services TO booking_client, booking_staff, booking_system;
GRANT SELECT ON working_hours, time_off TO booking_staff, booking_system;
GRANT INSERT, UPDATE, DELETE ON staff, services, staff_services, working_hours, time_off TO booking_staff;
GRANT UPDATE ON salons TO booking_staff;

CREATE POLICY salons_read ON salons FOR SELECT TO booking_client, booking_staff, booking_system USING (id = app_salon_id());
CREATE POLICY salons_staff_update ON salons FOR UPDATE TO booking_staff USING (id = app_salon_id()) WITH CHECK (id = app_salon_id());
CREATE POLICY staff_read ON staff FOR SELECT TO booking_client, booking_staff, booking_system USING (salon_id = app_salon_id());
CREATE POLICY services_read ON services FOR SELECT TO booking_client, booking_staff, booking_system USING (salon_id = app_salon_id());
CREATE POLICY staff_services_read ON staff_services FOR SELECT TO booking_client, booking_staff, booking_system USING (salon_id = app_salon_id());
CREATE POLICY working_hours_read ON working_hours FOR SELECT TO booking_staff, booking_system USING (salon_id = app_salon_id());
CREATE POLICY time_off_read ON time_off FOR SELECT TO booking_staff, booking_system USING (salon_id = app_salon_id());
CREATE POLICY staff_write ON staff FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY services_write ON services FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY staff_services_write ON staff_services FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY working_hours_write ON working_hours FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY time_off_write ON time_off FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());

GRANT SELECT ON salon_channels TO booking_system;
CREATE POLICY salon_channels_read ON salon_channels FOR SELECT TO booking_system USING (true);

-- Clients: a client sees their own row and their own personal data, staff see the salon, the system creates and erases.
GRANT SELECT ON clients, client_pii TO booking_client, booking_staff;
GRANT SELECT, INSERT, UPDATE ON clients TO booking_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON client_pii TO booking_system;

CREATE POLICY clients_self ON clients FOR SELECT TO booking_client USING (salon_id = app_salon_id() AND id = app_client_id());
CREATE POLICY clients_staff ON clients FOR SELECT TO booking_staff USING (salon_id = app_salon_id());
CREATE POLICY clients_system ON clients FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY client_pii_self ON client_pii FOR SELECT TO booking_client USING (salon_id = app_salon_id() AND client_id = app_client_id());
CREATE POLICY client_pii_staff ON client_pii FOR SELECT TO booking_staff USING (salon_id = app_salon_id());
CREATE POLICY client_pii_system ON client_pii FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());

-- Appointments: a client reads, creates and changes only their own, and cannot hand one to somebody else. Identity
-- columns are not updatable by any application role (the trigger in 0004 enforces it for the owner as well).
GRANT SELECT ON appointments TO booking_client, booking_staff, booking_system;
GRANT INSERT (id, salon_id, staff_id, client_id, service_id, status, starts_at, ends_at, buffer_minutes, blocked_until, hold_expires_at, notes, version, created_at, updated_at)
  ON appointments TO booking_client, booking_staff;
GRANT UPDATE (staff_id, status, starts_at, ends_at, buffer_minutes, blocked_until, hold_expires_at, notes, version, updated_at, cancelled_at)
  ON appointments TO booking_client, booking_staff, booking_system;

CREATE POLICY appointments_client_read ON appointments FOR SELECT TO booking_client
  USING (salon_id = app_salon_id() AND client_id = app_client_id());
CREATE POLICY appointments_client_insert ON appointments FOR INSERT TO booking_client
  WITH CHECK (salon_id = app_salon_id() AND client_id = app_client_id() AND status IN ('held', 'booked'));
CREATE POLICY appointments_client_update ON appointments FOR UPDATE TO booking_client
  USING (salon_id = app_salon_id() AND client_id = app_client_id())
  WITH CHECK (salon_id = app_salon_id() AND client_id = app_client_id() AND status IN ('held', 'booked', 'cancelled'));
CREATE POLICY appointments_staff ON appointments FOR ALL TO booking_staff
  USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY appointments_system_read ON appointments FOR SELECT TO booking_system USING (salon_id = app_salon_id());
CREATE POLICY appointments_system_update ON appointments FOR UPDATE TO booking_system
  USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id() AND status IN ('held', 'booked', 'expired', 'cancelled'));

GRANT SELECT, INSERT, UPDATE ON pending_actions TO booking_client;
GRANT SELECT, UPDATE, DELETE ON pending_actions TO booking_system;
CREATE POLICY pending_client ON pending_actions FOR ALL TO booking_client
  USING (salon_id = app_salon_id() AND client_id = app_client_id()) WITH CHECK (salon_id = app_salon_id() AND client_id = app_client_id());
CREATE POLICY pending_system ON pending_actions FOR ALL TO booking_system
  USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());

GRANT SELECT, INSERT ON idempotency_keys TO booking_client, booking_staff;
GRANT SELECT, DELETE ON idempotency_keys TO booking_system;
CREATE POLICY idempotency_client ON idempotency_keys FOR ALL TO booking_client
  USING (salon_id = app_salon_id() AND actor_id = app_client_id()) WITH CHECK (salon_id = app_salon_id() AND actor_id = app_client_id());
CREATE POLICY idempotency_staff ON idempotency_keys FOR ALL TO booking_staff
  USING (salon_id = app_salon_id() AND actor_id = app_staff_id()) WITH CHECK (salon_id = app_salon_id() AND actor_id = app_staff_id());
CREATE POLICY idempotency_system ON idempotency_keys FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());

-- Messaging: only the system role touches the inbox and the outbox; a client can read back their own conversation.
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_messages, outbox_messages TO booking_system;
GRANT SELECT, INSERT, DELETE ON conversation_turns TO booking_system;
GRANT SELECT ON conversation_turns TO booking_client;
CREATE POLICY inbound_system ON inbound_messages FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY outbox_system ON outbox_messages FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY conversation_system ON conversation_turns FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY conversation_client ON conversation_turns FOR SELECT TO booking_client USING (salon_id = app_salon_id() AND client_id = app_client_id());

-- Audit: append-only for everyone but the retention job of the system role.
GRANT SELECT, INSERT ON audit_log TO booking_client, booking_staff;
GRANT SELECT, INSERT, DELETE ON audit_log TO booking_system;
CREATE POLICY audit_client_read ON audit_log FOR SELECT TO booking_client USING (salon_id = app_salon_id() AND client_id = app_client_id());
CREATE POLICY audit_client_insert ON audit_log FOR INSERT TO booking_client WITH CHECK (salon_id = app_salon_id() AND client_id = app_client_id());
CREATE POLICY audit_staff ON audit_log FOR ALL TO booking_staff USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
CREATE POLICY audit_system ON audit_log FOR ALL TO booking_system USING (salon_id = app_salon_id()) WITH CHECK (salon_id = app_salon_id());
