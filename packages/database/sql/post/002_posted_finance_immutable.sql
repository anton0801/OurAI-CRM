-- Posted financial lines never change; corrections are reversal documents.
CREATE OR REPLACE FUNCTION castlane_posted_line_immutable() RETURNS trigger AS $$
DECLARE entry_state text;
BEGIN
  SELECT state INTO entry_state FROM financial_entries WHERE id = OLD.entry_id;
  IF entry_state = 'posted' THEN
    RAISE EXCEPTION 'posted financial lines are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS financial_entry_lines_immutable ON financial_entry_lines;
CREATE TRIGGER financial_entry_lines_immutable BEFORE UPDATE OR DELETE ON financial_entry_lines
  FOR EACH ROW EXECUTE FUNCTION castlane_posted_line_immutable();

-- A posted entry can only gain reversal links; its economic fields are frozen.
CREATE OR REPLACE FUNCTION castlane_posted_entry_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'posted' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'posted financial entries cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'posted' OR NEW.recognition_date <> OLD.recognition_date OR NEW.type <> OLD.type
       OR NEW.source_external_id IS DISTINCT FROM OLD.source_external_id
       OR NEW.net_only <> OLD.net_only THEN
      RAISE EXCEPTION 'posted financial entries are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS financial_entries_immutable ON financial_entries;
CREATE TRIGGER financial_entries_immutable BEFORE UPDATE OR DELETE ON financial_entries
  FOR EACH ROW EXECUTE FUNCTION castlane_posted_entry_immutable();
