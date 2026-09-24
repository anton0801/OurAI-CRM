# Castlane CRM — Specification part 3: roles, permissions & data model (sections 7–8)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 7. Роли, обязанности и вычисление прав

### 7.1. Системная модель

User — личность для входа. Membership — участие пользователя в workspace. Role — набор permissions. RoleAssignment — роль плюс scope. Responsibility — рабочая обязанность, не источник разрешений. ProjectMember/AccountAssignment — назначение, которое ограничивает предметную область роли, но само по себе не выдаёт чувствительные permissions.

Scope types: Workspace, Direction, Project, Account, AssignedObject, OwnRecords. Один пользователь может иметь несколько RoleAssignments. Для обычного действия достаточен хотя бы один grant, который покрывает и действие, и объект. Явный deny для membership/object и sensitivity gate имеют приоритет. Финансовые, OFM contact, restricted media и export permissions проверяются отдельно; обычный project.read не даёт их.

Owner получает все предметные permissions, но не обходит обязательный audit, idempotency, неизменяемость posted документов и запрет удаления последнего Owner. Admin управляет системой и доступами в разрешённом наборе; доступ к финансам выдаётся отдельно. Только Owner назначает Admin, выдаёт finance.manage и передаёт владение. Передача: recent MFA обоих участников, принятие получателем, атомарное изменение; прежний Owner становится Admin, если не выбран иной доступ.

### 7.2. Стартовые роли

| Role | Scope по умолчанию | Разрешено | Не включено автоматически |
|---|---|---|---|
| Owner | Workspace | Все рабочие модули, конфигурация, finance, ownership | Обход доменных ограничений |
| Admin | Workspace | Team, settings, operational modules, audit | Finance amounts, payout approval, OFM contacts/restricted media без явного grant |
| Direction Lead | Назначенные направления | Projects, team assignments, production, schedules, scope analytics, reviews | Глобальные roles, Owner transfer, частные финансы других направлений |
| Project Lead | Назначенные проекты | Project settings, tasks, content, accounts, approve, scope reports | Изменение системных ролей и финансов по умолчанию |
| Producer | Назначенные проекты | Briefs, production planning, versions, task assignment | Final approval собственных материалов, finance |
| Creator | Назначенные проекты/объекты | Собственные tasks, versions, comments, time | Управление командой, финансы, final approve |
| Publisher | Назначенные аккаунты | Plan/confirm publications, metrics entry, approved files | Изменение approved originals, finance |
| OFM Manager | Назначенные аккаунты и смены | Shifts, handovers, permitted contacts, operations, sale candidates | Проведение финансов, чужие смены и контакты |
| OFM Supervisor | Назначенные проекты/аккаунты | Schedule, assignments, report approval, quality, operational analytics | Workspace finance без отдельного разрешения |
| Analyst | Выданные scopes/datasets | Metrics, corrections review, reports, goals | Raw OFM notes, team compensation, изменение production |
| Finance Manager | Выданные finance scopes | Ledger, reconciliation, budgets, compensation calculation/approval по grants | Membership/role administration |
| Contractor | Явно назначенные объекты | Brief, attachments, task state, собственные uploads/comments | Просмотр проекта целиком, directory команды, dashboards |
| Viewer | Выданный read scope | Чтение обычных данных | Любая mutation/export/sensitive data без дополнительного grant |

Каждый role preset хранится как редактируемая копия, кроме защищённого Owner. Responsibility options: Direction Management, Producing, Writing, Image Generation, Video Generation, Voice, Editing, Quality Review, Publishing, Analytics, OFM Operations, Finance. Несколько обязанностей не означают нескольких учётных записей.

### 7.3. Каталог permissions

Identity: workspace.read/update; members.read/invite/update/suspend; access.read/manage; ownership.transfer; audit.read/export; security.sessions.revoke.

