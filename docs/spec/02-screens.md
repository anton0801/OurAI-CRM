# Castlane CRM — Specification part 2: screen catalogue (section 5) and media (section 6)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 5. Screen/Route: полный каталог экранов

Для всех экранов обязательны общие правила раздела 4.7. Путь `/w/:workspaceId` подразумевается перед всеми рабочими маршрутами. ID сущностей — непрозрачные UUID. URL не является подтверждением прав. Звёздочка у поля означает обязательность. На всех экранах генерируемые декоративные растры отсутствуют; конкретные пользовательские изображения указаны отдельно.

### S01. Sign In — `/auth/sign-in`

- ЗАЧЕМ: Войти в свою учётную запись.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Центрированная форма 400 px; Email*, Password*, Show Password; название CRM, ссылка Forgot Password, общая ошибка без раскрытия существования email.
- КНОПКИ И РЕЗУЛЬТАТ: Sign In → MFA либо последняя разрешённая страница; Forgot Password → S03. Enter отправляет форму один раз.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Rate limit, disabled account, session expired, pending. Пароль допускает paste и password managers. Нет публичного Sign Up.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0. Векторный wordmark 120×24.

### S02. Accept Invitation — `/auth/invitations/:token`

- ЗАЧЕМ: Принять приглашение в команду.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Workspace, Invited Email readonly, Display Name* 2–80, Password*, Confirm Password*. Доступ описан без раскрытия закрытых проектов.
- КНОПКИ И РЕЗУЛЬТАТ: Accept Invitation → создание membership и MFA/My Work; Existing Account → вход и принятие после совпадения email.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Token одноразовый, 72 h; expired/revoked/already used. Смена email требует нового приглашения. Принятие атомарно.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; initials workspace в коде 40×40.

### S03. Password Recovery — `/auth/recovery` и `/auth/reset/:token`

- ЗАЧЕМ: Восстановить доступ.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Email*; затем New Password*, Confirm Password*. Сообщение If an account exists, reset instructions have been sent.
- КНОПКИ И РЕЗУЛЬТАТ: Send Reset Link; Reset Password → отзыв остальных сессий и переход к входу. Back to Sign In.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Token 30 min, одноразовый; повторный выпуск отзывает предыдущий. Отсутствующий SMTP показывает владельцу ошибку конфигурации, пользователю не обещает отправку.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S04. MFA Challenge / Setup — `/auth/mfa`

- ЗАЧЕМ: Дополнительная защита доступа.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: TOTP setup, Verification Code* или Recovery Code*. При setup — QR и secret с кнопкой копирования, затем recovery codes один раз.
- КНОПКИ И РЕЗУЛЬТАТ: Verify → продолжить; Use Recovery Code; Back to Sign In. Setup завершается только после корректного кода.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Ограничение попыток, защита от повторного TOTP, recovery code одноразовый. Секреты не попадают в логи.
- КАРТИНКИ НА ЭКРАНЕ: Художественных растров 0; QR генерируется кодом 192×192, с текстовой альтернативой secret.

### S05. Workspace Setup — `/setup/workspace`

- ЗАЧЕМ: Настроить рабочее пространство.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Step 1 of 3; Name* 2–80, Timezone* IANA, Base Currency*, Week Starts On, Logo optional.
- КНОПКИ И РЕЗУЛЬТАТ: Save and Continue → S06; сохранение серверного setup progress.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Только Owner; suggested timezone из браузера с подтверждением. Base Currency становится ограниченно изменяемой после первой проведённой операции.
- КАРТИНКИ НА ЭКРАНЕ: До 1 загруженного логотипа 48×48; без него кодовый знак.

### S06. Direction Setup — `/setup/directions`

- ЗАЧЕМ: Создать рабочие направления.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Step 2 of 3; три редактируемые строки AI Series, AI Models, AI Influencers, Name*, Lead optional.
- КНОПКИ И РЕЗУЛЬТАТ: Add Direction; Remove Unsaved; Back; Save and Continue → S07.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Хотя бы одно направление; case-insensitive уникальность активного имени. OFM отмечается как доступный модуль, не создаёт отдельную модель.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; векторные иконки типов 20×20.

### S07. Invite Team Setup — `/setup/team`

- ЗАЧЕМ: Подготовить первых участников.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Step 3 of 3; Email*, Role*, Scope*, до 20 строк за действие; preview разрешений.
- КНОПКИ И РЕЗУЛЬТАТ: Send Invitations → результат по адресам; Finish Setup → Overview; Invite Later → Overview без приглашений.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нельзя назначить Owner через обычную строку. Повтор email предлагает Resend с отзывом старого token. Ошибка отправки не маркируется Delivered.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S08. Overview — `/overview`

- ЗАЧЕМ: Принять управленческие решения по работе компании.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Period, Direction, Project; полоса 4 KPI: Published, On-Time Rate, Pending Reviews, Overdue Tasks. Ниже 8/4 grid: Production Trend и Needs Attention; затем Projects Table и Data Freshness. Финансовая строка отображается только при праве.
- КНОПКИ И РЕЗУЛЬТАТ: KPI → отфильтрованные исходные записи; Review → S25; New Project → S14; Export View → S54.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Никаких декоративных процентов. В empty workspace — checklist Start a Project / Add an Account / Create a Task. Scope применяется до агрегации.
- КАРТИНКИ НА ЭКРАНЕ: До 8 пользовательских thumbnails проектов 32×32 в видимых строках; крупного растра 0.

### S09. My Work — `/my-work`

- ЗАЧЕМ: Показать действия конкретного сотрудника.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Today, Upcoming, Overdue, Assigned to Me, Reviewing, Following; задачи, публикации, замеры и смены с типом объекта. Today определяется в личной timezone.
- КНОПКИ И РЕЗУЛЬТАТ: Open Task; Start Timer; Submit for Review; Open Shift; Mark Published через соответствующий dialog; Snooze только личного напоминания.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Snooze не изменяет deadline. Фильтр Following не даёт права на закрытый объект. Неназначенная задача не попадает в Assigned to Me.
- КАРТИНКИ НА ЭКРАНЕ: Avatars участников 24×24; не более одного thumbnail 40×40 на строку контента.

### S10. Inbox — `/inbox`

- ЗАЧЕМ: Обрабатывать персональные уведомления.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Unread / All / Archived, тип, инициатор, объект, timestamp, excerpt с учётом прав.
- КНОПКИ И РЕЗУЛЬТАТ: Open; Mark Read; Mark All Read для текущего фильтра после preview; Archive; notification settings.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Read не завершает задачу. Отозванный доступ убирает excerpt и thumbnail. Системные security alerts не имеют рекламного содержимого.
- КАРТИНКИ НА ЭКРАНЕ: По 1 avatar 28×28 на строку, если доступен; декоративных растров 0.

