# Castlane CRM — Specification part 4: domain modules (sections 9–16)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 9. Проекты, персонажи, аккаунты и сотрудничества

Project statuses: Draft → Active ↔ Paused → Completed → Archived. Draft→Active требует owner, direction и заполненный краткий brief. Completed требует отсутствия незавершённых blocking tasks, active shifts и scheduled publications; предупреждает о непроведённых финансовых drafts. Archived запрещает новые production records, но допускает finance correction и внесение исторического замера с правом. Reopen Completed → Active с причиной.

Series, Model и Influencer — фиксированные типы. Любой Project принадлежит одному Direction, можно переносить с preview ACL и сохранением historical direction attribution. Для отчётов по производству сохранять direction_at_event; текущий список отображает нынешнее направление. Project может иметь несколько Character; Model/Influencer отмечает один primary character. Character fields: fictional identity note, adult age declaration для OFM-контекста, appearance, visual references, voice description, biography, audience, style constraints, approved prompts. Не хранить secret API keys генераторов в prompt fields.

Account identity: platform enum Instagram, TikTok, YouTube, X, OnlyFans, Fansly, Other; наличие enum не означает интеграцию или подтверждение правил площадки. URL parser нормализует scheme/host, удаляет tracking query для profile identity, сохраняет original_url. Нормализация path выполняется по платформенному правилу; нельзя универсально lower-case case-sensitive path. Custom сохраняет normalized host+path без предположения о handle. Разные profiles одного platform допустимы, точный дубликат запрещён.

Перенос Account в другой Project — отдельная операция с предварительным просмотром. Account history остаётся единым; существующие publications/tasks/finance сохраняют project_at_creation, новые получают новый project. Система показывает cross-project historical context только разрешённым сотрудникам. По умолчанию перенос запрещён при Active Shift и ожидающих review переходах, которые меняют scope; требуется сначала завершить/переназначить их.

Account statuses: Preparing → Active ↔ Paused; Active/Paused → Restricted; Restricted → Active после resolution; любой без открытых блокирующих обязательств → Archived. Deleted external post не удаляет Publication: status Published сохраняется, availability становится Removed/Unavailable с датой и причиной. Исторические просмотры остаются фактами наблюдений.

Partner не является системным пользователем. Deal stages: Lead → Discussing → Proposal → Negotiation → Won → Delivering → Fulfilled; Lost и Cancelled с причиной. Финансовая paid state независима. Deliverable указывает формат, account/project, due, acceptance criteria, linked content и agreed amount optional. Договор хранится как приватное вложение; e-signature не обещается. Повтор Generate Tasks использует уникальный deal+deliverable+template application key.

## 10. Производство, версии и согласование

### 10.1. Состояния ContentItem

| From → To | Кто | Условия и эффект |
|---|---|---|
| Idea → Brief | Owner/Producer | Project active, формат выбран |
| Brief → Ready | Producer/Lead | Brief summary, owner, reviewer, objective, due или явное No Deadline |
| Ready → Production | Assignee/Producer | Отсутствуют blocking dependencies |
| Production → Review | Submit permission | Загружены required deliverables, все файлы Available, checklist выполнен; создаётся immutable version snapshot и Review |
| Review → Changes Requested | Reviewer | Обязательная summary и хотя бы одно конкретное замечание либо объяснение |
| Changes Requested → Production | Assignee | Начало исправлений; предыдущая review history сохраняется |
| Review → Approved | Reviewer | Current submitted version совпадает, blockers resolved, нет авторского self-approval без exception |
| Approved → Production | Producer/Lead | New Revision с reason, старый approved version остаётся pinned для старых публикаций |
| Любой → Archived | Lead | Нет unresolved scheduled placements/reviews без их отмены/переноса |

Paused и Blocked являются независимыми флагами с reason, actor, start/end, а не исчезновением canonical stage. Archived материалы не отображаются в активном pipeline.

### 10.2. Форматы и шаблоны

