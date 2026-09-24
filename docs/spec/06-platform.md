# Castlane CRM — Specification part 6: automations, notifications, search, import/export, security (sections 19–23)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 19. Автоматизации и фоновые действия

Разрешённые triggers: content.submitted, content.approved, content.changes_requested, publication.published, task.due_soon, task.overdue, checkpoint.due, checkpoint.overdue, shift.ended, shift.report_overdue, handover.unacknowledged, budget.threshold_crossed, account.metrics_stale, deal.stage_changed, scheduled daily/weekly/monthly.

Разрешённые conditions: scope, project type, format, status, assignee, tags, elapsed duration, numeric threshold с known values. Разрешённые actions: create task from template, assign eligible member, create checkpoint, create in-app notification, request internal approval, create incident, generate internal report. Нельзя автоматически approve контент, post/reverse finance, менять роли, удалять записи или отправлять внешнее сообщение партнёру/клиенту.

Rule execution principal = сервисный actor с пересечением разрешений rule owner и declared scope. При недействительном owner/permission — Paused Requires Attention. После сохранения domain event в той же transaction пишется OutboxEvent. Worker читает outbox at least once; consumer делает idempotent insert по event_id+rule_version+action_index. Не обещать exactly-once network delivery; обеспечить одинаковый наблюдаемый доменный результат.

Causation chain: root_event_id, parent_event_id, depth. Максимальная глубина 5; event этого же rule не может рекурсивно повторить rule в одной chain. Action budget ≤50 created tasks/notifications per root event, иначе остановка и alert. Rule rate default 100 runs/hour; превышение throttled, без потери исходного event. Deadline-based rules используют уникальный key entity+deadline_revision+threshold.

Retry policy для transient jobs: 30 s, 2 min, 10 min, 30 min, 2 h; максимум 5 retries после первой попытки. Permanent validation/permission error не retry автоматически. Dead-letter виден S71, ручной Retry сохраняет operation key и делает повторную авторизацию. Job heartbeat и lease исключают одновременное исполнение одного claimed job; завершение определяется committed result.

## 20. Уведомления и коммуникация

Обязательный канал — In-App Inbox. Email используется для invitations, password recovery, security alerts и опционального daily digest. Браузерные push не обязательны, не показывать неработающий переключатель. В production настройка SMTP или совместимого transactional email transport обязательна для приглашений/восстановления; local development использует local mailbox sink с явной маркировкой.

Notification содержит event type, recipient, safe title, permitted excerpt, target reference, read_at, archived_at, delivery state. Например: Review requested; Changes requested; Publication due; Metrics update needed; Shift report awaiting review; Payment recorded. Финансовые суммы и OFM contact alias по умолчанию не выводятся в email subject/body и lock-screen подобные previews.

Preferences: immediate mentions, assignments, review requests, due reminders; optional digest; quiet hours default 22:00–08:00 personal timezone, editable. Quiet hours откладывают email digest/обычные уведомления, но Inbox records создаются сразу. Security alerts не подавляются quiet hours. Дедупликация event+recipient+channel; повтор события не увеличивает unread count.

Due reminders default task 24h и 1h до срока, publication 1h и 15min, shift 30min; для задания, созданного позже threshold, не слать все missed reminders, только ближайшее актуальное. On completion/cancel будущие reminders отменяются. При reschedule старая deadline revision становится stale и её job ничего не отправляет.

Comments и mentions внутри объектов — рабочая коммуникация. Общего чата и внешнего email composer в scope нет. Это не мешает полному workflow: решения, вопросы, attachments и поручения связаны с конкретными записями и находят адресата через Inbox.

## 21. Поиск, фильтры, пользовательские поля и локализация

Search backend использует PostgreSQL full-text для документов и trigram для titles/handles при установленном поддерживаемом расширении. Indexed content: project/task/content/reference/article/deal titles и разрешённые тексты. Contacts, finances и audit — отдельные permission-gated datasets. Нельзя сначала искать всё и фильтровать лишь top 10 на клиенте: permissions включены в query и aggregate count.

Global search не индексирует passwords, MFA, SMTP credentials, signed URLs, hidden finance values для обычного пользователя и binary content. Search snippets строятся из accessible fields. Account scopes и assigned-object scopes применяются до pagination. Saved Views содержат typed filter AST, не SQL; operators Equals, Not Equals, In, Contains, Before, After, Is Empty, Is Not Empty. Сервер ограничивает 30 clauses и depth 3.