### S11. Search / Command Palette — `/search` и overlay Cmd/Ctrl+K

- ЗАЧЕМ: Найти доступный объект или команду.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Query, Type, Project, Assignee, Status; результаты с названием, типом и коротким разрешённым snippet. Palette 640 px, до 8 видимых результатов.
- КНОПКИ И РЕЗУЛЬТАТ: Enter → объект; Show All → full page; Quick Create → соответствующая форма.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Debounce 250 ms, запрос от 2 символов; exact ID поддерживается. Количество результатов не раскрывает закрытые записи. Команды не запускают финансовую операцию без формы.
- КАРТИНКИ НА ЭКРАНЕ: До 8 разрешённых thumbnails/avatars 28×28; внешние URL не загружаются автоматически.

### S12. Directions — `/directions`

- ЗАЧЕМ: Организовать направления и их руководителей.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name, Lead, Active Projects, Open Tasks, Updated At; drawer Name*, Description, Lead, Status.
- КНОПКИ И РЕЗУЛЬТАТ: Create; Edit; Open Projects; Assign Lead; Archive с проверкой проектов.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нельзя архивировать направление с активными проектами без их переноса/архива. Смена Lead показывает изменения доступа до применения.
- КАРТИНКИ НА ЭКРАНЕ: Avatar lead 28×28; иных растров 0.

### S13. Projects — `/projects`

- ЗАЧЕМ: Управлять портфелем проектов.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Table/List и компактный Gallery; Name, Type, Direction, Owner, Status, Open Tasks, Next Publication, Metrics Updated. Filters, tags, archive toggle.
- КНОПКИ И РЕЗУЛЬТАТ: New Project → S14; row → S15; bulk Assign Owner, Add Tags, Archive Preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: При снятии финансового права бюджетная колонка отсутствует и в API. Gallery не подменяет табличную работу. Archived выключен по умолчанию.
- КАРТИНКИ НА ЭКРАНЕ: Cover 40×40 в таблице или 16:9 240×135 в gallery; загруженные пользователем, при отсутствии — типографический placeholder.

### S14. Project Editor — `/projects/new`, `/projects/:id/edit`

- ЗАЧЕМ: Создать или изменить проект.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name* 2–120, Type* Series/Model/Influencer, Direction*, Owner*, Description, Language, Target Markets, Audience, Tags, Start Date, Cover, OFM Enabled для Model/Influencer.
- КНОПКИ И РЕЗУЛЬТАТ: Create Project → S15; Save Changes; Add Team после создания; Cancel.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Owner должен иметь членство и доступ. Изменение Type после появления seasons/OFM операций блокируется с объяснением. Creation не создаёт аккаунты и fake stats.
- КАРТИНКИ НА ЭКРАНЕ: 1 cover preview 240×135; crop является отдельной производной, оригинал сохраняется.

### S15. Project Workspace — `/projects/:id`

- ЗАЧЕМ: Работать с одним проектом.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Header с owner/status; tabs Overview, Accounts, Content, Tasks, References, Analytics, Activity; для Series — Series; при OFM Enabled — Operations. Overview: brief, milestones, upcoming, recent decisions.
- КНОПКИ И РЕЗУЛЬТАТ: Edit; New Content; Add Account; Manage Team; Archive Preview; tab открывает сохранённый project filter соответствующего модуля.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Tabs используют те же записи, не отдельные копии. Archived banner ограничивает новые операции. Pin Decision фиксирует версию решения.
- КАРТИНКИ НА ЭКРАНЕ: Cover 72×72 в header; последние материалы до 4×120×68; пользовательские.

### S16. Character Profile — `/projects/:id/characters/:characterId`

- ЗАЧЕМ: Сохранить идентичность персонажа.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name*, Role, adult age declaration для OFM-персонажа, appearance, voice, personality, tone, allowed variation, reference set, prompt versions, tools/settings, Approved Profile Version.
- КНОПКИ И РЕЗУЛЬТАТ: Save Draft; Submit; Approve Profile; New Version; View Affected Content; attach asset.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Версии неизменяемы после утверждения; материалы ссылаются на версию. Изменение профиля только помечает зависимые материалы Needs Consistency Review, не изменяет их изображения.
- КАРТИНКИ НА ЭКРАНЕ: Загруженные reference portraits до 12, thumb 96×128; главный preview до 320×426 с contain.

### S17. Series Structure — `/projects/:id/series`

- ЗАЧЕМ: Организовать сезоны, эпизоды и сцены.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Season Name*, Order, Episode Number*, Title*, Synopsis, Target Duration, Language, Content Link; expandable scenes с order, script, characters, deliverables.
- КНОПКИ И РЕЗУЛЬТАТ: Add Season/Episode/Scene; reorder с keyboard alternative; Generate Production Tasks; Open Content; Export Episode Package.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Уникальность номера эпизода внутри сезона и языка; перестановка не меняет stable ID. Удаление эпизода с публикациями заменяется archive. Export не публикует в Dramora.
- КАРТИНКИ НА ЭКРАНЕ: Episode thumbnails 64×36, scene thumbnails 48×48; только свои файлы.

### S18. Accounts — `/accounts`

- ЗАЧЕМ: Найти аккаунты и проверить ответственность.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Platform, Handle, Project, Owner, Status, Last Metrics At, Next Publication, Missing Checkpoints; filters по scope и tags.
- КНОПКИ И РЕЗУЛЬТАТ: Add Account → S19; Open Detail → S20; Open External; bulk Assign, Schedule Metrics Check.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Open External безопасно открывает пользовательский URL в новой вкладке. Нет Connect Instagram, Connect OnlyFans или ложных connected badges.
- КАРТИНКИ НА ЭКРАНЕ: По 1 загруженному avatar 32×32; иконка платформы векторная/текстовая.

### S19. Account Editor — `/accounts/new`, `/accounts/:id/edit`

- ЗАЧЕМ: Зарегистрировать внешний аккаунт.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Platform*, Profile URL*, Project*, Owner*, Handle, Display Name, Language, Markets, Purpose, Status, Notes, Avatar, Metrics Cadence.
- КНОПКИ И РЕЗУЛЬТАТ: Save → S20; Normalize URL preview; Add Member; Cancel.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: HTTPS URL, host validation по выбранной платформе либо Custom; duplicate detection до save. Пароль/OTP соцсети не запрашиваются. Rename сохраняет историю handle/URL.
- КАРТИНКИ НА ЭКРАНЕ: 1 avatar preview 80×80; автоматического скачивания профиля нет.

### S20. Account Detail — `/accounts/:id`