Formats: Short Video, Episode, Trailer, Image, Carousel, Photo Set, Story, Audio, Text Post, Other. Каждый template задаёт deliverable slots, checklist, task graph, reviewer role, relative offsets. Short Video default: Brief → Script → Generation/Source → Edit → Caption/Cover → Review. Episode: Script → Scene Breakdown → Assets → Voice → Edit → Subtitles → QC → Review. Photo Set: Concept → References → Generate/Source → Select → Retouch → QC → Review. Text Post: Outline → Draft → Edit → Review.

Шаблон создаёт задачи только после preview имён, назначений и дат. Неизвестный исполнитель остаётся Unassigned с задачей координатору; не подставлять случайного сотрудника. Применение новой версии к существующему материалу предлагает diff: добавить, оставить, отменить ещё не начатые; не переписывает completed tasks. Хранить template_version_id и application_id.

### 10.3. Версии и обратная связь

ContentVersion — набор AssetVersions и snapshot brief, не один перезаписываемый путь файла. Slots могут включать Main Video, Cover, Subtitles, Caption, Source Archive. Version номер монотонный в рамках content; duplicate upload с тем же blob может использовать immutable blob повторно, но логическая версия имеет собственный ID и note.

ReviewComment: body 1–5000, severity Note/Blocking, file_version, optional video timecode в пределах duration, optional image normalized coordinates 0–1. Reply threads depth максимум 2; mention только доступного членa проекта. Resolve by assignee записывает claim fixed; reviewer может reopen. Финальное approval требует blockers resolved reviewer либо принятой policy. New version marks old annotations as Previous Version, не переносит координаты на другое изображение автоматически.

Два уровня согласования поддерживаются как ordered review steps: Content Quality и Release Approval. По умолчанию один Release Approval; второй включается в project policy. На каждом шаге список eligible reviewers и required approvals=1. Сам автор не eligible при separation policy. Изменение policy не отменяет задним числом завершённое согласование; новый submission получает snapshot новой policy.

Approved version immutable. Если обнаружена ошибка, Revoke Approval создаёт событие и блокирует новые scheduled placements этой версии. Уже опубликованные остаются в истории с флагом Approval Revoked After Publication и задачей проверить внешнее размещение. Никакого автоматического удаления поста.

## 11. Задачи, сроки, время и загрузка

Canonical statuses: Draft, Backlog, Ready, In Progress, In Review, Done, Cancelled. Пользовательский label может менять название, но обязан сопоставляться canonical category. Blocked flag отдельно. Priority: Low, Normal, High, Urgent; Urgent не меняет права и не отправляет сообщения бесконечно.

Start At ≤ Due At; date-only due означает конец выбранного календарного дня в task timezone, UI пишет Due by end of day. Task без due отображается No Deadline и не просрочена. Overdue = due_at < server_now AND status not Done/Cancelled. При первом Ready с ненулевым due сохраняется baseline_due_at; если due впервые назначен позже, baseline фиксируется при этом назначении. Обычный перенос меняет due_at и создаёт revision, но не baseline_due_at. Дата завершения ставится сервером. Backdated correction доступна руководителю с отдельной effective date и reason, не меняет audit timestamp. Task с reviewer проходит In Review, Done ставит eligible reviewer; task без reviewer завершает assignee либо Lead. Assignee не завершает собственный review-required task в обход policy.

Dependencies: Finish-to-Start, без циклов и self-edge. Задачу нельзя начать, если predecessor не Done; Lead может Override Dependency с причиной, snapshot и предупреждением. Отмена predecessor требует выбора Replace / Remove Dependency / Keep Blocked. Изменение даты predecessor предлагает вычисленный preview последующих дат; не двигает чужие deadlines молча.

Parent task не завершать, пока обязательные children не Done/Cancelled с accepted cancellation reason. Checklist item хранит mandatory flag; изменения mandatory после submission создают review change. Reopen Done создаёт новый cycle event и причину. Completion count для производительности считает уникальные задачи с последним действительным Done в периоде, отдельно показывая reopened count.