Production: directions.read/manage; projects.read/create/update/archive; project.members.manage; characters.read/write/approve; series.read/write; accounts.read/write/assign/archive; references.read/write; content.read/create/edit/upload/submit/approve/archive; tasks.read/create/edit/assign/complete/reopen; time.read.own/read.scope/write.own/approve; workload.read/manage; publications.read/write/confirm/correct; campaigns.read/write; experiments.read/write; partners.read/write; deals.read/write.

Media: assets.read/upload/download/link/archive; assets.restricted.read; knowledge.read/write/publish; knowledge.acknowledge. Download и read отличаются; server preview derivative не должен автоматически раскрывать original URL.

OFM: ofm.overview.read; ofm.assignments.manage; shifts.read.own/read.scope/schedule/start.own/end.own/correct/approve; handovers.read/write/acknowledge; contacts.read/write/merge/export/erase; operations.read/write; quality.read.own/read.scope/write/publish; sale-candidates.write/review.

Insights: metrics.read/write/revise/approve; analytics.production/accounts/content/ofm/team/finance.read; reports.read/create/share/schedule; goals.read/write; imports.create/commit; exports.create/download.

Finance: finance.read/create/submit/post/reverse/allocate/close-period; settlements.create/confirm/reverse; budgets.read/write/approve; compensation.rules.read/write/approve; compensation.runs.read/calculate/approve; compensation.own.read; payments.record; finance.documents.read.

Automation: automations.read/create/edit/enable; system.jobs.read/retry; backups.status.read; retention.manage; custom-fields.manage; templates.manage.

### 7.4. Недопустимые утечки

Проверять доступ на list, detail, counts, autocomplete, search snippets, CSV/PDF, chart drilldown, notification body, file preview, signed download, SSE events, background jobs. Доступ к задаче подрядчика даёт специально отобранный brief и разрешённые вложения, а не произвольное чтение Project по ID. Shared file может иметь несколько контекстных связей; выдавать только разрешённую проекцию metadata, скрывая названия чужих usage links.

При снятии роли invalidation permission cache немедленно; новая API-операция проверяет актуальную membership version. Уже загруженный на устройство файл технически нельзя отозвать. Новые скачивания блокируются; для особо чувствительных файлов использовать авторизованный streaming proxy без публичного presigned download.

## 8. Данные, связи и общий словарь

### 8.1. Базовые типы и ограничения

Все tenant-owned таблицы: id UUID, workspace_id, created_at/updated_at timestamptz UTC, created_by/updated_by, row_version bigint. Поля archived_at/deleted_at добавляются там, где разрешён соответствующий lifecycle. Для ссылок между tenant таблицами — составные foreign keys (workspace_id, referenced_id), чтобы нельзя было связать разные workspace.

Text: short name 2–120, task title 3–200, handle до 100, URL до 2048, note до 10000, rich text document до 200000 символов после нормализации. Обрезка без предупреждения запрещена. Tags: до 30 на объект, длина 2–40, case-insensitive uniqueness в workspace. Список поддерживаемых language codes — справочник; свободный текст не используется для агрегации языков.

День без времени хранится как date. Moment хранится UTC + IANA timezone контекста; исходный локальный ввод и offset сохраняются для расписаний. Money — amount_minor bigint и currency code, если это фактическая денежная сумма; FX rates и unit rates — numeric decimal. API передаёт большие целые и decimal строками. Floats для финансов запрещены. Percent сохраняется decimal 0–100 с максимум 4 знаками после запятой.

### 8.2. Основные сущности