- ЗАЧЕМ: Управлять жизненным циклом аккаунта.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Account header, project, owner, status, external URL; tabs Overview, Publications, Tasks, Metrics, Team, Activity. Recent metrics с observation time и source.
- КНОПКИ И РЕЗУЛЬТАТ: Open Account; New Publication; Add Metrics; Assign Team; Log Incident; Pause/Resume; Archive Preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Paused предупреждает при планировании; Restricted блокирует новое планирование до override уполномоченного Lead с причиной. Инцидент не определяется автоматически по ссылке.
- КАРТИНКИ НА ЭКРАНЕ: Avatar 64×64; до 6 thumbnails публикаций 80×100.

### S21. References — `/references`

- ЗАЧЕМ: Накапливать идеи и объяснения приёмов.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Gallery/Table, tags Hook/Lighting/Story/Edit/Character/Other, Project, Author, Source; drawer Title*, URL or File*, What to Reuse*, Notes, Tags.
- КНОПКИ И РЕЗУЛЬТАТ: Add; Edit; Link Projects; Create Idea → S23 с reference link; Open Source; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Ссылка сама по себе не скачивает чужое видео. Preview только из загруженного изображения. Linked content сохраняет reference ID; удаление используемого reference — archive.
- КАРТИНКИ НА ЭКРАНЕ: Пользовательские preview 4:3, 220×165; full preview contain. Декоративных растров 0.

### S22. Content Pipeline — `/content`

- ЗАЧЕМ: Контролировать производство материалов.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Board/Table; canonical stages, WIP count, Project, Format, Owner, Due Date, Reviewer, Approved Version, Publication Count; filters и personal/shared views.
- КНОПКИ И РЕЗУЛЬТАТ: New Content; open drawer S24; drag stage → серверная проверка; bulk Assign/Tag/Move with Preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нельзя drag сразу в Approved в обход review. При запрете объяснить недостающие условия. Work In Progress превышение предупреждает, а не теряет карточку.
- КАРТИНКИ НА ЭКРАНЕ: Один thumbnail 16:9 на card опционально; compact mode только 32×32. Изображения пользователя.

### S23. Content Editor — `/content/new`, `/content/:id/edit`

- ЗАЧЕМ: Создать бриф и единицу производства.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Title*, Project*, Format*, Owner*, Objective, Audience, Hook, Script, Caption Draft, CTA, Language, References, Characters and Versions, Due At, Reviewer, Template.
- КНОПКИ И РЕЗУЛЬТАТ: Save Draft; Create and Apply Template; Preview Generated Tasks; Cancel. Редактирование Published не меняет факт публикации.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Минимальный Idea draft требует Title/Project/Format; owner обязателен перед Production. Template application имеет уникальный run ID. Потеря сети сохраняет unsaved indicator.
- КАРТИНКИ НА ЭКРАНЕ: До 6 linked reference thumbs 64×64; никаких фонов.

### S24. Content Detail / Versions — `/content/:id`

- ЗАЧЕМ: Собрать работу, файлы, обсуждение и результаты.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Title/status/project; tabs Brief, Tasks, Versions, Publications, Results, Activity; current version, approved version, assignee/reviewer, missing checklist.
- КНОПКИ И РЕЗУЛЬТАТ: Upload Version; Submit for Review; Duplicate as New Draft; Add Publication; Download Approved; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Latest и Approved — разные указатели. Если новая версия не проверена, нельзя назвать её Approved. Историческая публикация продолжает ссылаться на использованную версию.
- КАРТИНКИ НА ЭКРАНЕ: Один главный preview до 720×480, version strip до 8×72×48; видео воспроизводится только по нажатию.

### S25. Review Queue — `/reviews`

- ЗАЧЕМ: Найти материалы и профили, ожидающие решения.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Assigned to Me / All Permitted; submitted at, due, project, version, author, round, open blocking comments.
- КНОПКИ И РЕЗУЛЬТАТ: Open Review → S26; Assign Reviewer; request missing files; фильтр Overdue.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Утверждение только внутри конкретного review. Bulk Approve отсутствует для медиа без просмотра. Очередь обновляется без прыжка выбранной строки.
- КАРТИНКИ НА ЭКРАНЕ: 1 thumbnail 64×40 на строку и avatar автора 24×24.

### S26. Review Studio — `/reviews/:id`

- ЗАЧЕМ: Проверить версию и дать конкретную обратную связь.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Desktop 2/3 media, 1/3 comments; version selector, compare with previous, video timecode, image annotation x/y normalized; blocker checkbox, resolved state.
- КНОПКИ И РЕЗУЛЬТАТ: Add Comment; Resolve; Request Changes с Summary*; Approve Version; Open Original; Download при праве.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Решение атомарно проверяет version/review revision; устаревшая версия → 412, недопустимый переход при актуальной версии → 409. Unresolved blockers запрещают approval. Автор не может сам утвердить без явной настройки exceptional self-review с аудитом.
- КАРТИНКИ НА ЭКРАНЕ: Один либо два сравниваемых файла; изображение contain, исходные пропорции; никакого декоративного слоя поверх контента.

### S27. Tasks — `/tasks`

- ЗАЧЕМ: Планировать работу по всему доступному scope.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Table/Board/Timeline; Title, Project, Linked Object, Assignee, Reviewer, Status, Priority, Start, Due, Estimate, Dependencies, Blocked reason. Filters, group by, saved views.
- КНОПКИ И РЕЗУЛЬТАТ: New Task; bulk Assign/Reschedule; Change Status; Duplicate; Export; Open S28.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Done требует выполнения обязательных checklist items и review policy. Overdue вычисляется, не является статусом. Timeline переносит даты только после preview влияния на зависимости.
- КАРТИНКИ НА ЭКРАНЕ: Avatars 24×24, иных растров 0.

### S28. Task Detail — `/tasks/:id`, create drawer

- ЗАЧЕМ: Выполнить конкретную работу.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Title* 3–200, Project*, optional Account/Content/Publication/Shift, Description, Assignee*, Reviewer, Priority, Status, Start/Due, Estimate, Checklist, Dependencies, Attachments, Comments, History.
- КНОПКИ И РЕЗУЛЬТАТ: Save; Start Work; Block с Reason*; Start/Stop Timer; Submit; Complete; Reopen с Reason; Add Subtask; Cancel Task.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Draft может быть Unassigned, переход In Progress требует исполнителя. Parent completion policy видна. Самозависимость и циклы запрещены. Due Date очищается явно.
- КАРТИНКИ НА ЭКРАНЕ: Attachment thumbnails до 6×64×64, avatars 24×24; файлы по клику в S37.

### S29. Workload — `/team/workload`

- ЗАЧЕМ: Распределить работу по доступной ёмкости команды.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Week/Month, members, capacity hours, leave, assigned estimates, unestimated count, overload. Grid rows 56, day column min 80.
- КНОПКИ И РЕЗУЛЬТАТ: Open Tasks; Reassign; Change Estimate; Add Absence; Adjust Capacity с правом руководителя.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Неоценённая задача не равна нулю часов. Ёмкость и плановые оценки не являются доказанным рабочим временем. Conflicting reassign → refresh preview.
- КАРТИНКИ НА ЭКРАНЕ: Avatar каждого видимого сотрудника 28×28; график создаётся кодом.

