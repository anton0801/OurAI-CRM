# Administrator guide

For the Owner and administrators of a Castlane workspace. Operators of the servers should read
`docs/runbooks/` instead.

## 1. First run (F01)
1. The person who deployed Castlane runs `bootstrap:owner` once and gives you the temporary password
   through a safe channel.
2. Sign in, choose a new password, set up two-factor authentication with an authenticator app and
   **store the ten recovery codes offline**. Each code works once.
3. Workspace Setup has three steps, each saved on the server (you can close the tab and continue):
   * **Workspace** — name, time zone, base currency (changeable until the first financial entry is
     posted), week start.
   * **Directions** — AI Series, AI Models and AI Influencers are proposed; rename or add more and
     choose leads.
   * **Team** — invite people now or later. Nothing is sent until you confirm.

## 2. People and access
* **Invite** from Team → Invite. Pick a role and its scope (whole workspace, a direction, specific
  projects or accounts, only assigned records). Invitations expire after 72 hours; Resend creates a
  new link and invalidates the old one. People whose invitation expired can ask for a new one from
  the sign-in page — the request appears in Team → Invitation Requests.
* **Roles** (Settings → Roles and Access) are presets (Owner, Admin, Direction Lead, Project Lead,
  Producer, Creator, Publisher, OFM Manager, OFM Supervisor, Analyst, Finance Manager, Contractor,
  Viewer) plus custom roles. Permissions marked **Sensitive** (finance, OFM contacts, restricted
  media, exports, access management) should be granted narrowly. Admin and finance presets can only
  be granted by the Owner, and nobody can grant more than they hold.
* **Explain Access** shows why a member can or cannot see a record. Out-of-scope records look like
  they do not exist — that is intended.
* Changing someone's access takes effect immediately; their open tabs reload.
* **Deactivate** (F12): the preview lists every open responsibility (tasks, reviews, shifts, account
  ownership, budgets, report schedules…). Choose successors or leave items in the lead's Unassigned
  queue, confirm, and the person's sessions end at once. Their history stays with their name.
  **Restore** does not bring back sensitive grants automatically.
* **Ownership transfer** needs both people to confirm with a recent password or code.

## 3. Workspace settings
Settings → Workspace: name, logo, time zone, currency, working hours, security policy (which roles
must use two-factor authentication, session limits), retention periods and notification defaults.
Every change shows its impact first and is recorded in the Audit Log.
Mail delivery is configured on the server (SMTP); the settings page shows its status and can send a
test message to you.

## 4. Templates and custom fields
Settings → Templates and Custom Fields: task, content, checklist and quality-rubric templates have
versions — edit a draft, **Publish** to make it available, later versions do not change tasks that
were already created. Custom fields can be required from a given stage; changing a field's type
shows a migration preview.

## 5. Data in and out
* **Import Center**: CSV/XLSX for projects, accounts, tasks, references, metric observations, OFM
  contacts, sale candidates, financial drafts and FX rates. Nothing is written until the validation
  report has no blocking errors and you press Confirm. Financial imports only create drafts.
  Undo is possible while the imported records are unchanged.
* **Export Center**: CSV/XLSX of records the requester may see; files expire after 7 days and the
  download re-checks permission.

## 6. Archive, trash and audit
* Archive keeps history and reports; Restore shows collisions (e.g. a new record with the same name)
  and asks how to resolve them.
* Trash holds eligible drafts for 30 days. Permanent purge is Owner-only; finance and audit history
  can never be purged.
* Settings → Audit Log lists important changes with masked field differences; export it for reviews.

## 7. System health
Operations → System Health shows incidents, background jobs (retry failed ones), mail delivery,
**Backup Last Success** and **Restore Last Tested**. A backup is only trusted after a restore drill.
Record operational incidents here with the timeline and resolution.

## 8. Security checklist
* Keep at least two people with Owner/Admin rights who use two-factor authentication.
* Review Roles and Access and the Audit Log monthly; remove unused custom roles.
* Grant finance, OFM contacts and exports only to the people who need them.
* Deactivate leavers on their last day (sessions end immediately).
* Never share recovery codes or temporary passwords in chat; use a password manager.
