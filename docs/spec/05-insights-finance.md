# Castlane CRM — Specification part 5: dashboards, goals, reports & finance (sections 17–18)

Verbatim from the owner specification v1.0. Section numbers match the original.

## 17. Dashboards, цели и отчёты

Overview layout на desktop: KPI strip из четырёх безрамочных ячеек, ниже grid 8/4 columns. Слева trend высотой 260, справа actionable list высотой 260 с собственным scroll; ниже project table на всю ширину. Число и состав модулей зависят от прав, пустые finance места не сохраняются. Руководитель видит scoped Overview, сотрудник открывает My Work по умолчанию.

Production Dashboard: M01–M10, breakdown by project/type/assignee, stage aging, overdue reasons. Account Dashboard: M11–M13, M22, publication cadence и freshness. Content Dashboard: M14–M21, reference tags/hook/format, checkpoint comparison. OFM Dashboard: approved shifts, pending reports, M24–M31, verified vs pending sources. Team Dashboard: delivery/review/approved time/capacity, без смешивания разных профессий в один score. Finance Dashboard: M33–M39/M41/M42, missing allocations и cash/accrual distinction.

Charts: line для time series, bar для category comparison, stacked bar для аддитивного composition, scatter только с понятными осями. Donut максимум 5 категорий, не обязателен. Оси с unit и non-misleading scale, tooltip date/value/source age/sample. Missing point — gap; 0 рисуется только если Known 0. Mouse/keyboard focus показывает tooltip; table alternative обязательна. Для 1 datapoint показывать значение и No Trend Yet, не выдумывать линию.

SavedReport configuration versioned. Пользователь выбирает dataset, до 3 dimensions, до 8 metrics, time grain, filters, sort и chart. Разрешённый join graph предотвращает multiplication rows: например task join с несколькими comments не увеличивает time sum. Report engine сначала агрегирует facts до grain, затем связывает dimensions. Фильтр по проекту обязателен в shared restricted datasets. Saved report is query, Snapshot is immutable rendered result с source bounds.

Scheduled report: Daily/Weekly/Monthly; результат внутри Inbox для выбранных внутренних участников. Каждый recipient получает свой permission-filtered результат. Не отправлять один broad snapshot всем. При отключённом owner schedule Paused Needs Owner. Email — только минимальное уведомление о готовности, если enabled; sensitive attachment не отправляется.

Goals: target type Absolute/Increase By/Decrease To; metric unit фиксирован. Progress для Increase By=(current−baseline)/target_delta; для Absolute=current/target; для Decrease To=(baseline−current)/(baseline−target). Denominator 0 → Not Defined. Baseline обязателен для двух последних относительных смыслов. Current берётся из canonical metric, manual goal check-in помечен Manual. Закрытие цели сохраняет achieved value и completeness, не меняет фактические метрики.

## 18. Финансы, бюджеты, начисления и выплаты

### 18.1. Два независимых временных представления

Accrual — признанные доходы и расходы по recognition_date. Cash — подтверждённые поступления/оплаты по paid_at. FinancialEntry фиксирует экономический факт, Settlement — денежное движение, Allocation — связь. Это управленческий учёт, а не обещание автоматической сдачи регламентированной отчётности.

Entry statuses: Draft → Submitted → Posted либо Rejected → Draft. Posted неизменяем, аннулируется Reverse и replacement entry. Post проверяет права, closed period, currency, duplicate source, allocation sums и attachments policy. Actor не может подтвердить собственный Submitted при maker-checker policy. Для Owner допускается single-owner exception с reason и audit, если нет второго finance approver; UI не скрывает self-approval.

### 18.2. Категории и база сумм

Revenue categories: Subscriptions, Renewals, Content Sales, Tips, Sponsorship, Licensing, Other. Contra-revenue: Refund, Chargeback. Fee categories: Platform Fee, Payment Processing Fee. Operating expenses: Production Services, AI Tools, Editing, Voice, Advertising, Contractors, Compensation, Software, Storage, Other. Справочник можно расширять, но accounting class фиксирован и versioned.

Platform statement entry может содержать gross 1000, refund 100, fee 180. В ledger это три typed lines одного документа, Net Revenue=720. Если источник даёт только net 720, выбрать Net Only; сохранить net-revenue line с components_unknown=true. Не придумывать gross и fee. Gross report исключает unknown gross и показывает incomplete coverage; Net report может использовать verified net. Нельзя одновременно учитывать Net Only и расшифрованные строки того же source period/transactions без reversal/reconciliation.

Для statement, состоящего из individual transactions, header total является контрольной суммой, не дополнительной revenue line. Full snapshot import сверяется с IDs; разница требует resolution. Fee в Net Revenue нельзя повторно вычесть как Operating Expense.

### 18.3. Валюты и распределение

Base currency устанавливается при setup и блокируется после первой Posted записи; смена — отдельный управляемый migration project, не обычный dropdown. Operation хранит original amount/currency, frozen FX rate, base equivalent, rate date/source. Источник курса в этой версии — ручной ввод уполномоченным finance user или CSV таблица курсов с source note. Автоматический валютный API не подключён.

Rounding: по minor units валюты (0/2/3), decimal half-even для line conversion; разница распределения отдаётся строкам методом largest remainder с deterministic tie by ID. Сумма allocated minor units точно равна source amount. Для base currency rate=1. Нет курса → сохранить Draft, но Post cross-currency blocked. Non-convertible сводка показывает отдельные currencies, не ложный общий total.