### S30. Time Entries — `/time`

- ЗАЧЕМ: Вести добровольный явный учёт времени по задачам.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Date, Member, Task*, Start/End or Duration*, Note, Billable flag при праве, source Timer/Manual, approved state.
- КНОПКИ И РЕЗУЛЬТАТ: Add Entry; Start/Stop; Submit Week; Approve/Return; Edit Unapproved; Export.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Один running timer на пользователя; повтор Stop не создаёт второй entry. Пересечения manual entries предупреждаются и требуют исправления. Approved entry исправляется revision, не тихим edit.
- КАРТИНКИ НА ЭКРАНЕ: Avatars 24×24; других растров 0.

### S31. Calendar — `/calendar`

- ЗАЧЕМ: Согласовать производство, публикации и занятость.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Month/Week/Agenda; layers Publications, Tasks, Milestones, Shifts; timezone selector, project/account filters. Видимый тип события, статус, время, ответственный.
- КНОПКИ И РЕЗУЛЬТАТ: Create Publication; Open Object; Move Event → reschedule preview; Today; previous/next period.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Локальный календарный день отличается от UTC; DST обрабатывается явно. Перенос опубликованной записи меняет только через correction dialog факт даты, не план drag. Phone использует Agenda по умолчанию.
- КАРТИНКИ НА ЭКРАНЕ: Опциональный thumbnail 24×24 события; в плотном Month растры выключены.

### S32. Publication Detail / Editor — `/publications/:id`, `/publications/new`

- ЗАЧЕМ: Подготовить и подтвердить одно размещение.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Content*, Asset Version*, Account*, Owner*, Caption, CTA, Destination URL, Campaign, Scheduled At + timezone, Actual Published At, External Post URL, Status, checkpoints.
- КНОПКИ И РЕЗУЛЬТАТ: Save Draft; Schedule; Mark Published; Mark Failed; Retry Planning; Cancel; Add Metrics; Correct Publication с причиной.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Schedule требует approved version, допустимый по 12 статус account и будущую дату; обычный случай — Active. Mark Published допускает past/manual historical entry, требует URL или объяснение Missing URL. Один контент в двух аккаунтах — две записи.
- КАРТИНКИ НА ЭКРАНЕ: 1 preview 240×300 либо 320×180 по формату; account avatar 32×32. Caption отрисован текстом, не запечён.

### S33. Campaigns — `/campaigns`

- ЗАЧЕМ: Управлять объединёнными активностями продвижения.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name, Objective, Owner, Dates, Status, Projects, Planned/Published, Budget при праве, confirmed results; table и timeline.
- КНОПКИ И РЕЗУЛЬТАТ: New Campaign; Open; Duplicate Structure; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Кампания не создаёт аккаунты и метрики автоматически. Duplicate сбрасывает расходы, доходы, публикации и фактические показатели.
- КАРТИНКИ НА ЭКРАНЕ: 1 optional cover 40×40 на строку, avatars 24×24.

### S34. Campaign Workspace — `/campaigns/:id`

- ЗАЧЕМ: Связать цель, материалы, источники трафика и результат.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name*, Objective*, Owner*, Start/End*, project links, publications, goals, budget, partner, tracking links; tabs Overview/Deliverables/Links/Results/Finance/Activity.
- КНОПКИ И РЕЗУЛЬТАТ: Add Deliverable; Build Tagged URL; Add Source Report; Link Deal; Close Campaign с итогом; Reopen.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Tagged URL — обычная ссылка с параметрами, не встроенный redirect tracker. Click counts появляются только из внесённого источника. Attribution labels обязательны.
- КАРТИНКИ НА ЭКРАНЕ: До 6 previews материалов 80×100; графики только из записей.

### S35. Experiments — `/experiments`

- ЗАЧЕМ: Сохранять гипотезы о форматах контента и проверенные наблюдения.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Hypothesis*, Project*, Owner*, Variants*, Primary Metric*, Observation Window*, linked publications, Result Note, Limitations, Status.
- КНОПКИ И РЕЗУЛЬТАТ: Create; Start; Link Publications; View Comparable Results; Conclude; Duplicate Hypothesis.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Не называть органическое сравнение рандомизированным A/B-тестом. Не генерировать statistical significance без реализованного метода. Разный возраст публикаций отмечать Not Comparable.
- КАРТИНКИ НА ЭКРАНЕ: По 1 thumb на variant 160×100 при наличии; до 4 одновременно.

### S36. Library — `/library`

- ЗАЧЕМ: Найти исходник, версию или утверждённый файл.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Table/Grid, folders logical, tags, project, type, size, uploader, processing status, sensitivity, linked usage. Breadcrumb внутри папок.
- КНОПКИ И РЕЗУЛЬТАТ: Upload; Add External Link; New Folder; Move; Link to Content; Open S37; Download при праве; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Folder не меняет ACL самостоятельно; перемещение между scopes через preview. Quarantined файлы не открываются. Duplicate hash предлагает reuse, не раскрывая чужой файл.
- КАРТИНКИ НА ЭКРАНЕ: Пользовательские image/video thumbs 160×120; PDF thumbnail только после safe rendering. Нет сторонних stock photos.

### S37. Asset Viewer / Upload Manager — `/library/assets/:id`

- ЗАЧЕМ: Просмотреть файл, загрузку и места использования.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Preview, Name, MIME, byte size, dimensions/duration, hash, version, owner, usage links, processing state, sensitivity, retention. Upload list показывает progress и error per file.
- КНОПКИ И РЕЗУЛЬТАТ: Download; New Version; Retry Upload; Cancel Upload; Set Cover; Link; Delete Preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Оригинал неизменяем; замена создаёт новый AssetVersion. Отзыв доступа прекращает новые выдачи download credentials. External link не считается локально доступным файлом.
- КАРТИНКИ НА ЭКРАНЕ: Один preview до доступной области; raster отсутствует для audio/document без готовой производной. Audio waveform только рассчитанный из файла.

### S38. Knowledge Base — `/knowledge`

- ЗАЧЕМ: Находить рабочие регламенты и инструкции.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Categories, Articles, status Draft/Published/Archived, owner, updated date, required reading, search.
- КНОПКИ И РЕЗУЛЬТАТ: New Article; Open S39; Assign Reading; Manage Category.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Draft доступен авторам/редакторам, опубликованный текст — scope статьи. Аcknowledgement новой обязательной версии учитывается отдельно.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0 в list; optional article cover 48×32 при пользовательской настройке.

### S39. Article Editor / Reader — `/knowledge/:id`

