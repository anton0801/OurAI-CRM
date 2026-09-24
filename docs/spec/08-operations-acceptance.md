# Castlane CRM — Specification part 8: architecture, operations, a11y, acceptance, delivery, defaults, traceability, extra contracts (sections 26–33)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 26. Архитектура, код и фоновые процессы

### 26.1. Предлагаемый стек

Responsive web на TypeScript и Next.js App Router; backend REST route handlers как тонкий transport слой, domain/application packages независимо от UI. PostgreSQL — основной источник истины. Private S3-compatible object storage — файлы. Отдельный Node.js worker — media, reports, imports, reminders, outbox, email. PostgreSQL-backed job queue с locking и leases достаточна для стартового целевого масштаба; Redis не обязательная новая точка отказа. SMTP adapter для служебных писем. SQL migrations и typed parameterized repository layer. Сначала проверить существующий repository; при отсутствии создать monorepo.

Версии не брать наугад из старого примера. Перед реализацией сверить совместимость Node/Next/React/TypeScript/PostgreSQL/драйвера, выбрать поддерживаемые stable releases и зафиксировать lockfile, runtime version и matrix в README. Предварительно выбранные библиотеки для UI: Tailwind CSS, @phosphor-icons/react; table/calendar/chart компоненты можно реализовать или выбрать после проверки лицензии и доступности необходимых keyboard interactions. Не ставить одновременно несколько конкурирующих UI kits.

