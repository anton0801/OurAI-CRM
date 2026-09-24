# Castlane CRM — Specification part 1: colour palette & design system (sections 3–4)

## 3. Color palette

Один основной акцент — приглушённый emerald. Семантические цвета статусов допускаются отдельно от акцента. Не использовать цвет как единственный носитель смысла.

| Token | Light | Dark | Назначение |
|---|---|---|---|
| canvas | #F5F7F6 | #111715 | Фон рабочей области |
| surface | #FFFFFF | #18211D | Панели, таблицы, формы |
| surface-secondary | #EEF2EF | #202C26 | Hover, вторичные области |
| sidebar | #EDF2EE | #131C17 | Навигация |
| text-primary | #17251D | #EEF4F0 | Основной текст |
| text-secondary | #526458 | #ADBCB2 | Подписи |
| text-muted | #68766E | #93A399 | Вспомогательный текст, проверять контраст |
| border | #D9E2DC | #34453B | Разделители, границы |
| primary | #176B50 | #7ECBA8 | Основные действия |
| on-primary | #FFFFFF | #11251B | Текст основной кнопки |
| primary-hover | #12543E | #98DBBB | Hover основной кнопки |
| selection | #E0F1E8 | #244236 | Выделенная строка |
| danger-text | #A52B37 | #FFADB5 | Ошибка/опасное действие |
| danger-bg | #FCECEF | #42272C | Фон ошибки |
| warning-text | #875312 | #EAC17D | Просрочка/предупреждение |
| warning-bg | #FFF2DA | #3B3224 | Фон предупреждения |
| info-text | #315E87 | #A5C6E9 | Информационное состояние |
| info-bg | #EAF2F9 | #253442 | Фон информации |

Success использует primary и selection плюс иконку/текст. Серии графиков: emerald, blue, amber, muted rose, slate; максимум пять одновременно. Остальные группируются в Other только при корректной агрегации. Значения всегда доступны в таблице.

(Implementation note: exact chart series steps were validated for lightness band, chroma, colour-vision-deficiency separation and contrast; see `packages/ui/src/tokens.css`.)

## 4. Visual language и дизайн-система

### 4.1. Направление
Профессиональная контентная студия: аккуратный интерфейс с выразительными превью работ, плотными таблицами, спокойными поверхностями и короткими анимациями действий. Не превращать рабочие экраны в лендинг. Нет декоративного hero, бесконечно движущихся графиков, fake live counters, неонового свечения, фоновых видео, автоматически переставляющихся задач и повторяющихся 3D-персонажей. Главный визуальный объект — реальный контент команды.

### 4.2. Размеры и сетка
Все размеры ниже — CSS px. Основной контрольный viewport 1440×900; дополнительные 1280×800, 1024×768, 768×1024 и 390×844. Минимальная поддерживаемая ширина 360 px.

Desktop shell: sidebar 232 px, collapsed 72 px; topbar 64 px; рабочая область занимает оставшуюся ширину. Горизонтальные внутренние поля 28 px, вертикальные 24 px. Внутренний контент максимум 1600 px, центрируется на широком мониторе. На 1440 px sidebar начинается x=0, main x=232, контент x=260, правое поле 28 px; основной контент имеет ширину 1152 px. Страница прокручивается в main, sidebar и topbar остаются на месте.

Page header: breadcrumb 12/18 px, отступ до title 8 px; title 28/36, weight 650; описание 14/22 с максимумом 760 px. Справа максимум две основные кнопки и More. Между header и tabs 20 px; tabs высота 44 px; между tabs и toolbar 16 px. Toolbar min-height 40 px, затем 16 px до таблицы. Длинные заголовки переносятся; кнопки не сжимаются до нечитаемости.

Spacing tokens: 4, 8, 12, 16, 20, 24, 28, 32, 40, 48. Radius: 6 для badges, 8 для inputs/buttons, 12 для panels/drawers, 16 для dialogs. Основные таблицы имеют один внешний border; не оборачивать каждую строку в card.

### 4.3. Typography
UI: Geist Sans с локальными лицензированными файлами и system sans fallback; цифры и финансовые таблицы — Geist Mono, tabular-nums. Проверить наличие кириллицы, обеспечить fallback для русскоязычного контента. Page title 28/36; section title 18/26; body 14/22; table 13/20; label 12/18 weight 550; KPI 28/36; microcopy не меньше 12/18. Редактор текста 15/24. Не использовать display-serif и oversized marketing typography.

### 4.4. Shell и навигация
Sidebar: сверху workspace name и раскрываемый selector; затем Overview, My Work, Inbox. Группа Production: Projects, Accounts, Content, Calendar, References, Library. Группа Operations: OFM, Campaigns, Team. Группа Insights: Analytics, Finance, Knowledge. Снизу Settings, Help и профиль. Недоступные разделы скрыты; отображаемые записи фильтруются сервером. Группы можно свернуть; настройки личные.