- ЗАЧЕМ: Создавать и читать конкретный регламент.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Title*, Category*, Scope*, Owner*, structured rich text, attachments, versions, read acknowledgements, last reviewed date.
- КНОПКИ И РЕЗУЛЬТАТ: Save Draft; Publish Version; Compare; Acknowledge Read; Create Task from Checklist; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: HTML sanitization, safe links, revision conflict. Прочтение не определяется по открытию страницы; Acknowledge — явное действие.
- КАРТИНКИ НА ЭКРАНЕ: Только вложенные пользователем иллюстрации, max rendered width 760; lazy loading.

### S40. OFM Overview — `/ofm`

- ЗАЧЕМ: Контролировать обслуживаемые модели и текущие операции.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Assigned Models, Active Shifts, Missing Handover, Reports to Review, Open Follow-ups; revenue summary только с финансовым правом и указанием источника.
- КНОПКИ И РЕЗУЛЬТАТ: Open Model Operations; Schedule Shift; Review Report; Assign Manager; Open unresolved issues.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Active означает CRM session timer, не online статус внешней площадки. Просмотр операций требует OFM scope сверх доступа к production.
- КАРТИНКИ НА ЭКРАНЕ: Avatars моделей 40×40 и менеджеров 28×28; sensitive thumbnails скрыты без отдельного разрешения.

### S41. OFM Assignments — `/ofm/assignments`

- ЗАЧЕМ: Назначить менеджеров на модели и аккаунты.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Project*, Account*, Member*, Responsibility*, Valid From*, Valid To optional, Supervisor, Handover Required.
- КНОПКИ И РЕЗУЛЬТАТ: Add Assignment; Transfer; End Assignment; View Upcoming Shifts; access impact preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Assignment не выдаёт финансовое право сам по себе. Истекающий assignment блокирует новые смены за пределами срока. История прежних назначений сохраняется.
- КАРТИНКИ НА ЭКРАНЕ: Model/member avatars 28×28.

### S42. Shift Schedule — `/ofm/shifts`

- ЗАЧЕМ: Составить график работы.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Week/Day/List; Member*, Account*, Start*, End*, timezone, coverage lane, supervisor, status; capacity/leave indicators.
- КНОПКИ И РЕЗУЛЬТАТ: Schedule; Repeat Schedule with Preview; Request Swap; Approve Swap; Cancel Shift с причиной; Open S43.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Пересечение смен одного сотрудника запрещено; для одного аккаунта допускаются разные coverage lanes. Дополнительная смена требует явного обозначения parallel coverage. DST preview обязателен.
- КАРТИНКИ НА ЭКРАНЕ: Avatars 24×24; прочих растров 0.

### S43. Shift Workspace — `/ofm/shifts/:id`

- ЗАЧЕМ: Провести и сдать смену.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Scheduled/Actual times, breaks, linked account, previous handover, tasks, observations, source reports, revenue candidates, report draft, reviewer.
- КНОПКИ И РЕЗУЛЬТАТ: Acknowledge Handover; Start; Pause; Resume; Add Operation; End; Submit Report; Approve Report; Request Changes.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Timer серверный; refresh не обнуляет. Забытый End даёт alert после планового конца, не выдумывает actual end. Supervisor correction требует причины. Approve Report не проводит финансовые операции.
- КАРТИНКИ НА ЭКРАНЕ: Account avatar 40×40, evidence thumbnails до 4×64×64 только по разрешению.

### S44. Handover Desk — `/ofm/handovers`

- ЗАЧЕМ: Передать незавершённые дела без потери контекста.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: From Shift, To Shift/member, Summary*, open tasks, due follow-ups, incidents, promised deliverables, priority, acknowledgement time.
- КНОПКИ И РЕЗУЛЬТАТ: Submit; Acknowledge; Assign Recipient; Convert Item to Task; Resolve Item.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Задача связывается ID, не копируется при каждой передаче. При отсутствии следующей смены получатель — supervisor. Acknowledge не помечает все вопросы решёнными.
- КАРТИНКИ НА ЭКРАНЕ: Avatars отправителя и получателя 28×28; остальных растров 0.

### S45. OFM Contacts — `/ofm/contacts`

- ЗАЧЕМ: Вести минимальные рабочие связи с клиентами площадок.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Platform Account, External Identifier, Alias, Assigned Manager, Stage, Last Activity, Next Follow-up, confirmed spend при разрешении; restricted search.
- КНОПКИ И РЕЗУЛЬТАТ: Add Contact; Open S46; Assign; Add Follow-up; Merge Preview; restrict/export только по отдельным правам.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Уникальность account+external identifier; один pseudonym на разных аккаунтах не означает одного человека. Нельзя хранить пароли, карты и произвольные интимные профили клиентов.
- КАРТИНКИ НА ЭКРАНЕ: По умолчанию 0 растров; aliases/initials создаются кодом.

### S46. Contact Workspace — `/ofm/contacts/:id`

- ЗАЧЕМ: Зафиксировать задачи и подтверждённые операции контакта.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Alias*, External Identifier*, Account*, Manager, Stage, business notes, interactions, requests, follow-ups, linked financial references, activity.
- КНОПКИ И РЕЗУЛЬТАТ: Log Interaction; Create Follow-up; Register Request; Change Stage; Link Sale Candidate; Archive; Request Erasure с правом.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Это журнал ручных записей, не inbox площадки. Stage не вычисляет психологические оценки. Erasure удаляет личные заметки, сохраняя обезличенные необходимые финансовые связи по политике хранения.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0 по умолчанию; evidence только по клику и праву.

### S47. Operations Queue — `/ofm/operations`

- ЗАЧЕМ: Выполнить запросы, follow-ups и операционные поручения.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Type*, Account*, Contact optional, Owner*, Due, Priority, Status, linked shift/task, promised deliverable, outcome, evidence.
- КНОПКИ И РЕЗУЛЬТАТ: Create; Assign; Start; Complete с Outcome*; Cancel с Reason; Link Content; Register Sale Candidate.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Запрос на контент создаёт связанный draft после проверки прав. Complete не означает оплаты. Повтор кандидата продажи по source transaction ID выявляется до проведения.
- КАРТИНКИ НА ЭКРАНЕ: Thumbnail результата 48×48 только при разрешении; остальной список без изображений.

### S48. Quality Reviews — `/ofm/quality`

- ЗАЧЕМ: Давать проверяемую обратную связь по работе.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Shift/Operation*, Reviewer*, Rubric Version*, критерии 0–4 или Not Applicable, factual notes, evidence, improvements, employee response.
- КНОПКИ И РЕЗУЛЬТАТ: Draft Review; Publish Review; Create Improvement Task; Acknowledge; Dispute с текстом; Resolve Dispute.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нельзя оценить невидимую внешнюю переписку без предоставленного evidence. Score — результат rubric, не абсолютная оценка человека. Опубликованная оценка исправляется revision с историей.
- КАРТИНКИ НА ЭКРАНЕ: Reviewer/member avatars 28×28; evidence thumbnails скрыты до открытия.

