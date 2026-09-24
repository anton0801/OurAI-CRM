-- Platform module: template version immutability and per-workspace audit retention.

-- Published and withdrawn template versions never change their configuration (applications
-- reference the exact version). Allowed updates: draft edits, draft → published, published → disabled.
CREATE OR REPLACE FUNCTION castlane_template_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('published', 'disabled') THEN
    IF NEW.config IS DISTINCT FROM OLD.config OR NEW.version_no <> OLD.version_no OR NEW.template_id <> OLD.template_id THEN
      RAISE EXCEPTION 'published template versions are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'disabled' AND NEW.state <> 'disabled' THEN
      RAISE EXCEPTION 'withdrawn template versions cannot be republished' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'published' AND NEW.state NOT IN ('published', 'disabled') THEN
      RAISE EXCEPTION 'published template versions cannot return to draft' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS template_versions_immutable ON template_versions;
CREATE TRIGGER template_versions_immutable BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_template_version_immutable();

-- Audit retention per workspace (settings.retention.auditMonths); rows stay append-only otherwise.
CREATE OR REPLACE FUNCTION castlane_purge_audit_ws(ws uuid, before_ts timestamptz) RETURNS integer AS $$
DECLARE removed integer;
BEGIN
  PERFORM set_config('castlane.audit_purge', 'on', true);
  DELETE FROM audit_events WHERE workspace_id = ws AND occurred_at < before_ts;
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('castlane.audit_purge', 'off', true);
  RETURN removed;
END;
$$ LANGUAGE plpgsql;