Allocation поддерживает Project и optional Campaign/Content. Один amount распределяется либо exact amounts, либо percentages суммой 100. Остаток допустим только явной Unallocated строкой; отчёт project profitability помечается Incomplete Cost Allocation. Shared tool subscription можно распределить equal/custom weights, rule snapshot сохраняется. Transfer allocation после закрытия периода — adjustment, не новая копия расхода.

### 18.4. Settlements и сверка

Settlement states: Draft → Confirmed → Reversed. Confirmed incoming/outgoing не меняет revenue/expense, только outstanding и cash view. Allocation может покрывать часть одного документа или несколько. Равный platform payout 720 закрывает receivable 720, не создаёт второй income 720.

Settlement больше outstanding: сохранить unallocated advance/remainder с описанием, не делать balance отрицательным скрытно. Разные currencies: document amount settled и cash amount указываются отдельно, effective settlement FX и realized difference отдельной adjustment line. Разница не маскируется округлением. Reverse allocation восстанавливает outstanding, оригинальный settlement остаётся в истории.

Payment Reference уникален в namespace payment source при наличии. При отсутствии external ID система создаёт manual reference и показывает duplicate warning по same counterparty/amount/currency/date; пользователь подтверждает отличающуюся операцию с причиной. Это heuristic warning, не ложное доказательство дубликата.

### 18.5. Бюджеты и обязательства

Budget состоит из scope, period, currency и category lines; действующая версия Approved. Committed costs — подтверждённые, но ещё не проведённые обязательства. При posting связанного expense commitment уменьшается на consumed amount. Actual+remaining commitment не должны учитывать одну сумму дважды. Alerts default 80%, 100%, 120% расходования; каждое пересечение threshold уведомляет один раз на budget version, ниже порога можно сбросить после explicit reset.

Budget allocation по нескольким проектам не является фактическим расходом. Неиспользованный бюджет не переносится сам; Copy Budget создаёт draft следующего периода с выбором переноса.

### 18.6. Вознаграждения

Rule types:

1. Fixed Period Amount: сумма за календарный месяц; mid-period proration задаётся явно None либо Calendar Days. При Calendar Days сумма×eligible calendar days/days in month. Unpaid leave влияет только при указанной policy. Нет скрытого «рабочего месяца 30 дней».
2. Hourly: approved eligible TimeEntries либо approved Shift Net Hours; один rule выбирает ровно один источник. Rate×decimal hours; rounding на итог получателя/правила, не на каждую минуту. Пересечения источников исключаются до approval.
3. Per Approved Unit: rate×unique eligible ContentItem с first_approved_at в периоде и contributor role. Повторная версия не новый оплачиваемый unit, если rule не задаёт отдельный revision service явно.
4. Revenue Share: выбранная база Gross/Net After Refunds and Fees, только Posted verified entries, attribution shares и effective rule interval. Процент от неизвестного gross не считается.
5. Manual Bonus/Adjustment: отдельная строка с reason, creator и approver; не произвольное редактирование рассчитанного total.

Rule version effective interval [from,to); overlapping одинаковые recipient+basis+scope+component запрещены. Fixed + Revenue Share можно комбинировать через explicit stack group. Несколько Revenue Share одного источника допустимы только при заданной структуре и preview total percent; сумма распределённой базы по managers≤100%. Доход компании при этом не дробится на несколько новых revenue facts.

Refund policy: default adjust next open run, linked original entitlement. Если refund пришёл до approval — пересчитать draft с diff; после approval — negative adjustment next run. Ограничение отрицательной к выплате суммы: показывать carry-forward balance; не записывать автоматическое списание денег у сотрудника. Ручное урегулирование отдельным документом.

CompensationRun: Draft → Calculated → Submitted → Approved → Partially Paid → Paid; Cancelled только до Approved. Approval создаёт ровно один связанный Compensation expense document по строкам run; повтор approval не создаёт expense заново. Уже заведённая вручную compensation expense требует Link Existing/Reconcile, иначе duplicate block. Зарегистрированный payout уменьшает payable, не добавляет второй expense.

Каждая CompensationLine имеет source entitlement key: recipient+rule_version+source_type+source_id+component. Fixed entitlement key включает месяц. Claims уникальны среди approved runs; reversal освобождает экономический эффект через adjustment, не стирает claim audit. Approved run хранит snapshot всех правил, сумм, курсов и source IDs. Pay slip доступен собственному member при compensation.own.read и не раскрывает чужие выплаты.

### 18.7. Закрытие периода и контрольный пример

Close Period проверяет unreviewed entries, unmatched settlements, unallocated costs, compensation drafts и missing FX; показывает issues. Owner/Finance с правом может закрыть с documented unresolved items, которые попадают в period report. После closure posting задним числом blocked; corrections в следующем периоде с reference либо explicit Reopen с reason и журналом пересозданных reports.

Контрольный пример для тестов: Gross=1000 EUR, Refund=100, Platform Fee=180, Net=720. Production Expense=200. Manager share 10% от Net=72, approved run создаёт Compensation Expense=72. Operating Result=448. Platform payout 720 не меняет 448. Выплата менеджеру 30 оставляет Outstanding Compensation=42. Если production expense 200 оплачен, Cash Movement=720−200−30=490. Повтор payout confirmation с тем же ключом сохраняет все значения.