### S49. Metrics Inbox — `/metrics`

- ЗАЧЕМ: Увидеть, какие данные пора внести или проверить.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Due/Overdue/Submitted/Needs Review; Entity, Checkpoint, Expected At, Observed At, Reporter, Source, Completeness.
- КНОПКИ И РЕЗУЛЬТАТ: Add Metrics → S50; Bulk Entry; Import → S66; Mark Unavailable с Reason; Review Correction.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Mark Unavailable закрывает запрос как Missing, не создаёт нулевые значения. Поздний замер сохраняет реальное время наблюдения.
- КАРТИНКИ НА ЭКРАНЕ: Account avatar 28×28 или publication thumbnail 40×40 на строку.

### S50. Metric Entry / Revision — `/metrics/new`, `/metrics/:id`

- ЗАЧЕМ: Сохранить одну согласованную группу показателей.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Entity*, Observation Type*, Observed At*, Period Start/End при period, Platform Timezone, Definition Set*, available metric values, Source Type*, Source Note*, Evidence optional.
- КНОПКИ И РЕЗУЛЬТАТ: Validate; Save; Submit Correction; Approve Correction; View Revision History; Open Source Entity.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: null допускается для неизвестного; integers ≥0 для счётчиков, единицы фиксированы. Нельзя суммировать cumulative snapshots. Снижение cumulative допускается с warning/source correction reason.
- КАРТИНКИ НА ЭКРАНЕ: До 5 evidence previews 96×64, увеличиваются по клику; графиков-изображений 0.

### S51. Analytics — `/analytics`

- ЗАЧЕМ: Изучать результаты компании, производства и аккаунтов.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Tabs Production, Accounts, Content, OFM, Team, Finance; Period, Compare, Scope, Platform, Format; KPIs, chart, source table, data freshness/coverage.
- КНОПКИ И РЕЗУЛЬТАТ: Drill Down; Change Metric; Save Report; Export; Open Definition; compare equal windows.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Unknown gaps, no interpolation по умолчанию; нет общей суммы охвата как уникальных людей. Финансовые и OFM datasets требуют дополнительных прав.
- КАРТИНКИ НА ЭКРАНЕ: Только thumbnails в content table 40×40; все графики — программные.

### S52. Report Builder — `/reports/new`, `/reports/:id`

- ЗАЧЕМ: Сохранить повторяемый отчёт.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name*, Dataset*, dimensions, metrics, filters, grouping, chart type, sorting, date policy, access scope; live preview с limit.
- КНОПКИ И РЕЗУЛЬТАТ: Preview; Save; Duplicate; Share Internally; Schedule Inbox Snapshot; Export.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Только разрешённые комбинации из semantic layer; arbitrary SQL/JS не допускаются. Shared report не даёт получателю прав на исходные данные. Сохранённый snapshot имеет as-of timestamp.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; chart не статический screenshot.

### S53. Goals — `/goals`

- ЗАЧЕМ: Связать плановые результаты с измеримыми данными.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name*, Owner*, Scope*, Metric*, Target*, Unit*, Period*, Baseline optional, direction Increase/Decrease, linked campaigns, progress, source completeness.
- КНОПКИ И РЕЗУЛЬТАТ: Create; Edit Future Target; Check In; Open Sources; Close with Assessment; Archive.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Изменение target в начавшемся периоде создаёт revision. Progress не ограничивать визуально ложными 100%; сверхцель подписывать. Нет источников → Not Measured.
- КАРТИНКИ НА ЭКРАНЕ: Owner avatar 24×24; других растров 0.

### S54. Export Center — `/exports`

- ЗАЧЕМ: Безопасно получить подготовленные отчёты и пакеты.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Format CSV/XLSX/PDF/ZIP, fields, filters, data classification, requested by, state, created/expiry, size; warning о выбранных private fields.
- КНОПКИ И РЕЗУЛЬТАТ: Preview Fields; Request Export; Download; Cancel Queued; Delete File; Retry Failed.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Права проверяются при запросе, генерации и выдаче. Готовый export не становится публичным. Отозванный доступ делает ранее созданный export недоступным.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; PDF preview по запросу отдельным viewer.

### S55. Finance Overview / Ledger — `/finance`

- ЗАЧЕМ: Увидеть управленческие результаты и операции.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Accrual/Cash tabs, Period, Currency, Project; Recognized Revenue, Expenses, Operating Result, Receivables/Payables; ledger rows Status, Type, Date, Amount, Allocation, Source.
- КНОПКИ И РЕЗУЛЬТАТ: Add Entry → S56; Reconcile Settlement → S60; Open Budget; Export; Close Period.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Accrual и Cash не складываются. Draft отдельно и не входит в totals. Incomplete cost coverage обозначается. Недоступные суммы не приходят в response.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S56. Financial Entry — `/finance/entries/:id`, `/finance/entries/new`

- ЗАЧЕМ: Зарегистрировать доход, расход или корректировку.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Type*, Amount*, Currency*, Recognition Date*, Category*, Project/Allocation*, Counterparty, Source Transaction ID, Account, Campaign, Shift reference, Evidence, Note; component breakdown при platform statement.
- КНОПКИ И РЕЗУЛЬТАТ: Save Draft; Submit; Post; Reject с Reason; Reverse с Reason; Add Settlement; View Links.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Posted immutable; correction через reversal/replacement. Уникальность source namespace+external ID. Document может содержать несколько компонентов с суммой, но не второй дублирующий total income.
- КАРТИНКИ НА ЭКРАНЕ: До 3 receipts previews 72×96; доступ только finance/evidence viewers.

### S57. Budgets — `/finance/budgets`

- ЗАЧЕМ: Планировать и контролировать расходы.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Scope*, Period*, Currency*, category lines, Planned, Committed, Actual, Remaining, owner, version.
- КНОПКИ И РЕЗУЛЬТАТ: New Budget; Submit; Approve Version; Revise; Open Related Entries; Set Alert Threshold.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Committed исключает уже переведённые в Actual обязательства. Budget revision не меняет фактические затраты. Порог alert не блокирует реальный учёт расхода.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S58. Compensation Rules — `/finance/compensation/rules`

- ЗАЧЕМ: Определить воспроизводимый расчёт вознаграждений.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Member/Role Scope*, Effective From*, Effective To, Type Fixed/Hourly/Per Approved Unit/Revenue Share, Rate*, Currency/Base Metric*, eligible projects, refund policy, stacking rules.
- КНОПКИ И РЕЗУЛЬТАТ: Create Version; Simulate on Period; Approve Rule; End Rule; View Affected Runs.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Пересекающиеся несовместимые rules блокируются. Симуляция ничего не начисляет. Процент без выбранной базы и источника не сохраняется.
- КАРТИНКИ НА ЭКРАНЕ: Member avatar 28×28; прочих растров 0.

