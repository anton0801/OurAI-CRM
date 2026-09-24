-- Finance invariants enforced by the database (in addition to the posted-line/entry triggers).

-- No lines can be added to a posted document (corrections are reversals / new documents).
CREATE OR REPLACE FUNCTION castlane_no_lines_on_posted_entry() RETURNS trigger AS $$
DECLARE entry_state text;
BEGIN
  SELECT state INTO entry_state FROM financial_entries WHERE id = NEW.entry_id;
  IF entry_state = 'posted' THEN
    RAISE EXCEPTION 'lines cannot be added to a posted financial entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS financial_entry_lines_no_insert_posted ON financial_entry_lines;
CREATE TRIGGER financial_entry_lines_no_insert_posted BEFORE INSERT ON financial_entry_lines
  FOR EACH ROW EXECUTE FUNCTION castlane_no_lines_on_posted_entry();

-- Allocations of posted documents are append-only (re-allocation adds adjustment rows).
CREATE OR REPLACE FUNCTION castlane_posted_allocation_immutable() RETURNS trigger AS $$
DECLARE entry_state text;
BEGIN
  SELECT state INTO entry_state FROM financial_entries WHERE id = OLD.entry_id;
  IF entry_state = 'posted' THEN
    RAISE EXCEPTION 'allocations of posted financial entries are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS financial_allocations_immutable ON financial_allocations;
CREATE TRIGGER financial_allocations_immutable BEFORE UPDATE OR DELETE ON financial_allocations
  FOR EACH ROW EXECUTE FUNCTION castlane_posted_allocation_immutable();

-- Approved compensation run lines (the approved calculation) are a frozen snapshot.
CREATE OR REPLACE FUNCTION castlane_approved_run_lines_immutable() RETURNS trigger AS $$
DECLARE run_state text; run_version integer;
BEGIN
  SELECT state, calculation_version INTO run_state, run_version FROM compensation_runs WHERE id = OLD.run_id;
  IF run_state IN ('approved', 'partially_paid', 'paid') AND OLD.calculation_version = run_version THEN
    RAISE EXCEPTION 'lines of an approved compensation run are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compensation_lines_immutable ON compensation_lines;
CREATE TRIGGER compensation_lines_immutable BEFORE UPDATE OR DELETE ON compensation_lines
  FOR EACH ROW EXECUTE FUNCTION castlane_approved_run_lines_immutable();

-- Entitlement claims are permanent.
CREATE OR REPLACE FUNCTION castlane_claims_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'compensation claims are append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compensation_claims_append_only ON compensation_claims;
CREATE TRIGGER compensation_claims_append_only BEFORE UPDATE OR DELETE ON compensation_claims
  FOR EACH ROW EXECUTE FUNCTION castlane_claims_append_only();

-- Approved rule versions keep their terms; only ending (an earlier exclusive end) is allowed.
CREATE OR REPLACE FUNCTION castlane_approved_rule_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('approved', 'ended') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'approved compensation rule versions cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.type <> OLD.type OR NEW.effective_from <> OLD.effective_from OR NEW.rate_minor IS DISTINCT FROM OLD.rate_minor
       OR NEW.rate_percent IS DISTINCT FROM OLD.rate_percent OR NEW.currency <> OLD.currency
       OR NEW.revenue_basis IS DISTINCT FROM OLD.revenue_basis OR NEW.hourly_source IS DISTINCT FROM OLD.hourly_source
       OR NEW.proration <> OLD.proration OR NEW.eligible_project_ids IS DISTINCT FROM OLD.eligible_project_ids
       OR (OLD.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > OLD.effective_to))
       OR NEW.state NOT IN ('approved', 'ended') THEN
      RAISE EXCEPTION 'approved compensation rule versions are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compensation_rule_versions_immutable ON compensation_rule_versions;
CREATE TRIGGER compensation_rule_versions_immutable BEFORE UPDATE OR DELETE ON compensation_rule_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_approved_rule_version_immutable();

-- Confirmed settlements keep their cash facts; allocations only gain a reversal marker.
CREATE OR REPLACE FUNCTION castlane_confirmed_settlement_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'confirmed settlements cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.direction <> OLD.direction OR NEW.paid_at <> OLD.paid_at
       OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference OR NEW.state = 'draft' THEN
      RAISE EXCEPTION 'confirmed settlements are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settlements_immutable ON settlements;
CREATE TRIGGER settlements_immutable BEFORE UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION castlane_confirmed_settlement_immutable();

CREATE OR REPLACE FUNCTION castlane_settlement_allocation_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement allocations cannot be deleted; reverse them' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.document_amount_minor <> OLD.document_amount_minor
     OR NEW.document_currency <> OLD.document_currency OR NEW.target_entry_id IS DISTINCT FROM OLD.target_entry_id
     OR NEW.target_run_id IS DISTINCT FROM OLD.target_run_id OR NEW.settlement_id <> OLD.settlement_id
     OR (OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at) THEN
    RAISE EXCEPTION 'settlement allocations are immutable except for their reversal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settlement_allocations_immutable ON settlement_allocations;
CREATE TRIGGER settlement_allocations_immutable BEFORE UPDATE OR DELETE ON settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION castlane_settlement_allocation_immutable();