Recurring tasks: Daily/Weekly/Monthly с local time и IANA zone; horizon 30 дней, unique occurrence key. Выбрать fixed schedule или after completion — эти режимы взаимоисключающие. Для 31-го числа политика Last Day of Month фиксируется в форме. Пропущенные после outage occurrences: по умолчанию создать одну overdue occurrence и список пропущенных дат, не сотню задач; настройка backfill до 30 событий с preview. Изменение rule применяется к будущим не начатым экземплярам после diff.

Timer использует server started_at, browser только отображает elapsed. Продолжается при закрытии вкладки; по истечении 12 часов — Needs Review и reminder, но не выдуманный stop. Manager может закрыть с actual_end и reason. No surveillance: нет screenshots рабочего стола, keystrokes и скрытого tracking. TimeEntry ≤24 часов, duration >0, не в будущем; breaks и task time не суммируются автоматически как одно и то же.

Capacity: default 8 h Mon–Fri — предложенный шаблон, подтверждается для каждого участника; возможны собственные дни. Available capacity = schedule hours − approved absences. Planned remaining task effort распределяется поровну по доступным рабочим дням между start/due, после чего руководитель может задать manual allocation. Unestimated отдельно. Overload = max(0, planned hours − available hours). Отображать алгоритм распределения, не выдавать его за точный прогноз занятости.

## 12. Публикации, кампании, ссылки и эксперименты

Publication statuses: Draft → Scheduled → Published; Scheduled → Failed или Cancelled; Failed → Scheduled после повторного планирования. Historical Published создаётся отдельной командой с прошлой датой и source note. Нельзя редактированием status string обойти доменные команды.

Schedule требует account Active, version Approved, caption policy проекта выполнена, owner active, scheduled_at > now. Preparing/Paused/Restricted допускаются только Lead override с reason и предупреждением о ручной проверке возможности публикации; Archived не допускается даже через override. Предупреждение о двух размещениях на один account в пределах 15 min; допускается override с reason. Caption length платформы не заявлять универсально допустимой: настраиваемые внутренние лимиты профиля и ручная проверка площадки. CRM не гарантирует приём материала внешним сервисом.

Mark Published: actual_published_at не более now+5 min для рассинхронизации, URL HTTPS или no_url_reason 10–500 chars. При отсутствии URL визуальный badge URL Missing и task для уточнения. Unique account+normalized external_post_url при наличии URL. Повтор команды с тем же idempotency key возвращает исходную запись, другой key с тем же URL — conflict. Post URL не проверяется серверным произвольным fetch.

При публикации создать checkpoints 24h и 7d от actual_published_at. Целевые окна: 24h ±2h; 7d ±12h. Замер вне окна сохраняется Late/Early и не входит по умолчанию в одинаковое checkpoint comparison. Timezone меняет отображение, elapsed window считается по UTC. Изменение actual_published_at предлагает пересчитать future checkpoints; completed observations остаются с реальными observed_at.

Plan baseline: при первом Schedule сохраняется original_scheduled_at для истории первого обещанного срока. Subsequent schedule revisions содержат from/to, reason, changed_at. Для weekly plan в Monday 00:00 workspace timezone создаётся baseline snapshot запланированных размещений недели с baseline_scheduled_at, равным расписанию на момент freeze. Публикации, добавленные позже, идут Added After Baseline. Перенос за пределы недели после freeze не удаляет строку этого плана. M09 использует baseline_scheduled_at данного снимка, не перезаписываемый current scheduled_at и не обязательно самый первый original_scheduled_at. Для произвольного периода M09 агрегирует snapshot cohorts входящих недель с указанными границами; неполная неделя помечена Partial Week. В отчёте Original Plan и Current Plan раздельны.

Campaign содержит конкретную цель и связанные placements. Один placement может иметь один primary campaign для аддитивных финансовых отчётов и дополнительные descriptive tags. Shared cost allocation не дублируется из-за нескольких tags. TrackingLink builder принимает HTTPS destination и utm_source/medium/campaign/content/term, URL-encodes параметры, не перезаписывает существующие без preview. Сам факт создания UTM не создаёт clicks/conversions.