### S59. Compensation Runs — `/finance/compensation/runs/:id`

- ЗАЧЕМ: Рассчитать, проверить и утвердить начисления за период.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Period*, Participants*, Rule Versions, source lines, exclusions, adjustments, totals by currency, approval, payout balance.
- КНОПКИ И РЕЗУЛЬТАТ: Calculate Draft; Recalculate with Diff; Submit; Approve; Register Payment; Export Statement; Reverse Adjustment.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Approved snapshot immutable. Один источник/получатель/rule entitlement нельзя начислить дважды. Pay button записывает факт, не вызывает банковский API.
- КАРТИНКИ НА ЭКРАНЕ: Avatars 24×24; платёжные документы только по открытию.

### S60. Settlements / Reconciliation — `/finance/settlements`

- ЗАЧЕМ: Связать денежные поступления и оплаты с начисленными операциями.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Direction In/Out*, Amount*, Currency*, Paid At*, Payment Reference, Counterparty, allocation lines to entries/compensation, unmatched balance, evidence.
- КНОПКИ И РЕЗУЛЬТАТ: Register Settlement; Match; Split Allocation; Confirm; Reverse; Open Unmatched.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Частичная оплата разрешена; превышение outstanding требует отдельной advance/unallocated записи. Settlement не создаёт повторный revenue/expense. Разные валюты требуют явных обеих сумм и курса.
- КАРТИНКИ НА ЭКРАНЕ: До 3 evidence previews 72×96; декоративных растров 0.

### S61. Team — `/team`

- ЗАЧЕМ: Управлять составом команды.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name, Email, Membership Status, Role, Responsibilities, Manager, Directions, Assigned Projects, Workload; Invitations tab.
- КНОПКИ И РЕЗУЛЬТАТ: Invite; Resend/Revoke Invitation; Open Member; Bulk Assign Direction; Export permitted roster.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Секреты MFA и personal compensation не видны в roster. Invitation delivery имеет отдельный статус от accepted.
- КАРТИНКИ НА ЭКРАНЕ: Avatar 32×32 на строку.

### S62. Member Workspace — `/team/:memberId`

- ЗАЧЕМ: Настроить ответственность и рабочие условия сотрудника.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Profile, Manager, Roles/Scopes, Skills, Capacity, Work Schedule, Leave, Tasks, Assignments, Activity; compensation tab отдельно ограничен.
- КНОПКИ И РЕЗУЛЬТАТ: Assign Project; Edit Capacity; Add Leave; Transfer Work; Suspend; Deactivate Preview; Restore; Revoke Sessions.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нельзя убрать последнего активного Owner. Смена manager не меняет исторического автора. Leave подсвечивает смены и deadlines, не отменяет их молча.
- КАРТИНКИ НА ЭКРАНЕ: 1 profile photo 64×64; остальных растров 0.

### S63. Roles and Access — `/settings/access`

- ЗАЧЕМ: Проверить и настроить действительные права.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Roles, permission matrix, scope rules, explicit grants, restricted data flags, effective access preview для member+object.
- КНОПКИ И РЕЗУЛЬТАТ: Create Custom Role; Clone Role; Edit Permissions; Preview Impact; Apply; Transfer Ownership отдельным подтверждённым flow.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Permission changes требуют recent MFA, audit и invalidation активных permissions cache. Администратор не может выдать себе права, которыми не вправе управлять.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S64. Automations — `/automations`

- ЗАЧЕМ: Управлять правилами внутренних действий.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name, Trigger, Scope, Enabled, Last Run, Failures, Owner; templates с реальными действиями.
- КНОПКИ И РЕЗУЛЬТАТ: New Rule; Open S65; Enable/Disable; View Runs; Duplicate Disabled.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Disable отменяет ещё не начатые future runs, завершённые действия не удаляет. Rule без owner получает Needs Owner и приостанавливается.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S65. Automation Editor / Runs — `/automations/:id`

- ЗАЧЕМ: Описать, проверить и отладить правило.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name*, Trigger*, Conditions, Actions*, Scope*, Owner*, quiet hours policy, version; Dry Run preview; run timeline с event IDs и ошибками.
- КНОПКИ И РЕЗУЛЬТАТ: Validate; Dry Run; Save Disabled; Enable; Retry Failed Run с прежним operation key; Open Created Object.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нет произвольного JS, SQL и webhook URL. Dry Run не отправляет сообщения и не создаёт записи. Cyclic triggers ограничиваются causation chain и глубиной.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; схема conditions/actions строится кодом.

### S66. Import Center — `/imports`

- ЗАЧЕМ: Загрузить данные без порчи текущей базы.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Dataset*, File*, template version, mapping, timezone/currency, errors, warnings, duplicate strategy, preview rows, impact summary, job state.
- КНОПКИ И РЕЗУЛЬТАТ: Download Template; Upload; Validate; Preview; Confirm Import; Download Errors; Cancel; Open Result.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: До Confirm доменные данные не меняются. Commit привязан к hash validated file и target revisions. При новых конфликтах нужен повторный preview. Import не выдаёт роли и не проводит финансы автоматически.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S67. Workspace Settings — `/settings/workspace`

- ЗАЧЕМ: Настроить общие рабочие правила.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Name, Logo, Timezone, Currency, Week Start, working days, metric cadences, file quota, retention, MFA policy, module visibility, SMTP status.
- КНОПКИ И РЕЗУЛЬТАТ: Save with Impact Preview; Test Mail to Self; Open Backup Status; Manage Directions; Restore Defaults для конкретной группы.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Изменение timezone не переписывает timestamps. Снижение quota не удаляет файлы. SMTP secrets вводятся masked write-only и не возвращаются после save.
- КАРТИНКИ НА ЭКРАНЕ: 1 logo 64×64; остальных растров 0.

### S68. Personal Settings / Security — `/settings/profile`

- ЗАЧЕМ: Настроить личный интерфейс и доступ.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Display Name, Avatar, Timezone, Theme System/Light/Dark, Density, notification preferences, quiet hours, password, MFA, active sessions.
- КНОПКИ И РЕЗУЛЬТАТ: Save; Change Password; Regenerate Recovery Codes; Sign Out Session; Sign Out Other Sessions.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Email change через подтверждение нового адреса и recent authentication. Нельзя отключить MFA, если role policy требует её. Сессии других пользователей не доступны.
- КАРТИНКИ НА ЭКРАНЕ: 1 avatar preview 80×80.

### S69. Audit Log — `/settings/audit`

- ЗАЧЕМ: Восстановить историю важных изменений.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Actor, Action, Entity, Timestamp, Request ID, field diff с masking, reason, source UI/Import/Automation/System; filters and event detail.
- КНОПКИ И РЕЗУЛЬТАТ: Open Related Object; Export Permitted Events; Copy Event ID.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Нет Edit/Delete события. Просмотр audit не даёт права на все поля исходного объекта. Secrets и тела чувствительных сообщений не логируются.
- КАРТИНКИ НА ЭКРАНЕ: Actor avatar 24×24, прочих растров 0.