Custom Fields: Short Text, Long Text, Number, Date, DateTime, Single Select, Multi Select, Checkbox, URL, Member Reference. На один entity type до 30 active fields. RequiredAtStage применяется только на переходе в stage, existing records получают Needs Completion, не исчезают из UI. Number field хранит unit и precision. Нельзя создать поле, которое само меняет finance totals или permissions. Archive сохраняет values и historical labels. Type change после использования — новая definition и явная migration preview.

UI language English, пользовательский контент допускает русский и другие языки. Все системные строки вынести в dictionary keys для будущего перевода; даты/числа форматировать через locale preferences, сохранять канонически. Экспорт использует явные ISO dates, decimal separator и currency column. Английские названия в этом документе — базовый словарь, не placeholders для lorem ipsum.

## 22. Импорт, экспорт, архив и жизненный цикл данных

### 22.1. Импорт

Supported CSV datasets: Projects, Accounts, Tasks, References, Metric Observations, OFM Contacts, Sale Candidates, Financial Drafts, FX Rates. XLSX импорт поддержать для тех же datasets через безопасное чтение без выполнения formulas/macros. Memberships/roles/passwords и raw database backup не импортируются через обычный Import Center. Binary media bulk upload — Library, не URL downloader.

Workflow: upload quarantine → parse to staging → map columns → validate syntax/references/permissions/duplicates → immutable validation report → preview adds/updates/skips/errors → explicit Confirm → commit → result and audit. Preview показывает первые 100 строк плюс downloadable full error report; результат содержит counts и IDs. Confirm доступен только при zero blocking errors; предупреждения требуют acknowledgement.

CSV default UTF-8, BOM допускается, delimiter comma/semicolon определяется с preview; даты ISO либо явно выбранный format. Числовые separator не угадывать при неоднозначности 1,234. Formula cells XLSX не вычислять: импорт cached value только при явном подтверждении и label Cached Formula Value; отсутствие cached value — error. Macros/embedded external links не запускать.

Limit 20 MB или 20000 rows на job. Валидированный batch применяется атомарно через staged set в transaction с timeout budget; если превышает проверенный operational предел, отклонить до commit с конкретным лимитом/рекомендацией разбить файл. Не допускать частично применённый job, который UI называет Failed Without Changes. Financial import создаёт только Draft/SaleCandidate и не auto-posts.

Mapping должен хранить stable foreign IDs или требовать явный выбор при ambiguous name. Unknown project/member/account — blocking error, не auto-create скрытых entities. Duplicate policy per dataset: Skip, Revise Existing (только изменяемые поля) или Error. Нет generic Replace Database. На commit повторно проверить current target row_versions и permissions; change → Needs Revalidation.

Undo Import доступен только для созданных этим job неизменённых drafts без зависимостей; preview и transaction. Если уже появились связанные записи — показать список препятствий и предложить archive/manual correction, не обещать полный rollback спустя дни.

### 22.2. Экспорт

CSV/XLSX — таблицы и raw permitted records; PDF — читаемый report с названием, period, scope, as-of, formulas summary, source coverage, page numbers. ZIP — approved episode/content package с manifest.json, файлами, subtitles и metadata, если все assets доступны пользователю. Экспорт не включает passwords, MFA, private access tokens. CSV/XLSX защищать от spreadsheet formula injection: untrusted текстовые значения, начинающиеся с =,+,-,@ или управляющего whitespace, экспортировать как безопасный текст, не ломая числовые typed columns.

Export job фиксирует filters/fields/requester и source snapshot boundary. File TTL 7 дней; download authorization одноразовая или короткая, 5 min. Размер >500 MB ZIP требует background multipart streaming; не держать весь архив в RAM. Export quota: 5 active jobs/user и 20/workspace. Cancel прекращает future processing и удаляет partial private artifact. Ошибка не выдаёт пустой файл как Completed.

### 22.3. Архив, корзина, хранение

Archive — бизнес-состояние, без удаления истории. Trash — soft delete только eligible drafts, default 30 дней, с restore preview. Permanent purge удаляет blob derivatives и indexes, учитывает held references. Audit хранится default 24 месяца; operational logs 30 дней; job debug logs 14 дней; expired export files 7 дней; orphan uploads 24 h. Financial document retention default 7 лет как изменяемая эксплуатационная настройка, не утверждение юридического срока для каждой страны. Owner должен настроить policy под свой реальный учёт до production.