Attribution в текущей версии: Source-Reported с внешним отчётом, Manual Assignment с actor/reason, либо Unattributed. Каждая sale/conversion имеет один primary campaign attribution или Unattributed. Многоканальное распределение поддерживается только через явные allocation shares суммой 100%, не как автоматическая догадка. Нельзя складывать overlap traffic источники без дедупликации и подтверждённых IDs.

Experiment фиксирует hypothesis, variants, primary metric, comparison window, minimum observed sample, start/end и limitations до начала. После старта изменения создают revision. Result показывает только сравнимые placements, sample count, median/mean с названием метода, outliers и пропуски. Winner выбирается ответственным с пояснением, а не выдаётся как доказанная причинность. Paid и organic observations разделены.

## 13. OFM: полный операционный цикл

### 13.1. Назначения и покрытие

OFMProfile включается для Project, без создания второго контента и второго финансового ledger. OFM assignment связывает сотрудника, аккаунт и период. Для нескольких менеджеров одного account задаются coverage lanes (Primary, Support либо пользовательские названия). Один сотрудник не может одновременно вести две active shifts. Для работы с несколькими аккаунтами одна Shift содержит primary_account_id и до 9 дополнительных ShiftAccount links; каждый account имеет valid assignment и coverage lane. S42/S43 показывают Primary Account и Additional Accounts, отчёт содержит отдельные секции по аккаунтам. Одно общее время смены не размножается по числу аккаунтов. Для отчёта Revenue per Account Hour можно задать подтверждённые time allocation shares суммой 100%; без них доступен только показатель по всей смене. Equal split разрешён как явно выбранная расчётная модель с меткой Allocated Hours, не как фактически измеренное время. В schedule overlap проверяется member interval и coverage lane каждого включённого account.

Scheduled shifts duration 15 min–16 h; переход через полночь разрешён. Supervisor видит employee local time и workspace time. Repeat schedule генерирует preview до 8 недель. Swap request требует согласия нового участника и supervisor approval, проверяет пересечения и действительность assignment. История прежнего назначенного остаётся.

### 13.2. Состояния смены и отчёта

Shift lifecycle: Scheduled → Active ↔ Paused → Ended; Scheduled → Cancelled/Missed. Missed ставится supervisor или системой как Needs Review после scheduled_end, окончательное подтверждение отдельно. Report lifecycle: Not Started → Draft → Submitted → Changes Requested → Submitted → Approved. Оба состояния отображаются рядом: Ended / Report Pending допустимо.

Start разрешён назначенному члену с действительным доступом; более чем за 15 минут до scheduled_start требует supervisor override. Опоздание фиксируется как факт actual_start − scheduled_start, не штраф. Нет clock-in по IP/geolocation. Pause создаёт открытый break; Resume закрывает. End сначала закрывает active break тем же timestamp, фиксирует actual_end, создаёт report draft. Cancel Active запрещён: нужно End с причиной Aborted.

Забытое завершение после scheduled_end+30 min создаёт supervisor alert. Actual End не подставлять из расписания. При forced end сохранять entered_by и reason; фактическое время считается подтверждённым исправлением. Пересечения actual shifts должны пройти review перед компенсацией.

### 13.3. Отчёт и передача

Report поля: Summary*, Completed Work, Issues, Next Actions, source reports, sales candidates, optional counts (conversations handled, follow-ups completed, content requests, conversion events) с явной provenance Manual Report. None/unknown хранится null. Суммы подтверждённых продаж выводятся из связанных проведённых financial entries; непроверенные кандидаты отдельной строкой Pending Verification.

Передача включает ссылки на Operation/Task, priority, due, короткое business explanation и recipient. Одно и то же дело не клонируется между сменами. Аcknowledgement имеет timestamp и member. Если новый сотрудник не принял передачу, дело видно supervisor. Submit report требует заполнить Summary и либо handover items, либо No Open Items. Approve report замораживает revision, но не меняет платёжные операции.

### 13.4. Контакты и операции