Server Components использовать для shell и начальных авторизованных read models; интерактивные forms, filters, boards, calendars, media viewer и charts — client boundaries. Не помещать весь root в use client ради одного drawer. Разделение server/client соответствует [Next.js documentation](https://nextjs.org/docs/app/getting-started/server-and-client-components). Browser code не импортирует repositories, secrets и server-only modules.

### 26.2. Структура репозитория

```text
apps/web
apps/worker
packages/domain
packages/application
packages/authorization
packages/database
packages/api-contracts
packages/api-client
packages/ui
packages/analytics
packages/storage
packages/notifications
packages/test-fixtures
infra
docs/architecture
docs/runbooks
tests/integration
tests/e2e
tests/security
tests/performance
```

Domain modules: identity, organization, projects, accounts, production, tasks, publishing, media, knowledge, ofm, metrics, analytics, finance, partnerships, automations, imports-exports, audit. Каждый модуль содержит entities/value objects, domain rules, use cases, repository ports и tests. Transport code вызывает use case, не реализует отдельную финансовую арифметику. Modules общаются через application services и domain events; circular dependency предотвращается build boundaries.

Domain functions для money, allocation, compensation, dates, transitions и metric aggregation детерминированы, принимают clock/rate snapshot явно. Date.now и random generation не спрятаны внутри расчётов. Decimal math и currency minor-unit справочник централизованы.

### 26.3. Jobs и media

Worker pools: light notifications/outbox, data imports/reports, isolated media processing. Тяжёлое видео не должно задерживать reset password email. Job record содержит type, payload schema version, scope, requester, attempt, lease, next_attempt_at, progress, error_code, causation, idempotency key. Payload не содержит plain credentials и large files; только private references.

Outbox dispatcher отмечает delivery attempts, consumers идемпотентны. Shutdown прекращает claim новых jobs, текущие завершаются до grace timeout или возвращаются в очередь по lease expiry. Long jobs отправляют heartbeat и progress milestones; прогресс не достигает 100% до committed final artifact.

Metric aggregates обновляются инкрементально по source revisions. Source facts остаются первичными; rebuild materialized read models воспроизводим. Отчёт показывает Aggregated Through timestamp. Свежая detail page после сохранения читает commit-consistent record, не stale analytics cache. Invalidations по workspace+scope+dataset revision, без смешения пользователей.

### 26.4. Frontend state и ошибки

Server state cache keyed workspace+user permission revision+resource filters. После logout cache очищается; после role update scope caches invalidated. Form state локальный, server snapshot separate. Optimistic updates допускаются для own notification read, local ordering и non-critical tags с rollback. Approval, finance, import commit, shift start/end и publication confirm показывают server-confirmed result.

Error boundary на route и отдельно тяжёлый chart/media component. Ошибка графика не блокирует таблицу. Network retry read: максимум 2 с backoff, mutations только через idempotency и явную safe retry policy. Не показывать success toast до response/operation confirmation. Невалидная ссылка на объект даёт recoverable Not Found с Back, без бесконечного redirect loop.

### 26.5. Совместная работа

Два пользователя видят события изменения после SSE invalidation. Если открыта dirty form, показать Updated by another member — Compare Changes, не перезаписывать ввод. Rich text применяется document revision целиком с conflict compare; многопользовательский character-by-character CRDT не обещается. Comments создаются независимо, разрешённый Edit Comment добавляет append-only text revision и отметку Edited вместо уничтожения исходного audit. Review/finance конкурентные решения защищаются transaction locks и row_version.

## 27. Развёртывание, резервные копии и эксплуатация

### 27.1. Среды и конфигурация

Development, Staging, Production изолированы по DB, storage, credentials и email delivery. Production не копируется в dev без обезличивания. Docker images non-root, pinned base versions, health checks, graceful shutdown. Local compose поднимает web, worker, PostgreSQL, S3-compatible storage и mail sink; сервис scanner/renderer включён в dev pipeline или явно ограничивает previews до завершения реального check.

Environment schema: APP_ORIGIN, DATABASE_URL, SESSION_SECRET, MFA_ENCRYPTION_KEY, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET_PRIVATE, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM, JOB_CONCURRENCY, MAX_UPLOAD_BYTES, BACKUP_STATUS_ENDPOINT_INTERNAL optional. Обязательные production settings валидируются на startup. PUBLIC-prefixed variables не содержат secrets. `.env.example` содержит только имена и безопасные illustrative values, не реальные ключи.

DB migrations: expand/migrate/contract, forward-compatible rollout; schema change сначала поддерживается старым и новым процессами. До destructive migration — backup и rehearsal staging. Ошибка migration не оставляет приложение запущенным с несовместимой схемой. Rollback приложения возможен только при совместимости данных; иначе documented forward fix. Не выполнять production deploy, рассылку приглашений или перенос реальных данных без соответствующего явного разрешения владельца среды.

### 27.2. Резервные копии и восстановление

Целевые RPO≤15 min, RTO≤4 h для согласованной production конфигурации. Это проверяемые эксплуатационные цели, не обещание без настроенной инфраструктуры. PostgreSQL: continuous WAL/PITR, daily encrypted snapshot, retention 30 дней. Storage: versioning/replication либо согласованный backup policy для originals, independent of DB snapshots. Ключи шифрования резервируются отдельно с ограниченным доступом.

Ежемесячно автоматизированный restore drill в изолированную среду: восстановить DB до timestamp, сверить manifest файлов, прогнать integrity checks, apply deletion tombstones, запустить smoke workflows, удалить test restore. Фиксировать duration, recovered timestamp, missing objects, проверенные counts и результат. UI S71 показывает отдельно Backup Last Success и Restore Last Tested. Наличие backup file не равно доказанной восстановимости.

Disaster runbook: закрыть mutations → выбрать recovery point → restore database → verify storage refs → replay tombstones/revocations → invalidate sessions/tokens по incident policy → consistency checks → operator review → открыть приложение. Scheduled jobs после восстановления используют idempotency/source keys и не повторяют финансовые действия.

### 27.3. Наблюдаемость

Structured logs с request_id/job_id/workspace pseudonymous identifier и error_code; без raw sensitive bodies. Метрики: request latency/error rate, DB pool, slow queries, worker lag, retry/dead-letter count, uploads failed, pending scans, mail failures, storage quota, backup age, oldest unprocessed outbox, auth anomalies. Trace по web→use case→DB→outbox→worker. Упавший chart клиентской библиотеки виден в frontend error monitoring без утечки содержимого формы.

Alerts: API 5xx >2% за 5 min при минимуме 100 requests; worker oldest due job >10 min; backup age >26 h; outbox lag >5 min; storage >85% quota; scan queue stalled >15 min; critical finance integrity assertion любое. Пороги — editable operational defaults. Ошибки повторно группируются по fingerprint, а не сотней одинаковых писем.

### 27.4. Интеграция Dramora в будущем

Сейчас предусмотреть только internal stable IDs, external reference namespace и versioned domain events. Таблица ExternalReference может хранить namespace/string ID после ручного ввода; пустая по умолчанию, не требует рабочего API Dramora. В UI не показывать Connect Dramora как доступную функцию. Future integration будет отдельным модулем с API contract, access credentials, permissions, retry/dedup, conflict policy и источниками продуктовой аналитики. Текущий deployment полностью работает без неё.

## 28. Доступность, адаптивность и производительность

### 28.1. Desktop, tablet, mobile

≥1280 px: полный sidebar, table/board/timeline, 560/760 px drawer. 1024–1279: sidebar collapsed по умолчанию, padding 24, wide drawer максимум viewport−96. 768–1023: sidebar как overlay по кнопке, padding 20, 2-column формы только при ≥640 px полезной ширины. <768: padding 16, один column, sticky topbar 56, drawer fullscreen, bottom action bar с safe-area; calendar Agenda, workload список по дням, boards доступны horizontal swipe без горизонтальной прокрутки всей страницы.

На телефоне основной flow полностью работает: открыть/изменить задачу, добавить комментарий, загрузить файл, согласовать версию, отметить публикацию, внести метрику, провести смену, просмотреть отчёт. Сложные finance/import/permission формы также доступны, но разбиты на последовательные секции с постоянным summary, без требования повернуть устройство. Большие таблицы допускают внутренний горизонтальный scroll и Column Picker; первая смысловая колонка sticky. Не скрывать важные поля без альтернативы Details.

200% zoom не обрезает кнопки и validation. 360 px viewport не имеет горизонтального overflow body. Virtual keyboard не закрывает active field и Submit; использовать dynamic viewport units и scroll-into-view после focus. Touch targets минимум 44×44; desktop visual button может быть меньше, touch hit area сохраняется.

### 28.2. Accessibility requirements

Keyboard navigation для menu, tabs, dialogs, tables selection, drag alternatives, datepicker и media controls. Tab order соответствует визуальному. Focus visible с контрастом; focus trap только в modal; Escape закрывает overlay, но при dirty form запускает discard flow. Icon-only buttons имеют accessible names. Labels не заменяются placeholders.

Обычный текст целевой contrast ≥4.5:1, крупный ≥3:1, actionable non-text indicators ≥3:1; проверить фактические пары палитры, особенно muted и dark mode. Ошибки связаны aria-describedby с полем, summary фокусируется после неуспешного submit. Live regions для save/upload status без чтения каждого процента. Screen reader получает status text, amount/currency, date/timezone и chart data table. Нельзя обозначать просрочку только красным цветом.

Drag/drop всегда имеет Move To/Move Up/Move Down альтернативу. Видео не играет автоматически со звуком. Subtitle attachment preview при наличии; CRM не обещает автоматическую транскрипцию. prefers-reduced-motion соблюдается. Встроенный accessibility checker дополняется ручной keyboard/screen-reader проверкой ключевых flows.

### 28.3. Целевой масштаб и проверяемые SLO

Один workspace: 200 members, 1000 projects, 5000 accounts, 100000 content items, 300000 publications, 500000 tasks, 2000000 metric values, 300000 financial lines. Storage зависит от quota. Нагрузочная база использует отдельные синтетические данные и не попадает в production. Load profile: 50 одновременно работающих sessions, 30 reads/s и 5 writes/s в steady state, burst ×3 в 30 s; медиа идёт через storage/stream отдельно.

На зафиксированном staging hardware: API list/detail p95≤500 ms без large media; critical writes p95≤800 ms; search p95≤700 ms; standard 90-day analytics p95≤2 s после прогретых read models. Более тяжёлый запрос возвращает job за ≤1 s и показывает progress. First useful authenticated screen p75≤2.5 s на laptop connection 20 Mbps/50 ms latency; ввод/открытие drawer без network wait должен реагировать ≤100 ms. Эти показатели подтверждаются отчётом измерений, не заявляются без теста.

Pagination и virtualization обязательны для больших списков. Не запрашивать все 100000 records для фильтра в браузере. Thumbnails lazy, preload только при высокой вероятности использования, избегать загрузки оригиналов в list. Server reports ограничивают time range/row count; timeout сохраняет error и предлагает background run. Тяжёлые dynamic imports календаря/редактора/графиков не входят в auth bundle.

## 29. Приёмочные сценарии

Реализовать meaningful unit/integration/e2e проверки. Таблица ниже задаёт минимальный обязательный набор; каждый сценарий имеет воспроизводимые fixtures, действие и проверку server state. Не подменять интеграционные тесты моками самого проверяемого use case. Тесты должны ловить нарушения permissions, денег, времени, ссылок и повторов, а не проверять только наличие текста на экране.

| ID | Сценарий | Ожидаемый результат |
|---|---|---|
| T001 | Новый production workspace | Нет демопроектов, fake KPIs и default admin password |
| T002 | Повтор bootstrap | Второй Owner не создаётся, команда объясняет уже завершённый bootstrap |
| T003 | Первый вход Owner | MFA и три шага настройки доступны, progress переживает reload |
| T004 | Invite accepted дважды | Один user/membership, второй запрос безопасно возвращает текущее состояние |
| T005 | Invite expired/revoked | Доступ не выдан, понятный recovery action |
| T006 | Resend invitation | Старый token недействителен, email job имеет реальный статус |
| T007 | Password recovery unknown email | Ответ не раскрывает наличие аккаунта |
| T008 | Reset token replay | Второе использование rejected, старые сессии revoked |
| T009 | TOTP неверный/повторный | Нет сессии, rate limit, audit без кода |
| T010 | Recovery code повторно | Второе использование запрещено |
| T011 | Session expiry во время edit | Нет fake save, после входа возврат к доступному маршруту |
| T012 | Последний Owner деактивируется | Операция блокируется |
| T013 | Ownership transfer | Только после принятия и recent auth обоих, atomically no ownerless workspace |
| T014 | Contractor запрашивает project detail | Только разрешённая task projection, полного project payload нет |
| T015 | Cross-workspace object ID | 404, zero mutation, tenant foreign key не позволяет link |
| T016 | Скрытый finance field в API | Отсутствует для обычного Lead и в export/search/overview |
| T017 | Role revoked при открытой вкладке | Новые reads/writes запрещены, stream отключён, caches очищаются |
| T018 | Admin выдаёт себе Owner/finance manage | Нельзя без Owner grant/transfer |
| T019 | Deactivate member с задачами/сменами | Impact preview, выбранная передача, sessions revoked, historical author сохранён |
| T020 | Restore member | Не восстанавливает чувствительные grants молча |
| T021 | Create project double click | Одна запись по idempotency key |
| T022 | Project type change после episodes | Blocked с перечнем зависимостей |
| T023 | Archive active project | Нужна развязка scheduled publications/active shifts/open required work |
| T024 | Archive completed project | Историческая аналитика и finance сохраняются |
| T025 | Character new version | Old approved snapshot не меняется, dependent content отмечен для проверки |
| T026 | Season episode duplicate number/language | DB/domain unique conflict без потери исходной записи |
| T027 | Reorder scenes | Stable IDs и связанные tasks/annotations остаются |
| T028 | Account duplicate URL with tracking params | Одна canonical identity, показ существующей разрешённой записи |
| T029 | Account custom case-sensitive path | Не склеивается ошибочно с другим path |
| T030 | Account rename | История handle/URL и publications сохраняется |
| T031 | Account transfer с active shift | Операция blocked до разрешения open dependency |
| T032 | Account transfer после завершения | Старые facts имеют старый project attribution, новые — новый |
| T033 | Добавление Instagram URL | Нет OAuth, scraping, external fetch и fake imported metrics |
| T034 | Create reference from URL | Сохраняет заметку, не скачивает контент автоматически |
| T035 | Reference → Idea | Один linked draft, reference usage виден |
| T036 | Apply template повторно | Один набор tasks по application key |
| T037 | Новый template к начатому content | Diff, completed tasks не перезаписаны |
| T038 | Submit version с Processing asset | Blocked до Available |
| T039 | Self approval при policy запрете | Forbidden; owner exception отдельный и audited |
| T040 | Review unresolved blocker | Approval blocked |
| T041 | Параллельные approve/request changes | Одно решение, второй 412/409 по контракту |
| T042 | Approval неверной version | Не утверждает latest автоматически |
| T043 | New version после approval | Старые placements pinned, новая версия требует review |
| T044 | Revoke approval | Новые placements заблокированы, published history сохранена |
| T045 | Video comment timecode вне duration | Validation error |
| T046 | Image annotation после новой версии | Старые координаты не переносятся на новое изображение |
| T047 | Duplicate content | Нет inherited metrics, approvals, payouts и публикаций |
| T048 | Task dependency cycle | Server rejects, graph остаётся ациклическим |
| T049 | Start blocked task | Объяснение predecessor или explicit audited override |
| T050 | Complete с required checklist unchecked | Server rejects |
| T051 | Reopen Done | Новый cycle event, не повторный produced unit |
| T052 | Task без deadline | Не попадает в overdue |
| T053 | Due date-only в разных zones | Одинаковый сохранённый deadline, корректный local display |
| T054 | Recurrence retry после outage | Нет duplicate occurrences и неконтролируемого backfill |
| T055 | Monthly recurrence 31st | Last Day policy воспроизводима |
| T056 | Timer start в двух вкладках | Один active timer |
| T057 | Timer stop replay | Один TimeEntry |
| T058 | Browser closed при timer | Server interval сохраняется, нет fake auto-stop |
| T059 | Overlapping time entries | Не проходят approval без resolution |
| T060 | Unestimated workload | Показывается unknown count, не нулевые часы |
| T061 | Schedule unapproved content | Blocked |
| T062 | Schedule account Restricted | Только разрешённый override с reason |
| T063 | Наступил scheduled_at | Publication не становится Published сама |
| T064 | Mark Published без URL/reason | Validation error |
| T065 | Mark Published дважды | Один факт и один набор checkpoints |
| T066 | External Post URL duplicate | Unique conflict даже при разных idempotency keys |
| T067 | План перенесён за пределы недели | Original baseline сохраняет строку, Current Plan отдельно |
| T068 | Late metrics checkpoint | Реальный observed_at, label Late, исключён из стандартного comparable set |
| T069 | Removed external post | Исторические facts сохранены, availability отдельно |
| T070 | Tagged URL created | Нет увеличения clicks/conversions |
| T071 | Campaign multi-project costs | Сумма allocations ровно source amount, tags не удваивают расход |
| T072 | Experiment unequal post ages | Not Comparable/фильтр, без ложного winner significance |
| T073 | MIME spoofed upload | Quarantine rejection, нет публичного preview |
| T074 | Image decompression/size limit | Reject до опасного processing, reservation освобождена |
| T075 | Interrupted multipart upload | Resume в пределах TTL, нет дублирующего blob ownership |
| T076 | Two uploads near quota | Concurrent reservations не превышают quota |
| T077 | Malware scan service unavailable | Checking/Failed, файл не Available |
| T078 | Private original URL запрошен без права | Нет credentials и metadata leak |
| T079 | Restricted asset revoke | Новые proxy reads denied, downloaded original не обещается отозвать |
| T080 | Delete referenced approved version | Blocked или Archive, historical playback reference сохранён |
| T081 | External asset inaccessible | Honest External Link, не fake local file |
| T082 | Article published | Frozen version, новая правка draft |
| T083 | Article opened without acknowledge | Required reading не выполнено |
| T084 | Required article major revision | Новый acknowledgement request, прежний факт сохранён |
| T085 | Overlapping scheduled member shifts | Conflict, кроме единой multi-account Shift |
| T086 | Multi-account Shift | Один timer, account reports раздельны, время не умножено |
| T087 | Shift вне assignment interval | Start/schedule blocked |
| T088 | Start Shift из двух вкладок | Один actual_start и одна Active Shift |
| T089 | Shift Pause/Resume/End | Breaks закрыты ровно раз, Net Hours верны |
| T090 | Forgotten End | Alert/Needs Review, actual_end не выдуман |
| T091 | Correct shift time | Supervisor reason и audit, compensation source invalidation |
| T092 | Submit report без handover/no-open-items | Validation error |
| T093 | Report approved | Версия frozen, finance entry не Post автоматически |
| T094 | Handover acknowledged | Задачи не завершаются и не клонируются |
| T095 | Same contact alias on two accounts | Разные contacts, нет автоматического identity merge |
| T096 | Merge same-account contacts | Все refs сохранены, sales не дублируются |
| T097 | Content request из contact | Creator получает brief, не private contact notes |
| T098 | Sale candidate совпадает с source transaction | Duplicate detected, revenue не удвоен |
| T099 | Sale совпадает по времени со сменой | Attribution остаётся Unassigned без evidence/ручного решения |
| T100 | Quality all N/A | No Score, не 0/100 |
| T101 | Quality negative без evidence | Publish blocked |
| T102 | Quality disputed | Исходная оценка и resolution history сохранены |
| T103 | Metric empty и metric zero | null и 0 различаются в store/chart/export |
| T104 | Cumulative snapshots 100→160 | Delta 60, cumulative total не 260 |
| T105 | Overlapping period observations | Не суммируются, нужен canonical non-overlap набор |
| T106 | Metric correction approved | Старое значение superseded, graph пересчитан из нового источника |
| T107 | Negative cumulative delta | Source correction warning, не ложные отрицательные просмотры |
| T108 | ER при views=0 | Not Defined, division by zero отсутствует |
| T109 | Partial interactions | Не выдаётся полный ER, missing fields перечислены |
| T110 | Aggregate ER | Weighted ratio, не average percentages |
| T111 | Followers first snapshot=0 | Absolute growth показан, relative undefined |
| T112 | Source не даёт churn denominator | Not Measured, нет подстановки текущих subscribers |
| T113 | Account followers across platforms | Label Sum of Account Followers, не Unique Audience |
| T114 | Coverage Missing checkpoint | Missing не входит в usable numerator |
| T115 | Report task-comments join | Facts не размножаются от нескольких comments |
| T116 | Shared report restrictive recipient | Recipient-scoped results, broad owner data не отправлено |
| T117 | Unfinished period comparison | Equal elapsed window, rate delta в percentage points |
| T118 | Goal revised mid-period | История target и baseline сохранена |
| T119 | Finance example 1000/100/180/200/72 | Net 720, result 448, как в 18.7 |
| T120 | Platform payout 720 | Cash увеличен, revenue/result не изменены |
| T121 | Partial manager payout 30 | Outstanding 42, compensation expense не дублируется |
| T122 | Post одной transaction concurrent keys | Unique source guard, одна экономическая операция |
| T123 | Edit Posted entry | Запрещено, доступен reversal/replacement |
| T124 | Gross неизвестен, Net Only известен | Net valid, Gross incomplete, fee не выдумана |
| T125 | Header platform total + transaction lines | Header контрольный, не вторая выручка |
| T126 | FX missing | Draft save возможен, cross-currency Post blocked |
| T127 | Allocation rounding remainder | Exact minor-unit conservation |
| T128 | Approved FX rate изменён в справочнике | Историческая base equivalent неизменна |
| T129 | Commitment converted to Actual | Remaining commitment уменьшен, расходов дважды нет |
| T130 | Compensation run replay approve | Один expense document и один entitlement claim |
| T131 | Compensation refund after approval | Adjustment next open run, прошлый paid run не переписан |
| T132 | Fixed mid-month proration | Выбранная Calendar Days/None policy воспроизводима |
| T133 | Hourly overlapping sources | TimeEntry и Shift одного периода не оплачены дважды одним basis |
| T134 | Revenue Share overlapping rules | Ошибка либо explicit stack preview, нет скрытого двойного начисления |
| T135 | Negative compensation balance | Carry-forward, нет автоматического банковского списания |
| T136 | Closed-period post | Blocked или explicit audited reopen |
| T137 | Settlement overpayment | Явный advance/unallocated balance |
| T138 | Deal Won | Не создаёт fake Paid/posted income |
| T139 | Automation Dry Run | Zero domain mutations и zero mail |
| T140 | Worker retry после commit/response loss | Один observable domain effect |
| T141 | Automation recursive chain | Depth/budget limit, alert без бесконечной генерации |
| T142 | Rule owner loses scope | Paused Requires Attention, no unauthorized action |
| T143 | Rescheduled reminder | Stale deadline revision ничего не отправляет |
| T144 | Quiet hours | Inbox immediate, обычный email отложен, security policy сохранена |
| T145 | Import validation error | Никакие domain rows не изменены |
| T146 | Import target изменился после preview | Needs Revalidation, zero partial commit |
| T147 | Import same file confirmed twice | Один import application |
| T148 | Finance import | Только Draft, нет auto-post |
| T149 | Import ambiguous date/decimal | Требуется mapping, нет угадывания суммы |
| T150 | Undo import после зависимых изменений | Препятствия видны, связанные факты не удалены |
| T151 | CSV formula injection export | Открывается как безопасный текст |
| T152 | XLSX formula/macro import | Ничего не выполняется, cached values явно обозначены |
| T153 | Export permission revoked before download | Download denied и прежний artifact недоступен через новый credential |
| T154 | Export failed | Нет пустого completed файла |
| T155 | Restore archived/trashed record collision | Preview и resolution, без нарушения unique constraints |
| T156 | Purge finance/audit через trash | Forbidden |
| T157 | Backup восстановлен до удаления контакта | Tombstones replay удаляет/обезличивает контакт до reopening |
| T158 | Restore drill | Сверены DB/file manifests, result recorded, RTO измерен |
| T159 | Search чужого объекта | Нет result/snippet/count leak |
| T160 | User URL javascript/data/file | Validation reject и safe renderer |
| T161 | CSRF mutation без token/origin | Rejected, данные не изменены |
| T162 | Concurrent dirty form | Conflict dialog, собственный ввод не затёрт |
| T163 | Same idempotency key different body | 409, второй эффект отсутствует |
| T164 | Missing/old If-Match | 428/412 по API contract |
| T165 | Browser offline | Pending unsaved показан честно, critical action не queue silently |
| T166 | Keyboard-only Review/Publication flow | Все действия доступны, focus возвращается правильно |
| T167 | 200% zoom, 360 px | Нет body overflow, элементы доступны, errors видимы |
| T168 | Dark/Light/Reduced Motion | Контраст проверен, status текстовый, ненужная анимация отключена |
| T169 | Empty production workspace | Объясняющие CTA, графики без fake данных |
| T170 | Staging load profile | Latency/queue thresholds измерены, report приложен |
| T171 | Sensitive logs audit | Нет passwords, MFA, raw contact notes, signed URLs |
| T172 | Dramora недоступна/не настроена | Все функции CRM работают, нет обращения к её API |

Кроме таблицы: property-based проверки сохранения minor units при случайных allocations, идемпотентности consumer при repeated/out-of-order events, отсутствия task dependency cycles, допустимости state transitions и scope isolation. Набор security fixtures содержит Owner, Lead Series, Lead Models, OFM Manager, Finance Manager, Contractor и Viewer; проверки выполняются и прямыми HTTP запросами, и через UI.

## 30. Порядок реализации и обязательные результаты агента

### 30.1. Порядок работы

1. Прочитай repository instructions, проверь текущие файлы, package manager и версии. Если репозитория нет, создай структуру раздела 26. Не переписывай существующий проект без проверки его назначения.
2. Составь implementation checklist по R01–R20 и S01–S74. Зафиксируй рабочие решения в ADR: stack, identity, ACL, finance semantics, metric semantics, files, queue, deployment.
3. Опиши schema/migrations, API contracts и design tokens. Реализуй identity/access/audit и tenant isolation до чувствительных данных.
4. Реализуй сквозной flow Project → Account → Content → Review → Publication → Metrics, включая persistence, errors и permissions. Затем задачи, library, knowledge, campaigns и partnerships.
5. Реализуй OFM с assignments, multi-account shifts, handovers, contacts, operations, source verification и quality.
6. Реализуй finance с точной arithmetic, budgets, compensation, settlements и period locks. Подключи общую analytics semantic layer.
7. Реализуй reports, automations, notifications, imports/exports, archive/retention и system health. Ни один из этих блоков не считается «опциональным для полноценной версии».
8. Выполни security, domain, integration и e2e проверки, visual QA всех маршрутов, responsive/keyboard QA и load measurement.
9. Подготовь production configuration, deployment manifests, backup/restore runbooks, user guide и итоговый acceptance report. Развёртывание во внешней production среде выполняется только при наличии авторизации на это действие.

Этапы задают последовательность, не сокращение итогового объёма. Продолжай реализацию до полной готовности описанного scope. Если среды/credentials для конкретного внешнего сервиса нет, реализуй adapter/configuration/диагностику, используй local test sink, чётко укажи эксплуатационный блокер и не заявляй рабочую production отправку/хранение без проверки. Не оставляй видимые пользователю кнопки без действия.

### 30.2. Что должно быть в репозитории

| Deliverable | Содержание |
|---|---|
| Working application | Все маршруты, server-backed data, роли и действия этого документа |
| Database migrations | Schema, indexes, constraints, seeds справочников, upgrade strategy |
| OpenAPI | Все paths, fields, enums, examples, permissions, errors и idempotency |
| Generated API client | Типы и контракт без ручного рассогласования |
| Design tokens / component catalog | Buttons/forms/tables/dialogs/drawers/charts и все состояния |
| Test suites | Domain, integration, e2e, security, property-based и performance scenario |
| `.env.example` | Полный configuration schema, без секретов |
| Local environment | Воспроизводимый запуск web/worker/DB/storage/mail и проверки файлов |
| Deployment manifests | Production services, networking, TLS assumptions, storage, migrations, workers |
| Demo fixture command | Отдельная opt-in команда для dev/staging, не автоматический production seed |
| README | Установка, run/build/test, bootstrap Owner, configuration, ограничения |
| Admin guide | Team/access/templates/import/finance/retention/backup workflows |
| Staff guide | My Work, uploads, review, publication, metrics, shifts |
| Runbooks | Deploy/rollback, restore, mail outage, storage failure, queue recovery, revoke access |
| ADRs | Объяснение ключевых решений и принятых компромиссов |
| Acceptance report | R/S/T coverage, passed/failed, evidence links, measured performance, remaining blockers |

### 30.3. Fixture data

Dev/staging opt-in fixture: Owner, Ruslan как Series Lead, Andrey как Models Lead, creator, publisher, OFM manager, finance manager, contractor. Это вымышленные тестовые memberships без реальных email приглашений. Один сериал из 2 сезонов/6 эпизодов, 2 модели, 1 инфлюенсер, 8 аккаунтов с example.invalid external URLs, 24 материалов в разных стадиях, 60 задач, 12 публикаций, 14 metric observations, 4 смены, 3 contacts, 1 partner deal и финансовый пример 18.7.

Fixture accounts помечены Sample Data и не смешиваются с production. Никаких эротических тестовых изображений; для media использовать нейтральные собственные тестовые файлы и явные synthetic thumbnails. Использовать deterministic fixture clock для проверок сроков. Seeds идемпотентны и отказываются запускаться в production без отдельного явно опасного override; обычный запуск приложения не создаёт demo записи.

### 30.4. Definition of Done

Все обязательные flows выполняются от начала до конца через UI и API. Все чувствительные операции имеют server authorization. Все метрики воспроизводимы по источникам. Все деньги сходятся до minor unit. Все uploads/downloads приватны. Все критические writes идемпотентны. Missing data честно обозначены. Нет dead buttons, fake charts, TODO stubs, скрытых localStorage-only бизнес-данных и заявлений о несуществующих интеграциях. Ошибки и плохая сеть не теряют подтверждённые данные. Чистая production база работоспособна без fixtures. Backup восстановлен в тестовой среде. Итоговый отчёт отделяет реализованное, проверенное и требующее конфигурации среды.

## 31. Таблица рабочих defaults и UI microcopy

### 31.1. Defaults

| Настройка | Значение | Где меняется / ограничение |
|---|---|---|
| UI language | English | Dictionaries готовы к локализации |
| Theme | System | Personal Settings |
| Density | Comfortable | Personal Settings/Table |
| Workspace timezone | Suggested browser zone, owner confirms | Setup; later impact preview |
| Base currency | EUR suggested, owner confirms | До первой Posted записи |
| Week starts | Monday | Workspace Settings |
| Work capacity template | 8 h Mon–Fri | Подтверждение для member |
| Primary project owner | Exactly 1 | Project assignment |
| Task priority | Normal | Task form |
| Review policy | 1 Release Approval, self-review prohibited | Project policy |
| Publication checkpoint | 24 h and 7 d | Versioned metric policy |
| Account metrics cadence | Weekly | Account settings |
| Publication grace | 15 min | Plan metric definition version |
| Shift accounts | 1 primary + up to 9 additional | Valid assignments required |
| Shift planned duration | 15 min–16 h | Supervisor policy within tested bounds |
| Quiet hours | 22:00–08:00 personal zone | Personal notification preferences |
| Invitation TTL | 72 h | System setting |
| Reset token TTL | 30 min | System security policy |
| Session idle/absolute | 12 h / 7 d | Workspace security policy |
| Recent authentication | 15 min | Critical action policy |
| Idempotency record TTL | 7 d | Source uniqueness persists separately |
| Table page size | 50, max 200 | Table/API |
| Upload workspace quota | 500 GB | Owner, does not delete existing files |
| Upload session TTL | 24 h | Storage/worker config |
| Import cap | 20 MB / 20000 rows | Infrastructure-tested limit |
| Export artifact TTL | 7 d | Retention policy |
| Standard download credential | ≤5 min | Restricted files through auth proxy |
| Trash grace | 30 d | Workspace retention |
| Audit retention | 24 months | Workspace retention |
| Financial retention | 7 years, owner must configure | Operational default, not universal legal assertion |
| OFM archived notes | 180 d | Restricted retention settings |
| DB backup retention | 30 d | Infrastructure policy |
| RPO / RTO target | 15 min / 4 h | Validate by restore exercise |

### 31.2. Обязательные тексты

| State/action | English UI text |
|---|---|
| Empty projects | No projects yet. Create a project to organize its team, accounts, and content. |
| Empty accounts | Add an account link to start planning publications and recording results. |
| No metrics | No data recorded for this period. |
| Unknown amount | Not provided |
| No denominator | This rate cannot be calculated from the available data. |
| Late observation | Recorded outside the target window |
| Manual source | Manually recorded |
| Verified source | Reviewed source record |
| Missing automatic integration | Account links do not import statistics or publish content. |
| Scheduled publication | Planned in Castlane. Publish on the platform, then confirm it here. |
| Shift timer | Time recorded in Castlane; external platform activity is not monitored. |
| Payout action | Record Payment |
| Payout explanation | This records a payment already made. It does not transfer money. |
| Unsaved form | You have unsaved changes. |
| Conflict | This record changed while you were editing it. Compare changes before saving. |
| Offline | You are offline. Changes are not being saved. |
| Approval version | Approve Version |
| New unapproved version | A newer version is awaiting review. |
| Stale report | Updated source data is available. Refresh this report. |
| Missing assignment | Assign an owner before starting this work. |
| Processing upload | Your file is being checked and prepared for preview. |
| Access revoked | Your access to this item has changed. |
| Import preview | Review changes before importing. No records have been changed yet. |
| Import conflict | Some records changed after validation. Validate again before importing. |
| Archive explanation | Archived records remain available in historical reports. |
| Backup distinction | Backup completed. Last restore test: {date}. |

Microcopy placeholders вроде {date} являются реальными runtime variables, не незаполненными требованиями. Денежные значения выводятся с currency, timestamps — с доступной timezone. Не использовать All Done, если остались ошибки, pending jobs или непроверенные показатели.

## 32. Прослеживаемость требований и технические источники

### 32.1. Карта полноты

| Requirements | Где реализуются | Основные экраны | Проверки |
|---|---|---|---|
| R01, R20 | Все модули, раздел 30 | S01–S74 | T001–T172 и acceptance report |
| R02, R06 | Projects, character, series, OFM domain | S12–S20, S40–S48 | T021–T032, T085–T102 |
| R03, R04 | Архитектура/изолированный deployment | S67, S71 | T172, deployment/restore tests |
| R05 | Link-only accounts и manual publishing | S18–S20, S31–S32 | T028–T033, T063–T070 |
| R07 | Authorizer, role/scope, assignments | S41–S43, S61–S63 | T014–T020, T085–T087 |
| R08 | Production, tasks, reviews, placements | S22–S32 | T036–T069 |
| R09 | References/Library/Knowledge/Character | S16–S17, S21, S36–S39 | T025–T027, T034–T035, T073–T084 |
| R10, R17 | Metrics semantic layer, provenance | S49–S53 | T103–T118 |
| R11 | OFM operations/quality/compensation | S40–S48, S58–S60 | T085–T102, T130–T137 |
| R12 | Finance, allocations, budgets, settlements | S55–S60 | T119–T138 |
| R13 | Rules, inbox, search, jobs, archives | S10–S11, S54, S64–S72 | T139–T165 |
| R14, R16 | Design system, responsive, a11y | Все экраны | T166–T170 и visual QA |
| R15 | Auth/storage/backup/operations | S01–S04, S37, S63, S67–S71 | T007–T018, T073–T081, T153–T158, T171 |
| R18 | Idempotency/constraints/outbox | Все mutations | T021, T036, T041, T056–T057, T065–T066, T088, T122, T130, T140, T147, T163 |
| R19 | History/revisions/archive/retention | S15–S17, S24, S56–S60, S69–S70 | T019–T032, T043–T044, T106, T123–T138, T155–T157 |

### 32.2. Источники и границы проверки

Технические источники просмотрены при подготовке документа 23–24 сентября 2026 года. Перед реализацией агент повторно сверяет текущую совместимость выбранных библиотек и конкретного storage provider. Это ссылки на первичную документацию, а не обещание автоматической совместимости всех S3-подобных сервисов.

- [Next.js — Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components): разделение серверного UI и интерактивных клиентских компонентов; применено в 26.1.
- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html): конкурентные транзакции и необходимость обработки конфликтов; применено в 24.2.
- [Amazon S3 — Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html): временные credentials доступа к объектам; ограничения отзыва учтены в 23.3.
- [OWASP — Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): server-side authorization и deny-by-default; применено в 7 и 23.2.
- [OWASP — File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html): проверка загрузок и безопасное хранение; применено в 14 и 23.3.