OFM contact business notes retention default 180 дней после archive, configurable; financial references могут быть pseudonymized вместо удаления экономических фактов. Удаление/обезличивание выполняется queued job с progress, retry и результатом по системам. Backups имеют отдельный expiry; после disaster restore replay deletion tombstones до открытия доступа пользователям. Нельзя обещать немедленное удаление из ещё не истёкшей immutable backup.

## 23. Авторизация, приватность и безопасность

### 23.1. Учётные записи и сессии

Email/password + TOTP MFA. Password length 12–128 символов, разрешены пробелы и password manager paste; не делать обязательный набор uppercase/symbol, не обрезать пароль. Hash через поддерживаемую реализацию Argon2id с параметрами, измеренными на production class machine; secret pepper хранится отдельно при использовании. Не писать собственную криптографию. MFA mandatory для Owner/Admin/Finance approvers; для остальных Workspace policy.

Cookies HttpOnly, Secure, SameSite=Lax, host-only, path `/`; сессия хранит opaque random identifier, hashed server-side. Idle timeout 12 h, absolute 7 дней; финансовое проведение, права, MFA и backup/download-sensitive требуют recent authentication ≤15 min. Critical access change отзывает необходимые сессии, reset password отзывает все, текущую создаёт заново после входа. Recovery codes hashed и одноразовые. TOTP secret encrypted at rest отдельным managed key, не password hash.

CSRF protection для cookie-auth mutations, проверка Origin/CSRF token, CORS deny по умолчанию. GET не меняет данные. Logout POST инвалидирует сессию и очищает browser caches приложения. Не хранить bearer tokens в localStorage. Защита от brute force: 5 failed attempts за 15 min для account/IP bucket, progressive delay, 429 с Retry-After; account existence не раскрывается. Rate limit не блокирует весь shared office навсегда.

### 23.2. Контроль доступа

Authorizer вызывается в каждом use case, не только в middleware или UI. Проверять workspace membership, action permission, object scope, sensitivity и effective dates. Фильтрация списков выполняется до aggregation/pagination. DB role приложения без superuser; фоновые workers используют scope из job, не обходят policy «потому что это сервер».

Документ использует deny-by-default и проверку каждого запроса как базовые принципы контроля доступа. Эти принципы описаны в [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html). Конкретная role/scope модель выше является проектным решением этой CRM.

### 23.3. Файлы и сеть

Private buckets; uploads в quarantine, download только после authorization. Presigned credentials короткоживущие и считаются bearer secret; срок URL не делает его автоматически одноразовым. Стандартные файлы: URL TTL ≤5 min, уже выданная ссылка может работать до истечения срока. Restricted media и finance evidence: authorization proxy/stream с проверкой текущей membership, без прямой долговременной ссылки. Перед revoke UI честно объясняет, что скачанный файл отозвать невозможно. Механика временных URL описана в [Amazon S3 documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

Upload reservation включает allowed MIME, byte limit, object key, expected checksum; завершение сверяет actual object metadata. Не доверять Content-Type браузера и расширению. Проверять decoded image bounds, запрещать archive bombs и executable previews; processing выполняется без доступа к production secrets в изолированном worker. Подход к allowlist, проверкам содержимого и изоляции загрузок согласуется с [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

External links только https/http для редактируемых notes, open предпочтительно https; javascript:, data:, file: и internal app schemes из пользовательского поля запрещены. На external link ставить noopener/noreferrer. Не делать произвольный backend fetch. SSRF отсутствует по конструкции для link-only соцаккаунтов. Service email и object storage connections задаются deployment secrets, пользовательские формы не принимают произвольный SMTP host без Admin setting и network policy.

### 23.4. Защита данных

TLS на внешних соединениях; encrypted disks/backups/object storage. Rich text sanitization, parameterized SQL, content security policy без unsafe-eval, минимальный набор script origins. Не вставлять server-only secrets в public environment variables. Не доверять filename, CSV headers, imported HTML и данным из reference notes как инструкциям серверу или агенту.

Audit фиксирует входы/сбои MFA, приглашения, смену прав, assignment transfer, approval/revoke, financial post/reverse, payout records, import/export, archive/purge, compensation calculation/approval, workspace settings. Fields diff исключает password/token/secret и чувствительный текст. Correlation ID помогает расследованию без дампа всего HTTP body. Production debug logs с raw contact notes и financial evidence запрещены.

Workspace-level ownership не означает публичного доступа. Workspace IDs в URL не являются secret, но всё содержимое проверяется. Private pages получают noindex; персональные ответы Cache-Control private/no-store, finance/auth no-store. Общие CDN caches никогда не содержат user-specific counts, file credentials и scope-limited HTML.
