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

CREATE OR REPLACE FUNCTION castlane_content_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL AND (NEW.brief_snapshot IS DISTINCT FROM OLD.brief_snapshot
      OR NEW.character_version_ids IS DISTINCT FROM OLD.character_version_ids OR NEW.version_no <> OLD.version_no) THEN
    RAISE EXCEPTION 'submitted content versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_versions_immutable ON content_versions;
CREATE TRIGGER content_versions_immutable BEFORE UPDATE ON content_versions
  FOR EACH ROW EXECUTE FUNCTION castlane_content_version_immutable();

CREATE OR REPLACE FUNCTION castlane_content_version_assets_immutable() RETURNS trigger AS $$
DECLARE submitted timestamptz;
BEGIN
  SELECT submitted_at INTO submitted FROM content_versions WHERE id = COALESCE(OLD.content_version_id, NEW.content_version_id);
  IF submitted IS NOT NULL THEN
    RAISE EXCEPTION 'assets of a submitted content version are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_version_assets_immutable ON content_version_assets;
CREATE TRIGGER content_version_assets_immutable BEFORE UPDATE OR DELETE ON content_version_assets
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