В этом документе не заявлена проверенная возможность официальной интеграции Instagram, OnlyFans, Fansly, TikTok или Dramora. Эти интеграции не входят в текущую реализацию. Полнота CRM достигается связанным внутренним workflow, ручным подтверждением внешних действий и проверяемым внесением данных.

## 33. Дополнительные точные контракты сложных действий

### 33.1. Формы, отмена и dirty state

New Project/Account/Task: создание только по Save; autosave таких незавершённых форм не должно создавать пустые записи. Content Idea поддерживает явный Save Draft и server autosave только после получения real content ID. После успешного Create drawer меняет route на существующий объект; Back не повторяет POST. При timeout клиент проверяет operation status через `GET /operations/{idempotencyKey}` в actor/workspace scope, прежде чем предлагать новый Create.

Delete buttons называются по эффекту: Remove Attachment Link, Archive Content, Move Draft to Trash, Delete Permanently. Не использовать одинаковое Delete для принципиально разных действий. Confirmation перечисляет конкретные affected counts и не требует typed confirmation для обратимого одиночного archive; typed confirmation требуется для purge и больших необратимых удалений. Undo toast доступен только когда операция действительно обратима и возврат проходит актуальные проверки.

### 33.2. Дополнение командного API

Чтобы все действия экранов имели конкретный backend, дополнительно реализовать команды ниже. Они наследуют auth/idempotency/concurrency contract раздела 24; поля, помеченные optional, не выдумываются сервером.

