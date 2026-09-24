-- Approved character versions, submitted content versions and published article versions are frozen.
CREATE OR REPLACE FUNCTION castlane_character_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('approved', 'superseded') AND (NEW.profile IS DISTINCT FROM OLD.profile OR NEW.prompts IS DISTINCT FROM OLD.prompts
      OR NEW.reference_asset_version_ids IS DISTINCT FROM OLD.reference_asset_version_ids) THEN
    RAISE EXCEPTION 'approved character versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS character_versions_immutable ON character_versions;
CREATE TRIGGER character_versions_immutable BEFORE UPDATE ON character_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_character_version_immutable();

-- After submission only the approval columns (approved_at, approval_revoked_*) and bookkeeping change.
CREATE OR REPLACE FUNCTION castlane_content_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL AND (NEW.brief_snapshot IS DISTINCT FROM OLD.brief_snapshot
      OR NEW.character_version_ids IS DISTINCT FROM OLD.character_version_ids OR NEW.version_no <> OLD.version_no
      OR NEW.checklist IS DISTINCT FROM OLD.checklist OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.fixes_claimed IS DISTINCT FROM OLD.fixes_claimed OR NEW.content_item_id <> OLD.content_item_id
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by) THEN
    RAISE EXCEPTION 'submitted content versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_versions_immutable ON content_versions;
CREATE TRIGGER content_versions_immutable BEFORE UPDATE ON content_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_content_version_immutable();

-- Files of a submitted version: none added, changed, moved in or out, or removed.
CREATE OR REPLACE FUNCTION castlane_content_version_assets_immutable() RETURNS trigger AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM content_versions WHERE id = OLD.content_version_id AND submitted_at IS NOT NULL))
      OR (TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM content_versions WHERE id = NEW.content_version_id AND submitted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'assets of a submitted content version are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_version_assets_immutable ON content_version_assets;
CREATE TRIGGER content_version_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON content_version_assets
  FOR EACH ROW EXECUTE FUNCTION castlane_content_version_assets_immutable();

CREATE OR REPLACE FUNCTION castlane_article_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('published', 'superseded') AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title <> OLD.title) THEN
    RAISE EXCEPTION 'published article versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS article_versions_immutable ON article_versions;
CREATE TRIGGER article_versions_immutable BEFORE UPDATE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_article_version_immutable();

-- Stored blobs of an asset version are immutable once the version became available.
CREATE OR REPLACE FUNCTION castlane_asset_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'available' AND (NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256) THEN
    RAISE EXCEPTION 'available asset versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS asset_versions_immutable ON asset_versions;
CREATE TRIGGER asset_versions_immutable BEFORE UPDATE ON asset_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_asset_version_immutable();
