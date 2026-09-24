-- OFM: submitted/approved shift report versions and published quality reviews are frozen.
-- Corrections create a new report version or a replacement review revision; history is never rewritten.
CREATE OR REPLACE FUNCTION castlane_shift_report_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('submitted', 'approved', 'changes_requested') AND (
       NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.completed_work IS DISTINCT FROM OLD.completed_work
    OR NEW.issues IS DISTINCT FROM OLD.issues
    OR NEW.next_actions IS DISTINCT FROM OLD.next_actions
    OR NEW.account_sections IS DISTINCT FROM OLD.account_sections
    OR NEW.counts IS DISTINCT FROM OLD.counts
    OR NEW.source_refs IS DISTINCT FROM OLD.source_refs
    OR NEW.no_open_items IS DISTINCT FROM OLD.no_open_items
    OR NEW.handover_id IS DISTINCT FROM OLD.handover_id
    OR NEW.version_no <> OLD.version_no) THEN
    RAISE EXCEPTION 'submitted shift report versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'approved' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'approved shift report versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shift_report_versions_immutable ON shift_report_versions;
CREATE TRIGGER shift_report_versions_immutable BEFORE UPDATE ON shift_report_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_shift_report_version_immutable();

CREATE OR REPLACE FUNCTION castlane_shift_report_version_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'submitted shift report versions cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shift_report_versions_no_delete ON shift_report_versions;
CREATE TRIGGER shift_report_versions_no_delete BEFORE DELETE ON shift_report_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_shift_report_version_no_delete();

CREATE OR REPLACE FUNCTION castlane_quality_review_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' AND (
       NEW.scores IS DISTINCT FROM OLD.scores
    OR NEW.total_score IS DISTINCT FROM OLD.total_score
    OR NEW.rubric_version_id IS DISTINCT FROM OLD.rubric_version_id
    OR NEW.factual_notes IS DISTINCT FROM OLD.factual_notes
    OR NEW.improvements IS DISTINCT FROM OLD.improvements
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.reviewer_membership_id IS DISTINCT FROM OLD.reviewer_membership_id) THEN
    RAISE EXCEPTION 'published quality reviews are immutable; publish a revision instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS quality_reviews_immutable ON quality_reviews;
CREATE TRIGGER quality_reviews_immutable BEFORE UPDATE ON quality_reviews
  FOR EACH ROW EXECUTE FUNCTION castlane_quality_review_immutable();

CREATE OR REPLACE FUNCTION castlane_rubric_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' AND (NEW.criteria IS DISTINCT FROM OLD.criteria OR NEW.version_no <> OLD.version_no) THEN
    RAISE EXCEPTION 'published rubric versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rubric_versions_immutable ON rubric_versions;
CREATE TRIGGER rubric_versions_immutable BEFORE UPDATE ON rubric_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_rubric_version_immutable();