| Command | Request / effect |
|---|---|
| POST `/tasks/{id}/block` | reason, nextCheckAt optional → blocked flag/event |
| POST `/tasks/{id}/unblock` | resolution → close blocker interval |
| POST `/tasks/{id}/subtasks` | task draft → child с project/ACL parent checks |
| POST `/tasks/{id}/duplicate` | copiedFields, targetProjectId → новый Draft |
| POST `/time-sheets/submit` | member, week, timeEntryIds/versions → frozen submission |
| POST `/time-sheets/{id}/approve` | reviewerNote → approve eligible entries atomically |
| POST `/time-sheets/{id}/return` | reason → returned entries without losing history |
| POST `/ofm/shifts/{id}/swap-requests` | proposedMemberId, reason → pending request |
| POST `/ofm/shift-swaps/{id}/accept` | proposed member acknowledgement |
| POST `/ofm/shift-swaps/{id}/approve` | supervisor review → atomic reassignment, collision recheck |
| POST `/ofm/shifts/{id}/cancel` | reason → scheduled only, reminders invalidated |
| POST `/ofm/shifts/repeat-preview` | template schedule, horizon → occurrences/conflicts |
| POST `/ofm/shifts/repeat-apply` | previewToken → unique occurrences |
| POST `/ofm/handovers/{id}/submit` | recipients/item refs → submitted handover |
| POST `/ofm/quality-disputes/{id}/resolve` | decision, reason, replacementReviewVersion optional |
| POST `/ofm/contacts/{id}/erasure-requests` | reason → scoped queued erasure plan |
| POST `/finance/entries/{id}/reject` | reason → Rejected, author notified |
| POST `/finance/budgets/{id}/versions` | revised lines, reason → draft version |
| POST `/finance/compensation-rules/{id}/simulate` | period/sample scope → computed preview, no accrual |
| POST `/finance/compensation-runs/{id}/return` | reason → draft revision, prior calculation kept |
| POST `/finance/compensation-runs/{id}/adjustments` | source/amount/reason → separate adjustment draft |
| POST `/deals/{id}/transition` | targetStage, reason/outcome → stage event |
| POST `/deals/{id}/generate-deliverables` | templateVersion, previewToken → linked tasks/content |
| POST `/deals/{id}/create-campaign` | campaign fields → explicit relation, no fake results |
| POST `/experiments/{id}/start` | planVersion → freeze baseline |
| POST `/experiments/{id}/conclude` | findings, limitations, selectedVariant optional → completed snapshot |
| POST `/goals/{id}/close` | assessment, effectiveAt → closed with measured completeness |
| POST `/templates/{id}/publish` | draftVersion → immutable usable version |
| POST `/templates/{id}/preview-application` | target, proposed roles/dates → dry-run graph |
| POST `/custom-fields/{id}/archive` | reason → inactive definition, old values remain |
| POST `/articles/{id}/assign-reading` | memberIds, versionId, dueAt → acknowledgement requests |
| POST `/notifications/{id}/archive` | own notification → archived_at |
| POST `/personal-reminders/{id}/snooze` | until → own reminder only, no deadline mutation |
| POST `/system/mail/test` | recipient=self → configured transport test, no bulk send |
| POST `/incidents/{id}/resolve` | resolution, evidenceRefs optional → resolved event |
| POST `/entities/bulk-preview` | typed targets/filter snapshot, action → authorized diff/token |
| POST `/entities/bulk-apply` | previewToken → atomic/per-item policy из 4.6 |
| GET `/operations/{idempotencyKey}` | safe actor-scoped operation status; no permission replay leak |

