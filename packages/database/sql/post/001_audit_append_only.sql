-- Audit log is append-only for the application: UPDATE/DELETE are rejected.
-- Retention purge runs through castlane_purge_audit(), a SECURITY DEFINER function owned by the migration role.
CREATE OR REPLACE FUNCTION castlane_audit_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('castlane.audit_purge', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION castlane_audit_immutable();

CREATE OR REPLACE FUNCTION castlane_purge_audit(before_ts timestamptz) RETURNS integer AS $$
DECLARE removed integer;
BEGIN
  PERFORM set_config('castlane.audit_purge', 'on', true);
  DELETE FROM audit_events WHERE occurred_at < before_ts;
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('castlane.audit_purge', 'off', true);
  RETURN removed;
END;
$$ LANGUAGE plpgsql;
