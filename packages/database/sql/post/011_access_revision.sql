-- Workspace access revision (workspace_access_revisions): every change that can alter what a member
-- may see bumps the revision inside the changing transaction. The application caches access
-- snapshots per (member, member access_revision, workspace revision), so a committed change is
-- visible on the next request without any application code having to remember to invalidate.
CREATE OR REPLACE FUNCTION castlane_bump_access_revision() RETURNS trigger AS $$
DECLARE ws uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN ws := OLD.workspace_id; ELSE ws := NEW.workspace_id; END IF;
  INSERT INTO workspace_access_revisions (workspace_id, revision, updated_at) VALUES (ws, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE SET revision = workspace_access_revisions.revision + 1, updated_at = now();
  IF TG_OP = 'UPDATE' AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    INSERT INTO workspace_access_revisions (workspace_id, revision, updated_at) VALUES (OLD.workspace_id, 1, now())
    ON CONFLICT (workspace_id) DO UPDATE SET revision = workspace_access_revisions.revision + 1, updated_at = now();
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Grants, denies, team and account assignments, OFM assignments, roles: any row change.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_assignments', 'access_denies', 'project_memberships', 'account_assignments', 'ofm_assignments', 'roles'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_access_revision', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION castlane_bump_access_revision()', t || '_access_revision', t);
  END LOOP;
END $$;

-- Structure used for scope resolution: projects (→ direction) and accounts (→ project).
DROP TRIGGER IF EXISTS projects_access_revision ON projects;
CREATE TRIGGER projects_access_revision AFTER INSERT OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION castlane_bump_access_revision();
DROP TRIGGER IF EXISTS projects_direction_access_revision ON projects;
CREATE TRIGGER projects_direction_access_revision AFTER UPDATE OF direction_id, workspace_id ON projects
  FOR EACH ROW WHEN (OLD.direction_id IS DISTINCT FROM NEW.direction_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION castlane_bump_access_revision();

DROP TRIGGER IF EXISTS social_accounts_access_revision ON social_accounts;
CREATE TRIGGER social_accounts_access_revision AFTER INSERT OR DELETE ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION castlane_bump_access_revision();
DROP TRIGGER IF EXISTS social_accounts_project_access_revision ON social_accounts;
CREATE TRIGGER social_accounts_project_access_revision AFTER UPDATE OF project_id, workspace_id ON social_accounts
  FOR EACH ROW WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION castlane_bump_access_revision();
