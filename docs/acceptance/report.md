# Acceptance report

Generated 2026-09-24T00:51:01.969Z from commit `fea4a98` by `pnpm acceptance:report`.
Source of scenarios: spec §29 (`docs/spec/08-operations-acceptance.md`). Automated evidence is
matched by the T-id in the test name; manual/operational evidence is kept in
`docs/acceptance/manual-evidence.json`.

| | Count |
|---|---|
| Scenarios | 172 |
| Covered by passing automated tests | 31 |
| Failing automated tests | 0 |
| Manual / operational evidence only | 0 |
| Without evidence | 141 |
| Vitest results (all tests) | 45 passed, 0 failed, 0 skipped |
| Playwright results | 3 passed, 0 failed, 0 skipped |

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| T001 | Новый production workspace | Нет демопроектов, fake KPIs и default admin password | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — bootstrap (T001, T002) creates exactly one Owner and refuses a second bootstrap; no demo data |
| T002 | Повтор bootstrap | Второй Owner не создаётся, команда объясняет уже завершённый bootstrap | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — bootstrap (T001, T002) creates exactly one Owner and refuses a second bootstrap; no demo data |
| T003 | Первый вход Owner | MFA и три шага настройки доступны, progress переживает reload | ✅ automated | e2e: `tests/e2e/specs/first-run.setup.ts` — first run of the Owner (F01, T003) |
| T004 | Invite accepted дважды | Один user/membership, второй запрос безопасно возвращает текущее состояние | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) accepting twice creates one user and one membership<br>integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) resend revokes the previous token; expired invitations grant nothing<br>integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) an Admin cannot grant roles with finance permissions (T018) |
| T005 | Invite expired/revoked | Доступ не выдан, понятный recovery action | ⚠️ no evidence |  |
| T006 | Resend invitation | Старый token недействителен, email job имеет реальный статус | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) accepting twice creates one user and one membership<br>integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) resend revokes the previous token; expired invitations grant nothing<br>integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) an Admin cannot grant roles with finance permissions (T018) |
| T007 | Password recovery unknown email | Ответ не раскрывает наличие аккаунта | ✅ automated | security: `tests/security/api-security.test.ts` — API security does not reveal whether an e-mail exists on password recovery (T007)<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) does not reveal whether an account exists and never sets a session on failure<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) rate-limits repeated failures for an account<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) recovery response is identical for unknown and known e-mails<br>+2 more |
| T008 | Reset token replay | Второе использование rejected, старые сессии revoked | ⚠️ no evidence |  |
| T009 | TOTP неверный/повторный | Нет сессии, rate limit, audit без кода | ⚠️ no evidence |  |
| T010 | Recovery code повторно | Второе использование запрещено | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) does not reveal whether an account exists and never sets a session on failure<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) rate-limits repeated failures for an account<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) recovery response is identical for unknown and known e-mails<br>integration: `tests/integration/identity/auth.test.ts` — sign-in (T007–T010) owner must set up MFA; TOTP codes cannot be replayed<br>+1 more |
| T011 | Session expiry во время edit | Нет fake save, после входа возврат к доступному маршруту | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — CSRF and session (T161, T011) rejects mutations without a valid CSRF token or from another origin<br>integration: `tests/integration/identity/auth.test.ts` — CSRF and session (T161, T011) expired sessions return 401 and clear the cookie |
| T012 | Последний Owner деактивируется | Операция блокируется | ⚠️ no evidence |  |
| T013 | Ownership transfer | Только после принятия и recent auth обоих, atomically no ownerless workspace | ⚠️ no evidence |  |
| T014 | Contractor запрашивает project detail | Только разрешённая task projection, полного project payload нет | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) scoped roles see only their projects; out-of-scope ids are 404; budget field absent without finance rights<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) a workspace id the member does not belong to is 404 (T015)<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) revoking a role takes effect on the next request (T017)<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) direction names must be unique among active directions |
| T015 | Cross-workspace object ID | 404, zero mutation, tenant foreign key не позволяет link | ✅ automated | security: `tests/security/api-security.test.ts` — API security never reveals or links objects of another workspace (T015)<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) a workspace id the member does not belong to is 404 (T015) |
| T016 | Скрытый finance field в API | Отсутствует для обычного Lead и в export/search/overview | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) scoped roles see only their projects; out-of-scope ids are 404; budget field absent without finance rights<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) a workspace id the member does not belong to is 404 (T015)<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) revoking a role takes effect on the next request (T017)<br>integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) direction names must be unique among active directions |
| T017 | Role revoked при открытой вкладке | Новые reads/writes запрещены, stream отключён, caches очищаются | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — project access scope (T014–T016) revoking a role takes effect on the next request (T017) |
| T018 | Admin выдаёт себе Owner/finance manage | Нельзя без Owner grant/transfer | ✅ automated | integration: `tests/integration/identity/auth.test.ts` — invitations (T004–T006) an Admin cannot grant roles with finance permissions (T018) |
| T019 | Deactivate member с задачами/сменами | Impact preview, выбранная передача, sessions revoked, historical author сохранён | ⚠️ no evidence |  |
| T020 | Restore member | Не восстанавливает чувствительные grants молча | ⚠️ no evidence |  |
| T021 | Create project double click | Одна запись по idempotency key | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — projects create is idempotent under double submit (T021)<br>e2e: `tests/e2e/specs/projects.spec.ts` — projects › create a project and open its workspace (F04 start, T021) |
| T022 | Project type change после episodes | Blocked с перечнем зависимостей | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — projects locks the type once seasons exist (T022) |
| T023 | Archive active project | Нужна развязка scheduled publications/active shifts/open required work | ⚠️ no evidence |  |
| T024 | Archive completed project | Историческая аналитика и finance сохраняются | ⚠️ no evidence |  |
| T025 | Character new version | Old approved snapshot не меняется, dependent content отмечен для проверки | ⚠️ no evidence |  |
| T026 | Season episode duplicate number/language | DB/domain unique conflict без потери исходной записи | ⚠️ no evidence |  |
| T027 | Reorder scenes | Stable IDs и связанные tasks/annotations остаются | ⚠️ no evidence |  |
| T028 | Account duplicate URL with tracking params | Одна canonical identity, показ существующей разрешённой записи | ⚠️ no evidence |  |
| T029 | Account custom case-sensitive path | Не склеивается ошибочно с другим path | ⚠️ no evidence |  |
| T030 | Account rename | История handle/URL и publications сохраняется | ⚠️ no evidence |  |
| T031 | Account transfer с active shift | Операция blocked до разрешения open dependency | ⚠️ no evidence |  |
| T032 | Account transfer после завершения | Старые facts имеют старый project attribution, новые — новый | ⚠️ no evidence |  |
| T033 | Добавление Instagram URL | Нет OAuth, scraping, external fetch и fake imported metrics | ⚠️ no evidence |  |
| T034 | Create reference from URL | Сохраняет заметку, не скачивает контент автоматически | ⚠️ no evidence |  |
| T035 | Reference → Idea | Один linked draft, reference usage виден | ⚠️ no evidence |  |
| T036 | Apply template повторно | Один набор tasks по application key | ⚠️ no evidence |  |
| T037 | Новый template к начатому content | Diff, completed tasks не перезаписаны | ⚠️ no evidence |  |
| T038 | Submit version с Processing asset | Blocked до Available | ⚠️ no evidence |  |
| T039 | Self approval при policy запрете | Forbidden; owner exception отдельный и audited | ⚠️ no evidence |  |
| T040 | Review unresolved blocker | Approval blocked | ⚠️ no evidence |  |
| T041 | Параллельные approve/request changes | Одно решение, второй 412/409 по контракту | ⚠️ no evidence |  |
| T042 | Approval неверной version | Не утверждает latest автоматически | ⚠️ no evidence |  |
| T043 | New version после approval | Старые placements pinned, новая версия требует review | ⚠️ no evidence |  |
| T044 | Revoke approval | Новые placements заблокированы, published history сохранена | ⚠️ no evidence |  |
| T045 | Video comment timecode вне duration | Validation error | ⚠️ no evidence |  |
| T046 | Image annotation после новой версии | Старые координаты не переносятся на новое изображение | ⚠️ no evidence |  |
| T047 | Duplicate content | Нет inherited metrics, approvals, payouts и публикаций | ⚠️ no evidence |  |
| T048 | Task dependency cycle | Server rejects, graph остаётся ациклическим | ⚠️ no evidence |  |
| T049 | Start blocked task | Объяснение predecessor или explicit audited override | ⚠️ no evidence |  |
| T050 | Complete с required checklist unchecked | Server rejects | ⚠️ no evidence |  |
| T051 | Reopen Done | Новый cycle event, не повторный produced unit | ⚠️ no evidence |  |
| T052 | Task без deadline | Не попадает в overdue | ⚠️ no evidence |  |
| T053 | Due date-only в разных zones | Одинаковый сохранённый deadline, корректный local display | ⚠️ no evidence |  |
| T054 | Recurrence retry после outage | Нет duplicate occurrences и неконтролируемого backfill | ⚠️ no evidence |  |
| T055 | Monthly recurrence 31st | Last Day policy воспроизводима | ⚠️ no evidence |  |
| T056 | Timer start в двух вкладках | Один active timer | ⚠️ no evidence |  |
| T057 | Timer stop replay | Один TimeEntry | ⚠️ no evidence |  |
| T058 | Browser closed при timer | Server interval сохраняется, нет fake auto-stop | ⚠️ no evidence |  |
| T059 | Overlapping time entries | Не проходят approval без resolution | ⚠️ no evidence |  |
| T060 | Unestimated workload | Показывается unknown count, не нулевые часы | ⚠️ no evidence |  |
| T061 | Schedule unapproved content | Blocked | ⚠️ no evidence |  |
| T062 | Schedule account Restricted | Только разрешённый override с reason | ⚠️ no evidence |  |
| T063 | Наступил scheduled_at | Publication не становится Published сама | ⚠️ no evidence |  |
| T064 | Mark Published без URL/reason | Validation error | ⚠️ no evidence |  |
| T065 | Mark Published дважды | Один факт и один набор checkpoints | ⚠️ no evidence |  |
| T066 | External Post URL duplicate | Unique conflict даже при разных idempotency keys | ⚠️ no evidence |  |
| T067 | План перенесён за пределы недели | Original baseline сохраняет строку, Current Plan отдельно | ⚠️ no evidence |  |
| T068 | Late metrics checkpoint | Реальный observed_at, label Late, исключён из стандартного comparable set | ⚠️ no evidence |  |
| T069 | Removed external post | Исторические facts сохранены, availability отдельно | ⚠️ no evidence |  |
| T070 | Tagged URL created | Нет увеличения clicks/conversions | ⚠️ no evidence |  |
| T071 | Campaign multi-project costs | Сумма allocations ровно source amount, tags не удваивают расход | ⚠️ no evidence |  |
| T072 | Experiment unequal post ages | Not Comparable/фильтр, без ложного winner significance | ⚠️ no evidence |  |
| T073 | MIME spoofed upload | Quarantine rejection, нет публичного preview | ✅ automated | integration: `tests/integration/media/uploads.test.ts` — upload pipeline (section 14) rejects a file whose content does not match an allowed type (T073) |
| T074 | Image decompression/size limit | Reject до опасного processing, reservation освобождена | ⚠️ no evidence |  |
| T075 | Interrupted multipart upload | Resume в пределах TTL, нет дублирующего blob ownership | ⚠️ no evidence |  |
| T076 | Two uploads near quota | Concurrent reservations не превышают quota | ✅ automated | integration: `tests/integration/media/uploads.test.ts` — upload pipeline (section 14) concurrent reservations cannot exceed the quota (T076) |
| T077 | Malware scan service unavailable | Checking/Failed, файл не Available | ⚠️ no evidence |  |
| T078 | Private original URL запрошен без права | Нет credentials и metadata leak | ✅ automated | integration: `tests/integration/media/uploads.test.ts` — upload pipeline (section 14) a member without project access cannot see or download another project’s file (T078) |
| T079 | Restricted asset revoke | Новые proxy reads denied, downloaded original не обещается отозвать | ⚠️ no evidence |  |
| T080 | Delete referenced approved version | Blocked или Archive, historical playback reference сохранён | ⚠️ no evidence |  |
| T081 | External asset inaccessible | Honest External Link, не fake local file | ⚠️ no evidence |  |
| T082 | Article published | Frozen version, новая правка draft | ⚠️ no evidence |  |
| T083 | Article opened without acknowledge | Required reading не выполнено | ⚠️ no evidence |  |
| T084 | Required article major revision | Новый acknowledgement request, прежний факт сохранён | ⚠️ no evidence |  |
| T085 | Overlapping scheduled member shifts | Conflict, кроме единой multi-account Shift | ⚠️ no evidence |  |
| T086 | Multi-account Shift | Один timer, account reports раздельны, время не умножено | ⚠️ no evidence |  |
| T087 | Shift вне assignment interval | Start/schedule blocked | ⚠️ no evidence |  |
| T088 | Start Shift из двух вкладок | Один actual_start и одна Active Shift | ⚠️ no evidence |  |
| T089 | Shift Pause/Resume/End | Breaks закрыты ровно раз, Net Hours верны | ⚠️ no evidence |  |
| T090 | Forgotten End | Alert/Needs Review, actual_end не выдуман | ⚠️ no evidence |  |
| T091 | Correct shift time | Supervisor reason и audit, compensation source invalidation | ⚠️ no evidence |  |
| T092 | Submit report без handover/no-open-items | Validation error | ⚠️ no evidence |  |
| T093 | Report approved | Версия frozen, finance entry не Post автоматически | ⚠️ no evidence |  |
| T094 | Handover acknowledged | Задачи не завершаются и не клонируются | ⚠️ no evidence |  |
| T095 | Same contact alias on two accounts | Разные contacts, нет автоматического identity merge | ⚠️ no evidence |  |
| T096 | Merge same-account contacts | Все refs сохранены, sales не дублируются | ⚠️ no evidence |  |
| T097 | Content request из contact | Creator получает brief, не private contact notes | ⚠️ no evidence |  |
| T098 | Sale candidate совпадает с source transaction | Duplicate detected, revenue не удвоен | ⚠️ no evidence |  |
| T099 | Sale совпадает по времени со сменой | Attribution остаётся Unassigned без evidence/ручного решения | ⚠️ no evidence |  |
| T100 | Quality all N/A | No Score, не 0/100 | ⚠️ no evidence |  |
| T101 | Quality negative без evidence | Publish blocked | ⚠️ no evidence |  |
| T102 | Quality disputed | Исходная оценка и resolution history сохранены | ⚠️ no evidence |  |
| T103 | Metric empty и metric zero | null и 0 различаются в store/chart/export | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas distinguishes empty from zero (T103) |
| T104 | Cumulative snapshots 100→160 | Delta 60, cumulative total не 260 | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas cumulative snapshots give deltas, not sums (T104) and flag negative deltas (T107) |
| T105 | Overlapping period observations | Не суммируются, нужен canonical non-overlap набор | ⚠️ no evidence |  |
| T106 | Metric correction approved | Старое значение superseded, graph пересчитан из нового источника | ⚠️ no evidence |  |
| T107 | Negative cumulative delta | Source correction warning, не ложные отрицательные просмотры | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas cumulative snapshots give deltas, not sums (T104) and flag negative deltas (T107) |
| T108 | ER при views=0 | Not Defined, division by zero отсутствует | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas ER with zero views is not defined (T108); ER may exceed 100 |
| T109 | Partial interactions | Не выдаётся полный ER, missing fields перечислены | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas partial interactions list missing fields (T109) |
| T110 | Aggregate ER | Weighted ratio, не average percentages | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas aggregate ER is a weighted ratio, not an average of percentages (T110) |
| T111 | Followers first snapshot=0 | Absolute growth показан, relative undefined | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — metric formulas growth from a zero first snapshot is not defined (T111) |
| T112 | Source не даёт churn denominator | Not Measured, нет подстановки текущих subscribers | ⚠️ no evidence |  |
| T113 | Account followers across platforms | Label Sum of Account Followers, не Unique Audience | ⚠️ no evidence |  |
| T114 | Coverage Missing checkpoint | Missing не входит в usable numerator | ⚠️ no evidence |  |
| T115 | Report task-comments join | Facts не размножаются от нескольких comments | ⚠️ no evidence |  |
| T116 | Shared report restrictive recipient | Recipient-scoped results, broad owner data не отправлено | ⚠️ no evidence |  |
| T117 | Unfinished period comparison | Equal elapsed window, rate delta в percentage points | ✅ automated | unit: `packages/analytics/src/formulas.test.ts` — periods and comparison compares an unfinished month with the same elapsed window (T117) |
| T118 | Goal revised mid-period | История target и baseline сохранена | ⚠️ no evidence |  |
| T119 | Finance example 1000/100/180/200/72 | Net 720, result 448, как в 18.7 | ⚠️ no evidence |  |
| T120 | Platform payout 720 | Cash увеличен, revenue/result не изменены | ⚠️ no evidence |  |
| T121 | Partial manager payout 30 | Outstanding 42, compensation expense не дублируется | ⚠️ no evidence |  |
| T122 | Post одной transaction concurrent keys | Unique source guard, одна экономическая операция | ⚠️ no evidence |  |
| T123 | Edit Posted entry | Запрещено, доступен reversal/replacement | ⚠️ no evidence |  |
| T124 | Gross неизвестен, Net Only известен | Net valid, Gross incomplete, fee не выдумана | ⚠️ no evidence |  |
| T125 | Header platform total + transaction lines | Header контрольный, не вторая выручка | ⚠️ no evidence |  |
| T126 | FX missing | Draft save возможен, cross-currency Post blocked | ⚠️ no evidence |  |
| T127 | Allocation rounding remainder | Exact minor-unit conservation | ⚠️ no evidence |  |
| T128 | Approved FX rate изменён в справочнике | Историческая base equivalent неизменна | ⚠️ no evidence |  |
| T129 | Commitment converted to Actual | Remaining commitment уменьшен, расходов дважды нет | ⚠️ no evidence |  |
| T130 | Compensation run replay approve | Один expense document и один entitlement claim | ⚠️ no evidence |  |
| T131 | Compensation refund after approval | Adjustment next open run, прошлый paid run не переписан | ⚠️ no evidence |  |
| T132 | Fixed mid-month proration | Выбранная Calendar Days/None policy воспроизводима | ⚠️ no evidence |  |
| T133 | Hourly overlapping sources | TimeEntry и Shift одного периода не оплачены дважды одним basis | ⚠️ no evidence |  |
| T134 | Revenue Share overlapping rules | Ошибка либо explicit stack preview, нет скрытого двойного начисления | ⚠️ no evidence |  |
| T135 | Negative compensation balance | Carry-forward, нет автоматического банковского списания | ⚠️ no evidence |  |
| T136 | Closed-period post | Blocked или explicit audited reopen | ⚠️ no evidence |  |
| T137 | Settlement overpayment | Явный advance/unallocated balance | ⚠️ no evidence |  |
| T138 | Deal Won | Не создаёт fake Paid/posted income | ⚠️ no evidence |  |
| T139 | Automation Dry Run | Zero domain mutations и zero mail | ⚠️ no evidence |  |
| T140 | Worker retry после commit/response loss | Один observable domain effect | ⚠️ no evidence |  |
| T141 | Automation recursive chain | Depth/budget limit, alert без бесконечной генерации | ⚠️ no evidence |  |
| T142 | Rule owner loses scope | Paused Requires Attention, no unauthorized action | ⚠️ no evidence |  |
| T143 | Rescheduled reminder | Stale deadline revision ничего не отправляет | ⚠️ no evidence |  |
| T144 | Quiet hours | Inbox immediate, обычный email отложен, security policy сохранена | ⚠️ no evidence |  |
| T145 | Import validation error | Никакие domain rows не изменены | ⚠️ no evidence |  |
| T146 | Import target изменился после preview | Needs Revalidation, zero partial commit | ⚠️ no evidence |  |
| T147 | Import same file confirmed twice | Один import application | ⚠️ no evidence |  |
| T148 | Finance import | Только Draft, нет auto-post | ⚠️ no evidence |  |
| T149 | Import ambiguous date/decimal | Требуется mapping, нет угадывания суммы | ⚠️ no evidence |  |
| T150 | Undo import после зависимых изменений | Препятствия видны, связанные факты не удалены | ⚠️ no evidence |  |
| T151 | CSV formula injection export | Открывается как безопасный текст | ⚠️ no evidence |  |
| T152 | XLSX formula/macro import | Ничего не выполняется, cached values явно обозначены | ⚠️ no evidence |  |
| T153 | Export permission revoked before download | Download denied и прежний artifact недоступен через новый credential | ⚠️ no evidence |  |
| T154 | Export failed | Нет пустого completed файла | ⚠️ no evidence |  |
| T155 | Restore archived/trashed record collision | Preview и resolution, без нарушения unique constraints | ⚠️ no evidence |  |
| T156 | Purge finance/audit через trash | Forbidden | ⚠️ no evidence |  |
| T157 | Backup восстановлен до удаления контакта | Tombstones replay удаляет/обезличивает контакт до reopening | ⚠️ no evidence |  |
| T158 | Restore drill | Сверены DB/file manifests, result recorded, RTO измерен | ⚠️ no evidence |  |
| T159 | Search чужого объекта | Нет result/snippet/count leak | ✅ automated | security: `tests/security/api-security.test.ts` — API security search never leaks titles, snippets or counts of out-of-scope objects (T159) |
| T160 | User URL javascript/data/file | Validation reject и safe renderer | ✅ automated | security: `tests/security/api-security.test.ts` — API security rejects javascript:, data: and file: links (T160) |
| T161 | CSRF mutation без token/origin | Rejected, данные не изменены | ✅ automated | security: `tests/security/api-security.test.ts` — API security rejects state changes without CSRF token or from another origin, with zero mutation (T161)<br>integration: `tests/integration/identity/auth.test.ts` — CSRF and session (T161, T011) rejects mutations without a valid CSRF token or from another origin<br>integration: `tests/integration/identity/auth.test.ts` — CSRF and session (T161, T011) expired sessions return 401 and clear the cookie |
| T162 | Concurrent dirty form | Conflict dialog, собственный ввод не затёрт | ⚠️ no evidence |  |
| T163 | Same idempotency key different body | 409, второй эффект отсутствует | ⚠️ no evidence |  |
| T164 | Missing/old If-Match | 428/412 по API contract | ✅ automated | integration: `tests/integration/organization/projects.test.ts` — projects requires If-Match and rejects stale versions (T164) |
| T165 | Browser offline | Pending unsaved показан честно, critical action не queue silently | ⚠️ no evidence |  |
| T166 | Keyboard-only Review/Publication flow | Все действия доступны, focus возвращается правильно | ⚠️ no evidence |  |
| T167 | 200% zoom, 360 px | Нет body overflow, элементы доступны, errors видимы | ⚠️ no evidence |  |
| T168 | Dark/Light/Reduced Motion | Контраст проверен, status текстовый, ненужная анимация отключена | ⚠️ no evidence |  |
| T169 | Empty production workspace | Объясняющие CTA, графики без fake данных | ⚠️ no evidence |  |
| T170 | Staging load profile | Latency/queue thresholds измерены, report приложен | ⚠️ no evidence |  |
| T171 | Sensitive logs audit | Нет passwords, MFA, raw contact notes, signed URLs | ✅ automated | unit: `packages/application/src/core/services.test.ts` — log redaction (T171) removes credentials, MFA codes, tokens, notes and URL signatures |
| T172 | Dramora недоступна/не настроена | Все функции CRM работают, нет обращения к её API | ⚠️ no evidence |  |
