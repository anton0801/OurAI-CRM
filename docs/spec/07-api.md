# Castlane CRM — Specification part 7: REST API contracts & endpoint catalogue (sections 24–25)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 24. REST API: общие контракты

### 24.1. Формат и версия

Base: `/api/v1`. Workspace endpoints: `/api/v1/workspaces/{workspaceId}` плюс routes ниже. JSON UTF-8, timestamps RFC3339 UTC, date-only YYYY-MM-DD, money/large numeric strings. UUID в идентификаторах, UI readable code необязателен. API принимает только явно разрешённые поля; mass assignment системных полей запрещён.

Response success example:

```json
{
  "data": {
    "id": "7b0c8f19-43b5-4d56-8f0c-c9a1b427ea22",
    "title": "Emma — Morning Routine Reel",
    "status": "production",
    "rowVersion": 4
  },
  "meta": {
    "requestId": "req_9c2f2841",
    "asOf": "2026-09-24T10:30:00Z"
  }
}
```

Error example:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This record changed while you were editing it.",
    "fieldErrors": [],
    "retryable": false,
    "currentVersion": 5,
    "requestId": "req_b4c82806"
  }
}
```

Validation field error: `{ "field": "scheduledAt", "code": "MUST_BE_FUTURE", "message": "Choose a future date and time." }`. Error body не содержит stack trace, SQL и чужие records. API error codes стабильны, English message локализуемый через key.

### 24.2. HTTP и concurrency

200 read/update/action result; 201 created + Location; 202 background accepted + job ID; 204 только когда body не нужен; 400 malformed; 401 unauthenticated; 403 action denied for accessible scope; 404 missing/out-of-scope object; 409 duplicate/state conflict; 412 VERSION_CONFLICT при несовпадении If-Match; 422 domain/field validation; 428 отсутствует обязательный If-Match; 429 rate limit; 503 temporary dependency unavailable. Единый optimistic concurrency transport: If-Match с row_version и 412 для устаревшей версии. Если версия совпадает, но доменный переход уже недопустим, использовать 409 INVALID_STATE.

GET detail возвращает ETag с version. PATCH и state commands требуют If-Match, кроме создания и независимых append-only comments. Ошибка conflict возвращает permitted latest snapshot/reference, предлагается Reload / Compare / Reapply Own Changes. Финансовые и status changes не auto-merge. UI edits title и другой пользователь меняет description — можно предложить field-level reapply, но только с новой серверной проверкой.

POST create, state actions, financial actions, upload completion и import commit используют Idempotency-Key UUID. Scope ключа: workspace+actor+route+key; хранить normalized request hash и committed response reference 7 дней; financial source unique constraints действуют бессрочно в пределах retention. Повтор key+same body → прежний result после проверки текущих прав; key+different body → 409 IDEMPOTENCY_PAYLOAD_MISMATCH. Pending same key → 409 OPERATION_IN_PROGRESS с Retry-After. Не кешировать sensitive response так, чтобы revoked member мог получить его replay.

Порядок retry: сначала текущая authentication/authorization, затем поиск завершённой idempotent operation с тем же hash, и только для новой операции — проверка If-Match и допустимости нового перехода. Иначе успешный повтор с прежним If-Match ошибочно получил бы conflict. После истечения idempotency TTL business unique keys продолжают защищать финансовые sources, entitlement claims, публикационные URLs и template/recurrence occurrences.

Critical write = transaction: authorize current membership → lock target/source rows → validate versions/invariants → write domain facts → append AuditEvent + OutboxEvent → commit. Если commit успешен, а ответ потерян, повтор восстанавливает response из operation record. Uniqueness/locking защищают даже при двух разных idempotency keys. Isolation выбирается по use case; обработка serialization failures и retry всей transaction соответствует модели [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

### 24.3. List, filter, batch

Pagination cursor opaque, sort key+id stable; pageSize default 50, max 200. Query filters typed, allowlist fields/operators, sort до 3 columns. Response meta: nextCursor, hasMore, asOf; exact total только при отдельном запросе, без scope leak. Array parameters max 200 IDs. UTC filter boundaries вычисляются из выбранного пользовательского периода с timezone, передаются явно.

Bulk command принимает selected IDs или saved validated filter snapshot, expected count, action, dryRun token. Dry run token 10 min, содержит targets+versions+scope revision. До исполнения recheck permissions; changed targets возвращают conflict preview. Не выполнять action по произвольному client SQL/filter expression.

Default API лимиты: authenticated read 300/min/member, write 120/min/member, expensive report 10/min/member, imports 2 active/workspace, downloads 20 new credentials/min/member. Server возвращает Retry-After; эти defaults configurable. Health checks и streaming chunk requests имеют отдельный budget, чтобы одно видео не блокировало обычный UI.

### 24.4. Realtime

SSE `/events` для изменённых IDs, Inbox counts и job progress. Подписка авторизуется по workspace и текущей membership. События содержат safe entity type/id/revision, без закрытых полей; клиент refetch через обычный authorizer. Reconnect с Last-Event-ID, retention stream 24 h; истёкший cursor → resync event. Revoked membership disconnect немедленно по event и дополнительно heartbeat verification ≤30 s; любой последующий read/write уже запрещён. Poll fallback 30 s при недоступном SSE. Не показывать fake presence и typing indicators.

## 25. API endpoint catalog и команды

### 25.1. Общий контракт ресурсов

Для ресурсов таблицы действует точно следующий набор: `GET /resource` list, `POST /resource` create, `GET /resource/{id}` detail, `PATCH /resource/{id}` update изменяемых полей. Набор существует только для строк с указанным CRUD. Все destructive/lifecycle действия — отдельные команды ниже; generic DELETE для финансов и исторических данных отсутствует. Create/update schemas определяются обязательными полями экранов и сущностей, публикуются в OpenAPI с enum, maxLength, nullable и examples.

| Resource path | CRUD | Особенности |
|---|---|---|
| `/directions` | List/Create/Read/Update | Name/lead, archive через command |
| `/projects` | List/Create/Read/Update | Type immutability, project team nested |
| `/projects/{projectId}/members` | List/Create/Read/Update | Scoped assignments, effective interval |
| `/projects/{projectId}/characters` | List/Create/Read/Update | Изменяются draft profile fields |
| `/projects/{projectId}/seasons` | List/Create/Read/Update | Order unique |
| `/seasons/{seasonId}/episodes` | List/Create/Read/Update | Number/language uniqueness |
| `/episodes/{episodeId}/scenes` | List/Create/Read/Update | Version references, order |
| `/accounts` | List/Create/Read/Update | Normalized external identity |
| `/accounts/{accountId}/assignments` | List/Create/Read/Update | Valid intervals and responsibility |
| `/references` | List/Create/Read/Update | Source file or URL |
| `/content` | List/Create/Read/Update | Draft/current brief; status through command |
| `/content/{contentId}/versions` | List/Create/Read | Immutable после submission |
| `/reviews` | List/Read | Создаются submit command |
| `/comments` | List/Create/Read/Update | Собственный текст до решения/по policy; edits audited |
| `/tasks` | List/Create/Read/Update | Checklist/subtasks/dependencies отдельные child resources |
| `/tasks/{taskId}/checklist` | List/Create/Read/Update | Required flags checked on transition |
| `/tasks/{taskId}/dependencies` | List/Create/Read | Delete relation отдельной command |
| `/recurrences` | List/Create/Read/Update | Rule version и generation preview |
| `/time-entries` | List/Create/Read/Update | Только unapproved editable |
| `/capacities` | List/Create/Read/Update | Member schedule |
| `/absences` | List/Create/Read/Update | Scope-limited reason |
| `/publications` | List/Create/Read/Update | Факт публикации через command |
| `/campaigns` | List/Create/Read/Update | Primary campaign links |
| `/tracking-links` | List/Create/Read/Update | Safe URL builder |
| `/experiments` | List/Create/Read/Update | Plan version freeze |
| `/folders` | List/Create/Read/Update | Scope и cycle checks |
| `/assets` | List/Read/Update | Создание через upload/external-link flow; metadata only update |
| `/articles` | List/Create/Read/Update | Draft content only |
| `/ofm/assignments` | List/Create/Read/Update | No implicit finance grants |
| `/ofm/shifts` | List/Create/Read/Update | Scheduled editable, actual via commands |
| `/ofm/handovers` | List/Create/Read/Update | Draft only, task refs |
| `/ofm/contacts` | List/Create/Read/Update | Sensitive scope |
| `/ofm/interactions` | List/Create/Read/Update | Manual, authorship audited |
| `/ofm/operations` | List/Create/Read/Update | State via command |
| `/ofm/sale-candidates` | List/Create/Read/Update | Pending only |
| `/ofm/quality-reviews` | List/Create/Read/Update | Draft only |
| `/metric-definitions` | List/Read | System and approved version catalog |
| `/metric-observations` | List/Create/Read | Изменение через revision |
| `/metric-checkpoints` | List/Read | Policy scheduler/commands |
| `/goals` | List/Create/Read/Update | Target revision audit |
| `/reports` | List/Create/Read/Update | Typed config |
| `/report-schedules` | List/Create/Read/Update | Recipient scope recheck |
| `/finance/entries` | List/Create/Read/Update | Draft only |
| `/finance/settlements` | List/Create/Read/Update | Draft only |
| `/finance/budgets` | List/Create/Read/Update | Draft version only |
| `/finance/commitments` | List/Create/Read/Update | Remaining/consumed tracked |
| `/finance/fx-rates` | List/Create/Read | Used snapshots immutable |
| `/finance/compensation-rules` | List/Create/Read | Version create, no overwrite |
| `/finance/compensation-runs` | List/Create/Read | Calculate/approve commands |
| `/partners` | List/Create/Read/Update | Business identity |
| `/deals` | List/Create/Read/Update | Stage via command |
| `/deals/{dealId}/deliverables` | List/Create/Read/Update | Linked content/tasks |
| `/members` | List/Read/Update | Creation via invitation |
| `/roles` | List/Create/Read/Update | Owner protected |
| `/role-assignments` | List/Create/Read/Update | Scoped and audited |
| `/automations` | List/Create/Read/Update | Draft version config |
| `/templates` | List/Create/Read/Update | Draft version config |
| `/custom-fields` | List/Create/Read/Update | Typed definitions |
| `/incidents` | List/Create/Read/Update | Operational/system scopes |
| `/notifications` | List/Read | Recipient own only |
| `/imports` | List/Create/Read | Staging job |
| `/exports` | List/Create/Read | Private artifact job |
| `/audit-events` | List/Read | Immutable, masked |

### 25.2. Identity и настройки

| Method and path | Request / effect |
|---|---|
| POST `/auth/sign-in` | email/password → challenge или session; no workspace mutation |
| POST `/auth/mfa/verify` | challengeId/code → session, atomic consume |
| POST `/auth/mfa/setup` | recent auth → pending secret/QR; confirm отдельным verify |
| POST `/auth/recovery` | email → generic accepted, mail job |
| POST `/auth/reset` | token/newPassword → consume token/revoke sessions |
| POST `/auth/sign-out` | revoke current session |
| GET `/auth/sessions` | own permitted sessions |
| POST `/auth/sessions/{id}/revoke` | revoke selected own/privileged target |
| POST `/invitations` | email, roles/scopes → invitation + mail delivery job |
| POST `/invitations/{id}/resend` | revoke old token, generate new, idempotent |
| POST `/invitations/{id}/revoke` | invitation invalid immediately |
| POST `/auth/invitations/accept` | token/profile/password → membership |
| GET/PATCH `/settings/workspace` | settingsVersion and allowed fields |
| GET/PATCH `/settings/me` | personal preferences, no role writes |
| POST `/access/evaluate` | memberId/objectRef/action → safe effective permissions explanation for access manager |
| POST `/ownership/transfers` | recipient, recentAuth → pending transfer |
| POST `/ownership/transfers/{id}/accept` | recipient recentAuth → atomic role transfer |
| POST `/members/{id}/deactivation-preview` | proposed reassignment map → impact token |
| POST `/members/{id}/deactivate` | impactToken → reassign/revoke/deactivate transaction |
| POST `/members/{id}/restore` | reason, proposed scoped roles → active membership |

Auth paths не требуют workspace prefix; `/invitations`, `/members` и settings применяются под workspace base. После auth/mfa setup recovery codes возвращаются только на отдельном подтверждённом finish; raw secret больше не отдаётся.

### 25.3. Доменные команды

Все команды POST, требуют Idempotency-Key, If-Match для существующего изменяемого target и проверяемого action permission.

| Path | Обязательное тело | Результат и основная проверка |
|---|---|---|
| `/projects/{id}/transition` | targetState, reason when required | Project transition, open obligations validation |
| `/projects/{id}/transfer-direction` | directionId, impactToken | Новый scope, historical dimension сохранена |
| `/accounts/{id}/transfer` | targetProjectId, impactToken, reason | Только разрешённый перенос |
| `/accounts/{id}/transition` | targetState, reason | Account lifecycle |
| `/characters/{id}/versions` | profile, referenceVersionIds | New draft profile version |
| `/character-versions/{id}/approve` | reviewId | Immutable approved version |
| `/content/{id}/apply-template` | templateVersionId, previewToken | Task graph exactly once |
| `/content/{id}/transition` | targetStage, reason | Только разрешённые non-review transitions |
| `/content/{id}/submit` | versionId, reviewPolicyVersion | Frozen submitted version + Review |
| `/content/{id}/duplicate` | targetProjectId, copiedFieldSet | New Idea, no historical metrics |
| `/reviews/{id}/approve` | versionId, decisionNote optional | Approval target match/blocker/self-review checks |
| `/reviews/{id}/request-changes` | versionId, summary | Changes Requested + notification |
| `/reviews/{id}/revoke` | reason | Revoke for future placements |
| `/comments/{id}/resolve` | resolutionNote | Resolve target-version comment |
| `/comments/{id}/reopen` | reason | Blocker restored |
| `/tasks/{id}/transition` | targetState, reason | Dependency/checklist/review validation |
| `/tasks/{id}/reschedule-preview` | startAt, dueAt, propagate | Changed dependency dates preview |
| `/tasks/{id}/reschedule` | previewToken | Atomic selected updates |
| `/tasks/{id}/dependencies/{dependencyId}/remove` | reason | Remove relation with audit |
| `/timers/start` | taskId | One active timer per member |
| `/timers/{id}/stop` | note optional | One TimeEntry from timer |
| `/time-entries/{id}/approve` | reviewerNote optional | Immutable approved time |
| `/publications/{id}/schedule` | scheduledAt, timezone, versionId | Approved asset/account gates |
| `/publications/{id}/mark-published` | actualPublishedAt, externalUrl or noUrlReason | Published + checkpoint creation |
| `/publications/{id}/fail` | reason | Failed, no fake stats |
| `/publications/{id}/cancel` | reason | Cancelled, reminders invalidated |
| `/publications/{id}/correct` | permittedChanges, reason | Historical correction with revision |
| `/uploads/initiate` | file metadata, checksum, targetRef | Authorized reservation and multipart session |
| `/uploads/{id}/complete` | part manifests, checksum | Quarantine processing queued |
| `/uploads/{id}/abort` | reason optional | Reservation cleanup |
| `/assets/external-links` | httpsUrl, title, scope | Metadata-only external asset |
| `/assets/{id}/download` | versionId | Authorized temporary download or stream token |
| `/assets/{id}/link` | targetRef, versionId, role | Scope/sensitivity validated link |
| `/asset-links/{id}/remove` | reason optional | Removes relation only |
| `/articles/{id}/publish` | versionId, revisionKind | Immutable published article |
| `/articles/{id}/acknowledge` | versionId | Explicit reading acknowledgement |
| `/ofm/shifts/{id}/start` | handoverAcknowledgementId or noHandoverReason | Server actual_start, unique active shift |
| `/ofm/shifts/{id}/pause` | reason optional | Open break |
| `/ofm/shifts/{id}/resume` | breakId | Close break |
| `/ofm/shifts/{id}/end` | endNote | End actual interval, report draft |
| `/ofm/shifts/{id}/correct-time` | start/end/break corrections, reason | Supervisor-only audited change |
| `/ofm/shifts/{id}/submit-report` | reportVersionId, handoverId/noOpenItems | Report Submitted |
| `/ofm/shift-reports/{id}/approve` | versionId | Freeze report; no finance posting |
| `/ofm/shift-reports/{id}/request-changes` | summary | Revised draft required |
| `/ofm/handovers/{id}/acknowledge` | acceptedItemIds | Acknowledgement, not completion |
| `/ofm/contacts/merge-preview` | sourceId, targetId | Safe diff, same-account check |
| `/ofm/contacts/merge` | previewToken, fieldResolutions | Merge refs, unique sales preserved |
| `/ofm/operations/{id}/transition` | targetState, outcome/reason | Business state, no payment effect |
| `/ofm/sale-candidates/{id}/verify` | sourceEvidence, allocation | Draft financial entry reference |
| `/ofm/sale-candidates/{id}/reject` | reason | Excluded candidate |
| `/ofm/quality-reviews/{id}/publish` | rubricVersionId, scores, evidence | Frozen quality review |
| `/ofm/quality-reviews/{id}/dispute` | reason | Dispute record |
| `/metric-observations/{id}/revisions` | newValues, reason, source | Pending/reviewable correction |
| `/metric-revisions/{id}/approve` | decisionNote | Canonical revision changed |
| `/metric-checkpoints/{id}/mark-missing` | reason | Missing, no zeros |
| `/reports/{id}/run` | period, filters | Interactive result or job if expensive |
| `/reports/{id}/snapshot` | period, filters | Immutable authorized snapshot |
| `/goals/{id}/check-in` | note, optional manualValue/source | Progress from semantic layer or labeled manual |
| `/finance/entries/{id}/submit` | note optional | Submitted |
| `/finance/entries/{id}/post` | approverNote/exceptionReason | Atomic posted lines, source uniqueness |
| `/finance/entries/{id}/reverse` | reason, effectiveDate | Linked reversing entry |
| `/finance/entries/{id}/allocation-preview` | proposedAllocation | Balanced allocation preview |
| `/finance/entries/{id}/allocate` | previewToken | Draft edit or posted adjustment |
| `/finance/settlements/{id}/confirm` | allocationLines, remainderPolicy | Cash fact and outstanding update |
| `/finance/settlements/{id}/reverse` | reason, effectiveDate | Reversal without deleting original |
| `/finance/budgets/{id}/approve` | versionId | Current approved budget version |
| `/finance/compensation-rules/{id}/approve` | versionId | Effective immutable rule |
| `/finance/compensation-runs/{id}/calculate` | period, sourceBounds | Draft calculation + diff |
| `/finance/compensation-runs/{id}/submit` | calculationVersion | Ready for approval |
| `/finance/compensation-runs/{id}/approve` | calculationVersion, sourceDigest | Claims + linked expense exactly once |
| `/finance/periods/close` | period, unresolvedAcknowledgements | Period lock |
| `/finance/periods/reopen` | periodId, reason | Audited reopen, report stale markers |
| `/automations/{id}/dry-run` | sampleEventRef | Predicted actions, zero mutations |
| `/automations/{id}/enable` | versionId | Validate owner/scope and activate |
| `/automations/{id}/disable` | reason optional | Stop future not-started runs |
| `/automation-runs/{id}/retry` | reason | Same operation keys |
| `/imports/{id}/validate` | mapping, policies | Staged validation report |
| `/imports/{id}/commit` | validationToken, warningsAccepted | Atomic dataset application |
| `/imports/{id}/undo-preview` | reason | Dependency check |
| `/imports/{id}/undo` | previewToken | Eligible untouched drafts only |
| `/exports/{id}/download` | request token optional | Recheck access, temporary delivery |
| `/jobs/{id}/cancel` | reason optional | Safe cancellation request |
| `/notifications/{id}/read` | read=true | Own state only |
| `/notifications/mark-read` | validated filter snapshot | Own matching notifications |
| `/entities/archive-preview` | typed entityRefs | Open obligations and permitted effects |
| `/entities/archive` | previewToken, resolutions | Archive without history loss |
| `/entities/trash` | typed entityRefs, reason | Eligible drafts only |
| `/entities/restore-preview` | typed entityRefs | Dependency/unique collision preview |
| `/entities/restore` | previewToken, resolutions | Restore with current authorization |
| `/entities/purge` | previewToken, typed confirmation, recentAuth | Owner, eligible trash only, async purge job |

### 25.4. Read models и отчёты

`GET /overview` принимает period/scope, возвращает permitted KPI definitions + values + coverage + source drilldown filters. `GET /my-work` возвращает typed actionable rows. `GET /analytics/query` либо `POST /analytics/query` для сложного typed filter возвращает table/chart series с units и provenance. POST query read-only, CSRF всё равно проверяется. `GET /search`, `/workload`, `/calendar`, `/ofm/overview`, `/system/health`, `/archive`, `/events` используют собственные typed schemas и одинаковые ACL rules. `/system/health` доступен Admin; публичный `/health/live` возвращает только статус процесса, без метаданных инфраструктуры.

В финальном OpenAPI описать каждый ресурс, команду, error code, permission и idempotency requirement. Сгенерировать typed API client из этого контракта; frontend не имеет отдельной ручной копии enums, расходящейся с server domain.