Contact stages: New, Active, Follow-up, Inactive, Archived; labels настраиваемы. Alias — рабочий pseudonym. Не требовать реальные имя, телефон, адрес и дату рождения. Business notes относятся к выполнению запросов и обязательств. Record interaction сохраняет type Message Summary/Request/Issue/Other, occurred_at и сотрудника; это внесённая человеком заметка, не копия встроенного мессенджера.

Operation types: Follow-up, Content Request, Payment Check, Account Check, Issue Resolution, Other. Status: Open → In Progress → Waiting → Completed; Cancelled с причиной. Waiting требует Waiting For и Next Check At. При Content Request создаётся ContentItem draft с разрешённым кратким brief; личные заметки контакта не копируются в production по умолчанию. Менеджер видит business status результата, creator не получает доступ к contact history.

Merge contacts разрешён внутри одного account; preview показывает поля, notes, operations, transaction refs. Источники и авторы сохраняются, один primary alias, old IDs redirect. Финансовые суммы не суммируются как duplicate sales: unique source transaction constraints остаются. Merge между аккаунтами запрещён; можно только явную pseudonymous related contact link с отдельным правом.

### 13.5. Продажи и атрибуция менеджерам

SaleCandidate: source namespace, external transaction ID либо generated manual reference с evidence, account, occurred_at, gross/refund/fee breakdown при наличии, currency, contact optional, shift optional, claimed manager allocation. Supervisor/Finance проверяет источник, duplicate warnings и суммы. Verified создаёт Draft financial entry; Post выполняется отдельным permission. Candidate Rejected сохраняет reason и не входит в выручку.

Атрибуция менеджеру не устанавливается автоматически по совпадению времени продажи со сменой. Нужен подтверждённый source assignment или ручное распределение. Сумма attribution shares ≤100%; остаток Unassigned. При двух менеджерах, например, 60/40 проценты применяются к одной подтверждённой базе. Перераспределение после утверждения compensation run вызывает adjustment в новом run, не переписывает прошлую выплату.

### 13.6. Качество

Стартовая rubric: Handover Completeness, Task Follow-through, Data Accuracy, Response Process Compliance. Вес каждого 25%; score 0–4 или N/A. Итог = sum(score/4 × weight) / sum(applicable weights) ×100; при всех N/A итог No Score. Время ответа можно оценивать только по подтверждённым входящим/исходящим timestamps; длительность смены не заменяет response time.

Evidence обязательна для негативной оценки 0/1. Reviewer не оценивает собственную смену. Published review доступна сотруднику и supervisor в scope; Dispute создаёт отдельную ветку resolution. Не создавать скрытый рейтинг «качества человека» и автоматические удержания из зарплаты на основе score.

## 14. Library, Knowledge Base, файлы и версии

File upload pipeline: authorize → reserve quota → issue upload session → multipart upload to quarantine → complete/checksum verification → MIME and decoded bounds validation → malware scan → isolated derivative processing → Available либо Rejected/Failed. UI показывает Uploaded, Checking, Processing, Available раздельно. Файл не становится approved content из-за успешной загрузки.

Storage keys генерируются сервером, не из пользовательского пути. Original filename хранится как metadata и очищается при Content-Disposition. Blob immutable. Не делать fetch произвольного External Link для thumbnails; ссылка может вести на недоступный сервис, URL остаётся заметкой. Если в будущем добавлен remote preview, потребуется отдельный SSRF-защищённый сервис; в текущем scope его нет.

Client upload credential даёт запись только в quarantine key конкретной upload session. После проверки сервер переносит/копирует точную проверенную object version в новый private final key, на который клиент никогда не получал write credential; metadata фиксирует checksum и storage version ID. Повторное использование ещё действующей upload-ссылки не может заменить уже утверждённый final blob. Complete consume атомарен; повторная обработка старого quarantine object не создаёт другую доступную версию без нового use case. Multipart manifests и final checksum сверяются с источником, который действительно прошёл scan.