### S70. Archive / Trash — `/archive`

- ЗАЧЕМ: Найти завершённые и недавно удалённые записи.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Archived/Trash tabs, type, title, archived/deleted by, date, purge date, dependencies, historical links.
- КНОПКИ И РЕЗУЛЬТАТ: Restore Preview; Restore; Open Read Only; Permanently Delete только eligible drafts и Owner с recent MFA.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Posted finance, audit и использованные historical versions не удаляются этим экраном. Restore конфликтующего handle требует выбора. Bulk purge требует typed confirmation и preview.
- КАРТИНКИ НА ЭКРАНЕ: Thumbnail 32×32 только при сохранённых правах.

### S71. Incidents / System Health — `/operations/health`

- ЗАЧЕМ: Разделить рабочие инциденты и технические сбои.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Operational Incidents: account/project, severity, owner, description, status. System tab для Admin: job failures, mail delivery, storage, backup freshness, restore test result.
- КНОПКИ И РЕЗУЛЬТАТ: Log Incident; Assign; Resolve with Outcome; Retry Failed Job; Acknowledge Alert; Open Runbook.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Зелёный Backup Healthy возможен только при подтверждённом успешном job и сроке свежести; Restore Tested отдельно. Пользовательские инциденты не меняют техническое здоровье сервера.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0; evidence по открытию.

### S72. Templates / Custom Fields — `/settings/templates`

- ЗАЧЕМ: Настроить повторяемые процессы без программирования.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Task/Content/Checklist/Quality Rubric templates; versions, relative dates, default roles; Custom Field: Name*, Key*, Type*, Scope*, Required At Stage, Options.
- КНОПКИ И РЕЗУЛЬТАТ: New Template; New Version; Preview Application; Publish; Disable; Add Field; Archive Field.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Пользовательские поля не заменяют канонические суммы, statuses и permissions. Удаление option сохраняет historical label. Published template version immutable; применение создаёт run с source version.
- КАРТИНКИ НА ЭКРАНЕ: Растров 0.

### S73. Partners — `/partners`

- ЗАЧЕМ: Вести рабочие связи по сотрудничествам инфлюенсеров и проектов.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Organization/Person, Name*, Contact Name, Business Email, Website, Owner*, tags, active deals, last interaction; доступные заметки.
- КНОПКИ И РЕЗУЛЬТАТ: Add; Edit; Log Interaction; New Deal; Archive; Merge Preview.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Email — поле учёта; CRM не отправляет партнёру письмо автоматически. Partners отделены от OFM Contacts и их чувствительных данных.
- КАРТИНКИ НА ЭКРАНЕ: Загруженный logo 32×32, при отсутствии initials; автозагрузка логотипов выключена.

### S74. Partnership Deal — `/deals/:id`, `/deals/new`

- ЗАЧЕМ: Довести сотрудничество от предложения до сдачи работ и оплаты.
- ЧТО ПОКАЗЫВАЕТ / ПОЛЯ: Title*, Partner*, Owner*, Projects*, Stage, Amount/Currency optional, deliverables, due dates, campaign, documents, payment schedule, activity.
- КНОПКИ И РЕЗУЛЬТАТ: Save; Move Stage; Create Campaign; Generate Deliverable Tasks; Mark Won/Lost with Reason; Register Income Draft; Close Fulfilled.
- ЛОГИКА, ПРОВЕРКИ, СОСТОЯНИЯ: Won не равно Paid и не проводит revenue без подтверждённых условий. Deal amount является планом до финансовой записи. Подписание документов и внешняя рассылка не имитируются.
- КАРТИНКИ НА ЭКРАНЕ: Partner logo 40×40, deliverable thumbnails до 4×80×100; документов preview по запросу.

## 6. IMAGES ON THIS SCREEN: ассеты и медиа

TOTAL UNIQUE GENERATED RASTER ASSETS: 0. Для этой веб-CRM не требуется генерация художественных фоновых изображений. Не создавать несуществующие модели, фотографии команды и успешные графики для production-интерфейса. Премиальность достигается работой с типографикой, пространством, таблицами и настоящими материалами команды.

| ID | Файл | Содержание | Формат/размер | Использование |
|---|---|---|---|---|
| V01 | castlane-mark.svg | Оригинальный геометрический знак из двух смещённых рамок; без чужого логотипа | viewBox 0 0 32 32, прозрачный | 1 знак 28×28 в sidebar; 1 знак на auth |
| V02 | castlane-wordmark.svg | Название Castlane, доступный текстовый equivalent | viewBox 0 0 160 32, прозрачный | Auth 120×24; setup 160×32 |
| V03 | favicon.svg | Упрощённый V01 | 32×32 vector | Browser tab |
| V04 | apple-touch-icon.png | Программный экспорт V01 на surface | 180×180, непрозрачный | Shortcut icon, не ImageGen |
| V05 | app-icon-192.png | Программный экспорт V01 | 192×192, непрозрачный | Manifest icon |
| V06 | app-icon-512.png | Программный экспорт V01 | 512×512, непрозрачный | Manifest icon |

Три PNG выше являются техническими экспортами вектора, не уникальными художественными растровыми ассетами. UI icons — единый набор @phosphor-icons/react, normal weight, размеры 16/18/20/24. До добавления зависимости проверить package.json и закрепить версию.

Пользовательские avatar source: JPG/PNG/WebP, до 10 MB, до 4096×4096; производные 64, 128, 256 px. Project cover: до 20 MB, до 12000×12000 с проверкой decoded pixel count; derivatives 320×180, 640×360 и 1280×720. Контентные изображения: до 50 MB, лимит 100 megapixels; оригиналы не пережимаются молча. Thumbnail display size и размер файла всегда различаются.

Video: MP4/MOV/WebM до 5 GB на файл, resume multipart; preview после проверки и обработки, browser-compatible rendition 720p или 1080p по исходнику. Audio: MP3/WAV/M4A до 500 MB. Documents: PDF до 100 MB; DOCX/XLSX до 50 MB как download-only до безопасного preview pipeline. Project archives ZIP до 2 GB хранятся как файл без автоматической распаковки пользовательского содержимого. SVG uploads не отображаются inline, только безопасно преобразованная производная после проверки. Для неподдерживаемого preview — File Preview Unavailable и разрешённый Download.

Контент, обозначенный Restricted Media, по умолчанию показан нейтральной заглушкой; reveal требует соответствующего permission и явного действия. Прятать такой контент и в списках, export previews, search и email. Это правило видимости, а не автоматическое распознавание содержимого. Графики, подписи, статусы, даты, counters и QR создаются кодом.