Topbar: breadcrumbs слева; Global Search с подсказкой Cmd/Ctrl+K, Quick Create, уведомления и avatar справа. Quick Create содержит только разрешённые действия. Кнопка не создаёт запись до заполнения формы. Profile menu: Personal Settings, Sessions, Sign Out. Нет счетчика непрочитанного, основанного на данных других пользователей.

(Implementation decision, see ADR 0006: Tasks, Partners, Metrics and Goals are also listed in the sidebar because their screens S27, S73, S49, S53 are primary work surfaces.)

### 4.5. Компоненты

| Компонент | Точная спецификация |
|---|---|
| Primary Button | Высота 36 desktop/44 touch, padding 14, font 13/20 weight 600, gap icon-text 8. Loading сохраняет ширину и блокирует повтор. |
| Secondary Button | Surface, border 1, text-primary; те же размеры. Destructive — danger текст, подтверждение по последствиям. |
| Icon Button | 32×32 desktop, зона нажатия 44×44 touch, icon 18, accessible name, tooltip с клавиатурным доступом. |
| Input | Высота 40, padding 12, label сверху, gap 6, helper/error снизу 6, border 1; focus ring 2 + offset 2. |
| Textarea | Min-height 104, resize vertical, счётчик только при приближении к лимиту. |
| Select | Поиск при числе вариантов >8; максимум popup 320 px; Enter выбирает, Esc закрывает, выбор не уходит за экран. |
| Badge | Высота 22, padding 8, статус текстом; один основной статус и независимые флаги рядом. |
| Avatar | 28 в строке, 36 в списке, 64 в профиле; фото либо инициалы на детерминированном фоне. |
| Data Table | Header 40, row 48 comfortable/36 compact; checkbox 36-column; left text/right numbers; min-width колонок и horizontal scroll только внутри таблицы. |
| Kanban | Column 296, gap 16; card padding 12, title до 3 строк, metadata до 2 строк; virtualized при больших списках. |
| Drawer | 560 px или 760 px для контента, height 100dvh, sticky header 64/footer 72; внутренний scroll; на телефоне full-screen. |
| Dialog | Small 440, regular 640, wide 960, max-height calc(100dvh - 48px); focus trap, возврат фокуса инициатору. |
| Toast | Нижний правый угол, max-width 360, до 3 одновременно; success 5 s, ошибка с действием не исчезает сама. |
| Skeleton | Повторяет геометрию конечного блока, не показывает ложные значения и fake avatars. |
| Date Picker | Calendar + ввод; видимая timezone; отдельное различение date-only и datetime. |
| Amount Input | Decimal string, выбранная валюта, локализованное отображение; без float-арифметики. |
| Media Preview | object-fit contain по умолчанию; cover только для thumbnail с явным открытием оригинала. |

### 4.6. Общие взаимодействия
Сохранение формы: validate → pending → подтверждённый сервером результат → success. Ошибка оставляет введённые значения. Не закрывай drawer до подтверждённого save. Cancel с изменениями открывает Discard Changes / Keep Editing. Autosave используется только для редактируемых черновиков текста, debounce 1000 ms; отображаются Saving, Saved, Save Failed. Финансы, согласования, права и публикации требуют явного действия.

Deep links открывают объект напрямую. Drawer поддерживает URL и Back; при прямом входе объект открывается как полноэкранная карточка. Фильтры, sort, active tab и выбранный period сохраняются в URL; личная ширина колонок — в пользовательских preferences. Секретные поисковые строки контактов не записывать в analytics и access logs.

Bulk selection различает Select Visible и Select All Matching с итоговым числом. Перед массовой операцией preview доступных, недоступных и конфликтующих записей. Финансовые массовые операции атомарны в выбранном утверждённом batch; обычные задачи допускают per-item результат с возможностью повторить только failures.

Motion: hover/focus 120 ms, drawer 180 ms, modal 160 ms; transform/opacity, без анимации положения страницы и счётчиков финансов. prefers-reduced-motion отключает slide и layout motion. После изменения сортировки по инициативе пользователя допустим короткий переход; фоновые события не переставляют редактируемую строку.

### 4.7. Состояния для каждого экрана
Обязательны Initial Loading, Empty Workspace, No Filter Results, Partial Data, Permission Denied, Not Found, Network Error, Saving, Validation Error, Conflict и Success по применимости. Empty state имеет конкретный CTA при наличии прав; иначе Explain Access. No Filter Results предлагает Clear Filters. 403 не раскрывает существование чужого объекта: объектный запрос вне scope возвращает 404; доступ к известному модулю без права — 403.

При потере сети верхняя полоса Offline — changes are not being saved. Введённые значения сохраняются в памяти открытой вкладки, не выдаются за сохранённые. Финансовые и OFM-чувствительные формы не кешировать в localStorage. После восстановления сети явный Retry с прежним idempotency key. В случае истечения сессии повторный вход с возвращением к маршруту; чувствительный черновик не переживает logout.