Quota default 500 GB на workspace, adjustable Owner. Перед началом upload проверять quota, учитывать in-flight reservations, освобождать брошенные reservations через 24 h. При превышении можно читать/скачивать существующее и удалять допустимое, но нельзя начать новую загрузку. Retry продолжает upload session до 24 h; expired session создаёт новую с сохранением UI выбранного файла, если браузер ещё имеет к нему доступ.

Удаление версии, на которую ссылаются approved content, published placements, financial evidence или article version, запрещено обычным Delete. Archive скрывает из browse, но оставляет исторические ссылки. Remove Link удаляет одну связь и не blob. Purge физического файла только после отсутствия удерживающих связей и истечения retention; операция учитывает производные, thumbnails, search и backup expiration.

Knowledge rich text поддерживает headings 1–3, paragraphs, ordered/unordered lists, checklist, tables, quotes, safe links, images и attached files. Произвольные scripts/iframes и executable HTML запрещены. Published version frozen. Revert creates new draft from old version. Required reading при новой существенной версии создаёт новые acknowledgement requests; простая правка опечатки может быть Minor Revision без повторного обязательного прочтения, choice и actor записываются.

## 15. Сбор метрик, источники и качество данных

### 15.1. Три семантики времени

Snapshot — состояние на момент observed_at: followers, active subscribers. Period — результат за полуоткрытый интервал [period_start, period_end): account views, reported revenue, clicks. Cumulative — накопленный результат конкретной публикации на момент observed_at: total views, likes. Эти группы не складываются между собой.

MetricObservation фиксирует entity, observation semantics, timestamps, platform reporting timezone, definition set version, source type Manual/CSV/External Report, entered_by, entered_at, evidence refs, quality state Unverified/Reviewed/Superseded/Missing. Source time и entered time различаются. Server не утверждает, что самостоятельно получил показатели.

Связанный metric value хранит decimal/integer, unit, availability Known/Unknown/Not Provided/Not Applicable. Значение 0 допустимо только как явный ввод. Пустое поле — Unknown. Нельзя выводить average watch time=0 для источника, который его не предоставляет. Финансовый amount в imported platform metrics — аналитическое наблюдение; в управленческий ledger он попадёт только после отдельной сверки.

### 15.2. Доступные поля по dataset

Account Snapshot: followers, following optional, total posts optional, active paid subscribers optional. Account Period: views, impressions, reach, profile visits, link clicks, new follows, unfollows, watch time seconds, platform-reported conversions. Publication Cumulative: views, impressions, reach, likes, comments, shares, saves, total watch time, average watch time, completions, clicks. OFM Period: new paid subscribers, renewals, cancellations, purchases, gross sales, refunds, platform fees; все поля только при доступном источнике.

Platform definition profile перечисляет разрешённые поля и подсказки. Наличие поля в CRM не означает, что каждая площадка отдаёт его пользователю. Пользователь может отметить Not Provided. Для paid/organic обязательна segment dimension Unknown/Organic/Paid/Combined; нельзя складывать Combined с его составляющими.

### 15.3. Проверки и коррекции

Счётчики целые 0…9×10^15, деньги decimal по currency, duration seconds ≥0. Period end > start; observed_at ≤ now+5 min; для Cumulative observation time ≥ published_at. Platform source period may precede entry date; будущий period закрытых фактических данных запрещён. Reach выше impressions или completions выше views — warning, не безусловный запрет: определения источников могут различаться. Требовать note при сохранении warning.

Duplicate key: entity + definition set + observation kind + observed_at либо period_start/end + segment + source namespace. Разные источники одного периода могут сосуществовать, но нужен один canonical selection для отчёта. После correction старая revision становится Superseded, не суммируется. Analyst approve correction отображает old/new diff. При одновременной правке revision conflict не теряет данные.

Overlapping Period observations для одного metric/entity/segment: при точном совпадении — revisions, при частичном пересечении — обе записи хранятся с conflict warning, агрегат не суммирует их. Пользователь выбирает непротиворечивый набор или импортирует daily breakdown. Недельный total нельзя автоматически разделить на семь якобы реальных ежедневных значений.

### 15.4. Свежесть и покрытие

