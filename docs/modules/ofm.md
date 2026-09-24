# OFM operations (S40–S48)

Code: `packages/application/src/ofm/`, contracts `ofm.ts` (ids `ofm.*`), handlers `ofm.ts`, UI `features/ofm/`, pure rules `packages/domain/src/ofm.ts`.

* Shifts: schedule with conflict/DST checks, one actual start (DB guarded), breaks closed once, net hours (M28), forgotten-end monitor
  (`ofm.shift_monitor`, 5 min) without inventing an end, supervisor corrections emit `shift.time_corrected` with
  `compensationSourceInvalidated: true`; allocation shares on `shift_accounts`.
* Reports: versions frozen on submit/approve (trigger `sql/post/004_ofm_immutable.sql`); approval never posts finance.
* Contacts: per account, private notes behind `contacts.read` (never in notifications, snippets or logs), merge, erasure/retention jobs.
* Sale candidates: `pending` → `verified` (finance sets `financialEntryId`) | `rejected` (`reviewNote`); source namespace + transaction
  id unique; the finance module reconciles them.
* Tasks created from OFM flows go through `createOfmTask` (`ofm/tasks-bridge.ts`), which audits, emits, indexes and notifies.

Registries: lookups `ofm_contact`, `shift`; responsibility `ofm.shifts`, `ofm.assignments`, `ofm.contacts.manager`, `ofm.operations.owner`;
import `ofm_contacts`, `sale_candidates`; export `ofm_shifts`, `ofm_shift_reports`; slots My Work "My Shifts", account tab "OFM",
member tab "Shifts", project tab "Operations" (OFM-enabled projects).

Limits: evidence shown as counts; contacts are not part of global search by design (sensitive).