Дополнительные storage entities: TimeSheetSubmission, ShiftSwapRequest, ReadingAssignment, PersonalReminder, ErasureRequest, ExternalReference, DealStageEvent и BulkPreview. Все используют общие tenant keys, row versions и lifecycle audit. Не хранить эти workflows как временные browser flags, исчезающие после refresh.

### 33.3. Семантика проектной истории

В карточке Activity показывать только осмысленные события: created, assigned, state changed, version submitted, review decided, publication confirmed, metric revised, finance linked, archived. Autosave каждой буквы не засоряет ленту; агрегировать text-draft saves в одну revision summary за editing session. Security Audit отдельно сохраняет необходимый факт без raw text. Actor, timestamp, before/after labels доступны, но restricted values маскируются текущими permissions.

Страница проекта показывает текущую команду и отдельную Team History. Исторические отчёты by assignee используют assignee_at_completion/approval snapshot; изменение сегодняшнего owner не переписывает авторство старой работы. При разрешённом исправлении attribution создавать revision с reason, старые generated report snapshots помечать Source Revised, но не переписывать их файлы.

### 33.4. Приоритеты при противоречии и итоговая инструкция

Если реализация обнаруживает неоднозначность, приоритет: обязательные требования владельца R01–R20 → точные финансовые/permission/идемпотентные инварианты → screen action contracts → operational defaults. Уточни только решение, которое нельзя безопасно вывести из этого документа; продолжай независимую работу. Не трактуй отсутствие картинки, external credential или demo data как повод подменить доменную логику mock-данными.

Собери законченную систему согласно этому документу. Сохрани все предусмотренные рабочие блоки. Покажи результат на проверенных сценариях команды и предоставь конкретные доказательства прохождения приёмки, а не общее утверждение «всё готово».