Account cadence default weekly, owner задаёт day/time; отдельный follower snapshot может быть daily. Publication checkpoints по разделу 12. Freshness overdue = now > expected_at + grace. Freshness показывает Last Observed At и Last Entered At отдельно. Coverage = completed usable required checkpoints / expected required checkpoints в выбранном scope/period. Missing с reason в числителе не участвует; закрытый запрос не равен полученным данным.

Обязательные поля checkpoint настраиваются в policy version. Completeness по значению = количество Known обязательных полей / количество applicable обязательных полей. Если applicable=0, Not Applicable. Source quality badge показывает происхождение и review state, а не искусственную «точность 99%».

## 16. Каталог показателей и формулы

Все отчёты используют общий semantic layer. У каждой метрики key, label, description, unit, allowed dimensions, aggregation, null policy, source tables, permission, available time grain и definition version. Tooltip показывает формулу человеческим языком. Сортировка учитывает числовое значение, не форматированную строку.

| ID | Показатель | Формула и ограничения |
|---|---|---|
| M01 | Published Count | Count уникальных Publication со status Published и actual_published_at в периоде. Размещения одного материала в двух аккаунтах считаются двумя публикациями. |
| M02 | Produced Content | Count уникальных ContentItem, впервые получивших approval в периоде. Повторное согласование новой версии не увеличивает выпуск; revisions отдельно. |
| M03 | Current WIP | Count content в Ready/Production/Review/Changes Requested на момент as-of. Archived исключены, blocked subset отдельно. |
| M04 | Production Lead Time | Для впервые утверждённого content: first_approved_at − entered_ready_at; median, p90, sample size. Нет Ready event — исключить и указать missing count. |
| M05 | Review Turnaround | По завершённым review rounds: decision_at − submitted_at. Median, p90; текущие ожидания отдельно. |
| M06 | Rework Rate | Content с ≥1 Request Changes / content с хотя бы одним завершённым review round в cohort первого submission периода ×100. Late unresolved обозначены. |
| M07 | Task On-Time Rate | Done tasks с completed_at ≤ baseline_due_at / все tasks с baseline_due_at в периоде ×100. Незавершённые и отменённые после фиксации baseline входят в denominator; cancelled count показан отдельно. Задачи, отменённые до baseline, отсутствуют в cohort. Approved baseline correction создаёт новую report revision. |
| M08 | Overdue Tasks | Open tasks с due_at < as_of, excluding Done/Cancelled; клик возвращает точный список. |
| M09 | Publication Plan Completion | Baseline placements выбранного snapshot cohort, опубликованные не позже baseline_scheduled_at+15 min / все baseline placements cohort ×100. Удалённые после baseline и cancelled остаются в denominator с reason, пока не утверждена отдельная restatement. |
| M10 | Current Plan Completion | Published из текущего списка planned cohort / текущий план ×100; отдельно от M09, не заменяет его. |
| M11 | Followers Change | Last usable snapshot − first usable snapshot в заданных границах; реальные timestamps показываются. Нет двух снимков — Not Enough Data. |
| M12 | Followers Growth % | (last−first)/first×100; first=0 → Not Defined, абсолютный прирост остаётся. |
| M13 | Account Views | Sum только непересекающихся period observations одной definition/segment. Snapshot lifetime views не суммировать. |
| M14 | Publication Views at Checkpoint | Canonical cumulative views для выбранного age window; несколько observations выбираются по минимальному расстоянию до expected_at, tie — reviewed/latest revision. |
| M15 | Period Views Delta | Cumulative end − cumulative start одного post при совместимой definition; даты фактических снимков видны. Negative delta помечается Source Correction и не показывается как отрицательное потребление без пояснения. |
| M16 | Interactions | likes+comments+shares+saves при Known всех четырёх; иначе Partial Interactions, перечень missing, не использовать в полном ER. |
| M17 | ER by Views | interactions/views×100 на той же публикации, timestamp/window и segment; views=0/null → Not Defined/No Data. Может быть >100 по определениям, не clamp. |
| M18 | ER by Reach | interactions/reach×100 при согласованном источнике; отдельно от ER by Views. |
| M19 | Aggregate ER | sum eligible interactions / sum eligible denominator ×100; не среднее процентов. Показать eligible count и excluded count. |
| M20 | Completion Rate | confirmed completed_views/eligible views×100, если источник предоставляет совместимые поля. Не выводить из duration ролика. |
| M21 | Average Watch Time | total_watch_time_seconds/views либо source-reported average с соответствующей меткой. Не смешивать методы в одной серии. |
| M22 | CTR | linked clicks/impressions×100 для одинаковых scope/period/segment; profile visits не заменяют impressions без нового названия. |
| M23 | Conversion Rate | source-attributed conversions/source-linked clicks×100 при общем tracking scope и совместимом окне; иначе Not Attributable. |
| M24 | Paid Subscriber Net Change | confirmed new subscriptions − confirmed cancellations за период; не заменяет изменение active subscribers при неполном источнике. |
| M25 | Renewal Rate | confirmed renewals / eligible-to-renew subscriptions cohort×100. Нет denominator — Not Measured. |
| M26 | Churn Rate | подтверждённые потери среди starting active cohort / starting active cohort×100. Без cohort данных не подставлять cancellations/current subscribers. |
| M27 | Revenue per Payer | recognized eligible revenue / unique confirmed paying contacts периода. Без consistent contact IDs — Not Measured. |
| M28 | Shift Net Hours | (actual_end−actual_start−closed breaks)/3600; approved corrections, отсутствие end → Pending. |
| M29 | Confirmed Revenue per Shift Hour | verified attributed net revenue for approved shift / approved net hours. Без attribution — Not Attributable, без часов — Not Defined. |
| M30 | Handover Completion | required handovers acknowledged / required handovers, deadline policy указана. Нет required items — Not Applicable. |
| M31 | Quality Score | Формула rubric из 13.6, version и applicable criteria рядом. |
| M32 | Utilization | approved tracked hours / available capacity hours×100, не «производительность». Может быть >100. |
| M33 | Gross Revenue | Sum posted revenue lines recognition period, original currencies отдельно либо frozen base equivalents. |
| M34 | Net Revenue | Gross Revenue − posted refunds − posted platform/payment fees. Fees считаются ровно один раз. |
| M35 | Operating Result | Net Revenue − posted operating expenses, including compensation expense, excluding settlements и already subtracted fees. |
| M36 | Operating Margin | Operating Result / Gross Revenue ×100; Gross≤0 → Not Defined. Название и denominator неизменны в tooltip. |
| M37 | Cost per Produced Unit | allocated production costs / unique produced units конкретного format/cohort. Общие расходы входят только по явной allocation. |
| M38 | Budget Remaining | Approved Budget − Actual − Outstanding Commitments в сопоставимой валюте. Negative показывает overspend. |
| M39 | Outstanding Compensation | Approved compensation accrual + adjustments − confirmed allocated payouts − reversals по currency. |
| M40 | Data Coverage | Usable required checkpoints / expected required checkpoints×100; Missing не usable. |
| M41 | Cash Movement | Confirmed cash inflows − confirmed cash outflows, по settlement date; это не operating result. |
| M42 | Source Match Rate | Reconciled source transaction rows / imported eligible transaction rows×100; duplicate rejected отдельно. |

Comparison: текущий полный период сравнивается с предыдущим периодом той же длины; незавершённый — с таким же elapsed interval. Delta abs=current−previous; delta%=delta/abs(previous)×100 только для метрик, где это осмысленно и previous≠0. Для rate метрик по умолчанию difference в percentage points. Unknown previous → No Comparison. Валюта conversion фиксируется по операциям; нельзя пересчитывать старые отчёты новым курсом без отдельного restated report.

Aggregate audience across accounts подписывается Sum of Account Followers, не Unique Audience. Сумма post reach подписывается Sum of Reported Post Reach и не утверждает уникальность людей. Platform-mixed views разрешены как Reported Views Across Platforms с предупреждением Definitions Differ; сравнение эффективности по умолчанию фильтруется одной platform/format/window.