| Entity | Обязательные данные и связи | Инварианты |
|---|---|---|
| Workspace | name, timezone, base_currency, settings_version | Один активный workspace в начальном deployment, схема поддерживает изоляцию нескольких |
| User | normalized_email, display_name, password_hash, status | Email unique, исходный display email отдельно |
| Membership | workspace, user, status, manager, capacity profile | Unique workspace+user |
| Role / Permission | stable key, name, permission keys | Owner preset защищён |
| RoleAssignment | membership, role, scope_type/id, valid interval | Нельзя выдавать scope вне workspace |
| ResponsibilityAssignment | membership, duty, scope, interval | Не выдаёт permissions |
| Invitation | email, role proposals, scope, token_hash, expiry, accepted_at | Token hash, одноразовость |
| Session / MFASecret / RecoveryCode | user, expiry/revocation; encrypted secret; code_hash | Секреты не сериализуются в обычные API |
| Direction | name, lead_member_id, status | Lead active membership |
| Project | type, direction, name, owner, status, brief, ofm_enabled | Один primary owner, стабильный type после dependent data |
| ProjectMembership | project, member, responsibility, effective interval | История назначений |
| Character / CharacterVersion | project, name; version_no, profile, references, state | Approved version immutable |
| Season / Episode / Scene | project; season+number+language; episode+order | Сцена ссылается на character versions, не на будущие значения |
| SocialAccount | project, platform, canonical_url, handle, owner, status | Unique workspace+platform+canonical identity |
| AccountAssignment | account, member, duty, valid interval, supervisor | Assignment history append/versioned |
| AccountIdentityHistory | account, old/new handle/url, effective_at, reason | Старые публикации не переписываются |
| Reference | title, explanation, source_url/file, owner, visibility | Минимум один источник |
| ReferenceLink | reference, permitted target_type/id | Foreign scope checks |
| ContentItem | project, format, title, stage, owner, reviewer, due, current/approved versions | Content не хранит суммарные результаты как источник истины |
| ContentVersion | content, version_no, submitted_assets, brief snapshot, character version refs | После submission только новая версия |
| Review / ReviewDecision | target version, reviewer, status, revision; decision, reason | Одно действующее финальное решение на review round |
| Comment / Annotation | parent, author, body, version, timecode or normalized coords, blocker | Комментарий относится к конкретной версии |
| Task / TaskChecklistItem | project, optional related target, title, assignee, status, estimate, dates | Одна primary task responsibility |
| TaskDependency | predecessor, successor, kind FinishToStart | Ациклический граф |
| TaskStatusEvent | task, from/to, occurred_at, actor, reason | Источник cycle-time |
| RecurrenceRule / Occurrence | template, timezone, cadence, next_at; occurrence_key | Unique rule+scheduled occurrence |
| TimeEntry / Timer | member, task, start/end/duration, state | Один active timer; closed interval положителен |
| Capacity / Absence | member, weekday hours; start/end/reason category | Private reason может быть скрыт от коллег |
| Publication | content, asset_version, account, owner, plan/actual dates, external_url, status | Всегда отдельная запись на account+placement |
| PublicationPlanRevision | publication, planned_at, changed_at, actor, reason | Базовый план и переносы доступны аналитике |
| Campaign / CampaignProject | name, owner, objective, dates; linked projects | Budget references отдельно |
| TrackingLink | campaign, destination, utm fields, label | Без собственного click counter |
| Experiment / Variant | hypothesis, metric/window; linked publications | Результат хранит limitations |
| Asset / AssetVersion | logical asset; immutable storage key, checksum, MIME, size, status | Blob принадлежит одной immutable version |
| AssetLink | asset version, entity, role, scope classification | На чтении пересечение grant и sensitivity |
| Folder | parent, name, scope | Нет циклов, depth ≤6 |
| Article / ArticleVersion / Acknowledgement | title/scope; version body; member+version+time | Read acknowledgement явный |
| OFMProfile | project, supervisor, settings | Unique project; нет второй карточки модели |
| Shift | primary_account, member, scheduled interval, lifecycle, actual interval | Одна активная смена на member |
| ShiftAccount | shift, account, coverage_lane, time_allocation_share optional | До 10 accounts вместе с primary; assignment покрывает весь interval |
| ShiftBreak | shift, start, end | Без пересечения и за пределами actual interval |
| ShiftReport / ShiftReportVersion | shift, summary, source refs, state | Approved revision immutable |
| Handover / HandoverItem | from_shift, recipient, state; existing task/operation ref | Без размножения одного open item |
| OFMContact | account, external_identifier, alias, manager, stage | Unique account+external identifier |
| InteractionLog | contact, member, occurred_at, type, business note | Ручное происхождение, не fake platform inbox |
| Operation | account, contact optional, owner, type, due, status, outcome | Complete не означает revenue |
| SaleCandidate | account, source transaction ID, contact/shift, amount, currency, source, review state | Не включается в posted finance до review |
| QualityReview / RubricVersion | subject, reviewer, scores, evidence; criteria and weights | Frozen rubric для published review |
| MetricDefinition | key, entity_type, unit, aggregation, time_semantics, platform definition | Metric definition versioned |
| MetricObservation / MetricValue | entity, observed_at, period, source, revision; definition+value | Вид наблюдения определяет допустимую агрегацию |
| MetricCheckpoint | publication/account, policy version, expected_at, state | Unique entity+checkpoint occurrence |
| Goal / GoalRevision | metric, scope, owner, period, target | Изменение цели сохраняет baseline |
| SavedReport / ReportSnapshot | dataset, config, scope; generated_at, source revision bounds | Snapshot не обновляется задним числом |
| FinancialEntry / EntryLine | document, state, recognition date; category, amount, currency, project allocation | Posted line immutable; balanced allocation |
| FinancialAllocation | line, project/campaign, amount_base, rule snapshot | Сумма allocation равна распределяемой сумме |
| FXRateSnapshot | pair, rate, effective_date, source, entered_by | Использованный rate не меняется задним числом |
| Settlement / SettlementAllocation | cash direction, date, currency, reference; target entry/run, amount | Partial settlement не превышает outstanding без advance |
| Budget / BudgetVersion / BudgetLine | scope, period, currency; version; category amounts | Только Approved версия является действующей |
| Commitment | project, amount, category, due, linked expense | Consumed commitment не суммируется с Actual |
| CompensationRuleVersion | recipient scope, basis, rate, effective dates, stacking | Approved rule неизменяем |
| CompensationRun / CompensationLine | period, state; source entitlement, recipient, amount, rule version | Entitlement уникален между approved runs |
| Adjustment | target, amount, reason, reversal link | Изменяет отдельной строкой, не уничтожает источник |
| PeriodLock | workspace, period, locked_by/at, scope | Запрещает posting в закрытый период без audited reopen |
| Partner / Deal / Deliverable | business identity; stage/amount; linked content/tasks | Contract amount не равен recognized revenue |
| Notification / Preference | recipient, event, read/archive; channel/quiet hours | Unique event+recipient+channel |
| AutomationRuleVersion / Run | trigger/conditions/actions/scope; event+version+result | Run idempotent |
| CustomFieldDefinition / Value | entity scope/type/options; entity+definition+value | Type immutable после использования без migration |
| TemplateVersion / Application | structured tasks/checklists; target+template+application key | Повтор application не клонирует задачи |
| ImportJob / ImportRow | hash, mapping, state, validation; staged rows/diff | Preview до commit |
| ExportJob | requester, scope, fields, source bounds, state, expiry | Private artifact и повторная проверка прав |
| AuditEvent / OutboxEvent | actor, action, subject, diff; domain event envelope | Append-only для приложения |
| Incident | kind, severity, account/project, owner, state, resolution | System и Operational разделены |

Для polymorphic связей использовать реестр разрешённых target types, проверку workspace/scope и явные domain link tables для критичных связей. Не хранить всё приложение в одном JSON document. JSONB допускается для versioned rich text, template config и typed custom field values; часто фильтруемые поля и связи — нормализованные колонки.

### 8.3. Общие индексы и удаления

Индексы: workspace+status+updated_at+id для списков; workspace+assignee+due_at для задач; account+actual_published_at; entity+metric definition+observed_at; recognition_date+project для финансов; workspace+actor+occurred_at для аудита. Уникальные источники финансов защищать DB constraint, а не только preflight query. Soft delete не снимает уникальность исторического внешнего transaction ID.

Delete cascades ограничить truly owned ephemeral children черновика. Нельзя каскадом удалить finance, approved versions, publication history, time entries или audit при удалении пользователя/проекта. Для исторического автора хранить user reference и безопасный display snapshot; после обезличивания отображать Former Member.
