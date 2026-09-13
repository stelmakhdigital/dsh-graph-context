# Roadmap: dsh-context-graph

Обновлено: 2026-09-13 · Статус: **v0.4.0 выпущен** (P2a + ренейм token-запрета «graft» по решению владельца; репо перечислено с чистого листа); **стоп до P2b/P2c** (change control)
Цель: P0 работает в `dsh web` — агент читает построенную карту репо, а не грейпит вслепую · KPI: см. PROJECT_MEMORY §2

## Фазы

| Фаза | Статус | Вехи | Критерий выхода |
|---|---|---|---|
| 0 Discovery | ✅ 2026-09-12 | — | проблема валидирована владельцем; спецификация-директива `dsh-context-graph-plugin.md` (не заметка) |
| 1 Definition | ✅ 2026-09-12 | M0: scope P0 подтверждён | Must = P0 из спеки; Won't = нецели + P2 (change control); KPI записаны |
| 2 Design | ✅ 2026-09-12 | M1: контракт хоста | ADR в PROJECT_MEMORY §4; модули по layout из спеки; API хоста сверены (pre-step/PostToolDecision/Agent/session.header.cwd) |
| 3 Development (P0) | ✅ 2026-09-12 | M2: P0 — задачи ниже | TDD: 96 тестов (8 файлов + e2e), typecheck strict зелёный, lib/ собран |
| 4 Testing (P0) | ✅ 2026-09-12 | M3 | e2e `GRAPH_E2E=1` с реальным CLI (движок 0.18.0) — 3/3; headless-прогон: модель зовёт graph_* (см. отчёт P0) |
| 5 Release (P0) | ✅ 2026-09-12 | M4 | tarball `dsh-context-graph-0.1.1.tgz` + install-инструкция в README; `dsh plugin add` поднимает harness, `--dump-config` показывает слой; живой web-GUI-прогон зелёный |
| 6 Development (P1) | ✅ 2026-09-12 | M5: P1-задачи ниже | TDD: pre-step retrieval, post-edit blast, turn-stop autoSync, skill-install, settings-секция, dirty/freshness; флаги P0 (injectPromptHits/injectBlastRadius/autoSync) активны; 136 тестов, typecheck strict, e2e 3/3 |
| 7 Release (P1) | ✅ 2026-09-12 | M6 | tarball `dsh-context-graph-0.2.0.tgz` в web+cg; headless-прогон на живом хосте: prompt→hits (pre-step), edit→blast+dirty (post-execute), turn-stop→build (autoSync, wiring.json переписан), skill подхвачен моделью; **стоп до P2** |
| 8 Development (P2a) | ✅ 2026-09-13 | M7: P2a-задачи ниже | Пакет #1 injectMode, #2 nudge, #8 scopeFromLastEdit, #12 wiring-guard, #16 metrics, #14 fetch-тест, #13/#15 доки; 175 тестов + e2e 3/3 |
| 9 Release (P2a) | ✅ 2026-09-13 | M8 | tarball `0.4.0` (0.3.0 не публиковался — в него вошёл ренейм), install web+cg, live-прогон (web-бут + headless exit 0), отчёт §«Отчёт P2a»; **стоп до P2b/P2c** |
| 10 Release (rename v0.4.0) | ✅ 2026-09-13 | M9 | Токен «graft» убран из всего собственного именования (tools `graph_*`, `graphPath`, `GRAPH_*`, скилл `graph/`, ошибки, env, доки); 175 тестов + e2e 3/3; tarball 0.4.0 в web+cg; репо перечислено с чистого листа (история удалена по команде владельца) |
| P2b (host-поверхности) | ⬜ | — | #6 compaction re-inject, #5 subagent-карта, #11 toolOrder — после сверки событий/API хоста |
| P2c (тяжёлые фичи) | ⬜ | — | #3 graph_blast, #7 graph_enrich (--deep local), #17 watcher, #4 Code Mode — проверка API хоста |
| P2 учтено частично | ✅ | — | #9 (state по (sessionId,gitRoot) — P0), #10 (no-git → no-op — P0), #12 текстовая часть (system section + skill), #14 (fetch-тест — P2a) |

## Задачи (фаза 8 — P2a, завершена 2026-09-13)

- [x] Контракт: `tools/pre-execute` (waterfall `(exec, next) → PreToolDecision {kind:allow}|{deny,reason}|{ask}`); `ask --source --json` — hit несёт `code` (тело) в 0.18.0 (сверено живьём 2026-09-13: топ-хит `issueToken` несёт `code` = тело функции; контракт хоста сверен с packages/core/tools + hooks-claude-code)
- [x] Конфиг: `injectMode: pointers|sourced|map-only` (дефолт `sourced`), `nudgeOnBlindSearch` (true), `scopeFromLastEdit` (false), `metrics` (true), `guardWiringReads` (false); schema+normalize+дефолты
- [x] TDD: pre-step по mode (map-only — без CLI; pointers — без --source; sourced — `ask --source`, crux топ-1 ≤8 строк + остальное указателями)
- [x] TDD: `scopeFromLastEdit` — `--in <top-level-dir>` из `lastFile` (относительный путь, не basename)
- [x] TDD: pre-execute nudge — один раз за сессию: широкий grep/glob (без path-сужения) при 0 graph-вызовах → `agent.inject` напоминание; после graph-вызова / сужённый grep / флаг off — нет
- [x] TDD: pre-execute wiring-guard — read внутри `graft/.graph/` → `{kind:'deny', reason}` с подсказкой tools (только при `guardWiringReads`)
- [x] TDD: metrics — счётчики graphReads/sourceReads → `$DSH_HOME/context-graph-stats.json` (fail-soft, prune 32 сессии); `graft/` не считается sourceReads
- [x] Тест инварианта #14: в `src/**` нет fetch/http (static scan)
- [x] README EN+RU: P2a-флаги + доки #13/#14/#15 (языки, приватность, coexistence web-automation)
- [x] 0.3.0: сборка, pack, install web+cg, live-проверка, отчёт; **стоп до P2b/P2c**

## Задачи (фаза 6 Development — P1, завершена)

- [x] Контракт хоста P1 сверён: `agent/pre-step` (waterfall, `next()→PreStepDecision{kind:enter,messages}`, контекст = дописать UserMessage), `tools/post-execute` (waterfall `PostToolDecision.additionalContexts`), `agent/turn-stopping` (emit, не блокировать); edit/write-аргумент = `file_path`; **nuance**: guarded-контекст хоста *бросает* на access к недекларированному сервису (не undefined) — чтение `ctx.settings` обёрнуто в try/catch
- [x] TDD: тесты → `src/session-state.ts` dirty (markDirty/clearDirty/isDirty по (sessionId, gitRoot)) + мемо промпт→хит (анти-CLI-спам, bounded 32)
- [x] TDD: тесты → `src/format.ts` (renderPromptHits: компактные указатели без тел; renderBlastRadius: «кто зависит» по символам файла, cap 5/символ, не падать без wiring)
- [x] TDD: тесты → `src/hooks.ts` pre-step (короткий промпт < promptMinChars не зовёт CLI; повтор тех же hits не инжектится; идентичный промпт не гоняется по CLI; без cwd/без graft/ — молча; CLI-fail — pass-through)
- [x] TDD: тесты → `src/hooks.ts` post-execute (matcher editToolNames; игнор файлов под `graft/`; файл вне репо — не dirty; пометка dirty; короткий blast → additionalContexts; skeleton-fail — не падает; без graft/ — dirty да, CLI нет)
- [x] TDD: тесты → `src/hooks.ts` turn-stop (dirty → один структурный build под lock; два stop — один build; после exit — повтор разрешён; без cwd/без dirty/autoSync=false — ничего; detached, не блокирует ход)
- [x] TDD: тесты → `src/skill.ts` (идемпотентная установка в `$DSH_HOME/skills/graph/SKILL.md`; не перетирает кастом; fail-open с warn). DSH-home резолвинг инлайном (env `DSH_HOME` → `~/.dsh`) — `@deepseek-ai/dsh-home-paths` НЕ резолвится из плагин-профиля (workspace-internal), новый peer не вводим
- [x] `src/index.ts`: settings-секция через `ctx.settings.installSection` (если сервис есть; access защищён try/catch от throw guarded-контекста), иначе YAML config only; skill-install один раз
- [x] Сборка `lib/`, typecheck strict, прогон тестов зелёный (136: 97 P0-ядро + 39 P1)
- [x] README EN+RU: P1-поведение (pre-step/blast/autoSync/skill), config-флаги, roadmap-статусы
- [x] Проверка критериев P1 (отчёт ниже) — отчёт владельцу: diff + README; **стоп до P2**

## Задачи (фаза 3 Development — P0, завершена)

- [x] PM-артефакты: PROJECT_MEMORY.md + roadmap.md + реестр рисков (2026-09-12)
- [x] Каркас пакета `dsh-context-graph`: package.json (bundle-манифест, peerDeps, prepare fail-open), tsconfig strict, vitest, esbuild, stubs `@deepseek-ai/*`, `pnpm-workspace.yaml` (autoInstallPeers=false), `.gitignore`, LICENSE MIT
- [x] `cordis.patch.yml` — overlay: `insert` строки плагина с полным конфиг-дефолтом (валиден как insert-patch — тест)
- [x] TDD: тесты-фикстуры → `src/repo.ts` (git-root, nearest `graft/`, cwd из exec.agent vs process.cwd)
- [x] TDD: тесты → `src/cli.ts` (`runGraph`: spawn detached + group-kill, env явный, timeout, abort-signal, битый JSON, exit 1 у `check` = stale не ошибка, логотолерантный парсер)
- [x] TDD: тесты → `src/session-state.ts` (dirty/last hits/lock по (sessionId, gitRoot); lock: N статов → один build; stale-steal)
- [x] TDD: тесты → `src/format.ts` (map/ask/skeleton/calls/grep/check → markdown в бюджете `maxInjectBytes`, UTF-8-safe truncation)
- [x] TDD: тесты → `src/tools.ts` (6 tools, стабильные имена ≤64 snake_case, closed schemas + render, все коды ошибок, cwd из session header)
- [x] TDD: тесты → `src/hooks.ts` (P0: session-start inject map + autoBuild с lock + fail-open; **инвариант: хук не throw** — покрыт тестами; pre-step/post-execute/turn-stop — P1, флаги инертны)
- [x] `src/index.ts` — `name`, `inject: ['tools','systemPrompt']`, `Config` (schemastery, дефолты = полный стек), `apply` (+ `ctx.systemPrompt.section` pointer 5–15 строк, порядок 1490)
- [x] `src/skill-template.ts` — заготовка (используется P1; в P0 — модуль без активации)
- [x] Сборка `lib/` esbuild (коммитится), typecheck против stubs, прогон тестов зелёный (96/96)
- [x] README EN + RU (quick start, взаимное исключение с MCP-сервером движка, «каждый клон делает graft build», privacy), `cordis.yml.example`
- [x] Проверка критериев P0 (5/5, отчёт ниже) — отчёт владельцу: diff + README; **стоп до P1/P2**

## Требования (Must → acceptance)

Must (P0, источник: спецификация):
- US-1: как оператор `dsh web`, я хочу установить пакет `dsh plugin --profile web add …`, чтобы harness поднялся без ошибки.
  - AC-1: given пакет с bundle-манифестом, when add, then профиль содержит слой и `--dump-config` показывает `# == dsh-context-graph`.
- US-2: как модель в сессии на git-репо с `graft build`, я хочу видеть 6 tools + короткий system section.
  - AC-2: given граф построен, when сессия, then tools `graph_find_code|graph_file_api|graph_trace_calls|graph_find_all|graph_repo_map|graph_check_freshness` зарегистрированы, section ≤ 15 строк.
- US-3: как модель, я хочу ответить на «как устроен auth» через граф, а не широкий grep.
  - AC-3: given вопрос по репо, when pre-step, then ориентация указывает на tools (system section) — по tool-trace модель зовёт graph_*, не сразу grep.
- US-4: как оператор без CLI, я хочу стабильный старт.
  - AC-4: given нет `graft` в PATH, when tools, then `GRAPH_CLI_MISSING` с командой `npm i -g @nanonets/graft`, хуки no-op.
- US-5: как оператор двух параллельных сессий в разных репо, я хочу изоляцию состояний.
  - AC-5: given два git-root, when обе сессии, then cwd/dirty/lock ключуются (sessionId, gitRoot) — каждая видит свой граф.

NFR: без `any` в публичных API; хуки не ходят в сеть; `graft build` без `--deep`; инъекции ≤ `maxInjectBytes` (4096) за ход.

## Решения (change log)

| Дата | Решение | Кто | Почему |
|---|---|---|---|
| 2026-09-12 | Scope P0; P1/P2 — по явной команде | владелец | спека §«Фазы поставки» |
| 2026-09-12 | Форма пакета — по хосту (доки + hooks-claude-code), не по dsh-web-automation | агент | репо-референс на хосте отсутствует (ADR PROJECT_MEMORY §4) |
| 2026-09-12 | Дефолт editToolNames: `['write','edit']` (имена host tool-fs), bash-реврайт вне P0 | агент | имена подтверждены по packages/fs/tool-fs; bash-дetekция ненадёжна |
| 2026-09-12 | Верификация P0 — через **tarball** (`npm pack` → `dsh plugin add file:…tgz`); `link:`-чек-аут ломает module identity (realpath вне профиля → чужие/реестровые @deepseek-ai/*) | агент | хост резолвит плагин от realpath; production-путь = распакованный пакет |
| 2026-09-12 | Репозиторий не ставит `@deepseek-ai/*` (pnpm-workspace.yaml: autoInstallPeers=false) — экземпляры принадлежат хосту | агент | два экземпляра dsh-llm/dsh-tools ломают instanceof и шаринг (ADR §4) |
| 2026-09-12 | Формат указателей `path:L8-L10` (L у обеих границ) — сверено с живым CLI 0.18.0; pointer-парсер подправлен | агент | live-проверка JSON-формов graft |
| 2026-09-12 | spawn запросов — `detached: true` + group-kill (timeout/abort), иначе осиротевшие дети держат пайпы и `close` не наступает | агент | тест GRAPH_TIMEOUT/abort зависал на 30 c |
| 2026-09-12 | **0.1.1:** session-start хук больше НЕ падает на `process.cwd()`, когда у сессии нет cwd — молча fail-open. Per-turn инструменты fallback сохраняют | агент | живой GUI-инцидент: хук собирал граф в каталоге ЗАПУСКА сервера (checkout хост-агента) и инжектнул «being built»; web-флоу (session/create + workspace) воспроизведён — там header.cwd установлен; точный триггер GUI не воспроизведён, фикс = обеззараживание + регресс-тест |
| 2026-09-12 | Правило именования: токен «draft» в проекте запрещён, использовать «graph» (проект = `dsh-graph-context`) | владелец | команда владельца (2026-09-12) |
| 2026-09-13 | **Инцидент 0.3.0: `z.enum is not a function` ронял весь бут `dsh web`.** Корень: в `stubs/schemastery.d.ts` + мок `test/stubs/schemastery.mjs` была выдуманная `enum`, которой нет в реальном `@deepseek-ai/schemastery` v3.18.2 (typecheck/тесты зелёные, хост падает на import плагина). Фикс: `injectMode = z.union([z.const(…)])`; выдуманная `enum` удалена из stub+мок | агент | live-крэш владельца; реальный API сверен с vendor/schemastery d.ts + standalone-смоук |
| 2026-09-13 | Анти-drift guard: `test/schemastery-api-guard.spec.ts` — каждый `z.<static>` в `src/` и каждый статик мок-а ⊆ allowlist реального API (v3.18.2); правила записаны в заголовки stub/мок | агент | та же ошибка класса не должна пройти typecheck+тесты и попасть в хост |
| 2026-09-13 | Профили `web`/`cg` после переустановки конфигурации владельцем: плагин переустановлен в `web` (tarball 0.3.0), `cg` воссоздан из headless-шаблона + плагин | агент | переустановка конфига стёрла plugin-регистрации (bundles `[]`, node_modules пуст) |
| 2026-09-13 | **Ренейм v0.4.0: токен «graft» в собственном именовании проекта запрещён** (tools `graph_*`, `graphPath`, `GRAPH_CLI`/`GRAPH_*`, скилл `skills/graph/`, все доки). Описка в записи 2026-09-12 («draft») исправлена. Внешний движок `@nanonets/graft` (пакет, бинарник, каталог `graft/`, его env) цитируется по реальному имени как зависимость | владелец | явная команда владельца (2026-09-13); ломающее для выпущенных 0.1.1/0.2.0/0.3.0-названий, поэтому minor-bump 0.4.0 |
| 2026-09-13 | **История удалённого репо удалена полностью** — новый первый коммит с чистого листа (orphan), локальный `master` оставлен как бэкап | владелец | команда владельца (2026-09-13) |

## Отчёт P0 — критерии приёмки (2026-09-12, профиль `cg` = headless-шаблон)

| # | Критерий | Результат |
|---|---|---|
| 1 | `dsh plugin add` поднимает harness | ✅ tarball установлен в профиль `cg`, reconcile добавил `dsh-context-graph` в bundles; `dsh --profile cg --dump-config` печатает слой `# == dsh-context-graph` с полным конфигом |
| 2 | 6 tools + короткий system section | ✅ `apply()` регистрирует ровно 6 (graph_find_code, graph_file_api, graph_trace_calls, graph_find_all, graph_repo_map, graph_check_freshness); section `plugin:dsh-context-graph` (порядок 1490, 6 строк, все имена + fallback) — юнит-тесты |
| 3 | Модель зовёт graph_*, а не широкий grep | ✅ headless-прогон (реальный LLM, репо `/tmp/graph-sample` с построенным графом): модель пошла `graph_repo_map → graph_find_code → graph_trace_calls`, дальше только 2 точечных `read` мелких файлов, grep не вызывался (tool-trace в reasoning-потоке) |
| 4 | Нет CLI → `GRAPH_CLI_MISSING` | ✅ PATH без graft/npx: tool вернул `{ok:false, error:'GRAPH_CLI_MISSING', hint:'npm i -g @nanonets/graft'}`; render — `[GRAPH_CLI_MISSING] …`; исключений нет. Промежуточный случай (npx есть, graft нет): штатный `GRAPH_TIMEOUT` после 4 c (npx-cold-start guard) |
| 5 | Две сессии / два репо — изоляция | ✅ юнит: state ключуется (sessionId, gitRoot) (параллельные сессии не делят dirty/hits); tools резолвят репо из session-header cwd (тест: exec с чужим cwd → чужой git-root; без agent → process cwd) |

**Живой web-GUI-прогон (2026-09-12, профиль `web`, репо `/tmp/graph-sample`):** модель через нативные `graph_*` инструменты дала корректный ответ (issueToken → authenticate → login; `graph_check_freshness` = Fresh). Выявлен и исправлен (0.1.1) инцидент: session-start инжектнул «being built» — хук упал на `process.cwd()` (каталог запуска сервера), т.к. у сессии в тот момент не было cwd; фонового графа в чужом репо не осталось (build-таймаут). Фикс: без session-cwd хук молчит; регресс-тест добавлен (97 тестов).
Ограничение проверки: критерий 3 подтверждён headless-прогоном (по спеке — «глазами или фикстурой tool-trace») + живым web-GUI-прогоном; точный GUI-триггер отсутствия cwd не воспроизведён (header.cwd в воспроизведённых web-флоу установлен), фикс носит обеззараживающий характер.

## Отчёт P1 — критерии приёмки (2026-09-12, v0.2.0)

Спека не даёт отдельного списка приёмки P1; принималось по эталонному циклу (таблица «Событие DSH → что сделать») + TDD-списку спеки. Живая проверка — headless-прогон на реальном хосте (профиль `cg1` = headless + плагин + debug-обсервер, репо `/tmp/graph-sample`), LLM-запрос «найди функцию, выдающую токены, и добавь комментарий над issueToken».

| # | Критерий (из цикла/ТDD-списка спеки) | Результат |
|---|---|---|
| 1 | pre-step: промпт ≥12 символов → `graft ask` топ-3 **указателей без тел** → additionalContext | ✅ live: debug-обсервер зафиксировал `PRE-STEP … messages=2 lastSource=plugin lastText="Graph prompt hits …: - src/index.ts:L2 — login — score 1.00"` (плагин дописал контекст к admitted messages). Короткий промпт/повтор хита/без cwd/без графа — юнит-тесты (молчание, dedupe, pass-through) |
| 2 | post-execute: edit-инструмент изменил файл исходников (не `graft/`) → blast radius «кто зависит» + dirty | ✅ live: `POST-EXEC tool=edit kind=accept extraContexts=1 extraText="Graph blast radius after editing src/auth.ts … - authenticate ← login @ src/index.ts:L2-L2 - issueToken ← authenticate @ src/auth.ts:L3-L6"`; dirty=true. Игнор `graft/`, файл вне репо, block-решение, skeleton-fail — юнит-тесты |
| 3 | turn-stop: если dirty — фоновый структурный `graft build` (без --deep), не блокируя ход | ✅ live: после edit `TURN-STOPPING turn=1`, `graft/.graph/wiring.json` переписан (mtime в пределах хода), lock-файл после завершения отсутствует (released); два stop → один build (lock) — юнит-тест |
| 4 | Skill: шаблон кладётся плагин в `$DSH_HOME/skills/graph/` один раз, идемпотентно | ✅ live: файл установлен в `~/.dsh/skills/graph/SKILL.md`; в прогоне модель сама загрузила скилл («let's load the graph skill») и использовала словарь graph_*. Идемпотентность/не-перетирание/файл-вместо-каталога — юнит-тесты |
| 5 | settings-секция, если сервис есть; иначе YAML only | ✅ `installSection` вызывается только при наличии `ctx.settings`; доступ к undeclared-сервису бросает на guarded-хосте — обёрнут try/catch (регресс-тест). В headless-профиле провайдера нет → YAML only, плагин поднимается без ошибки |
| 6 | инвариант: хук не throw | ✅ все P1-хуки возвращают решение/void, ошибки — в `catch` → `logger`; покрывающие тесты (CLI-fail, skeleton-fail, битые JSON-формы) |

Ограничение проверки: P1-прогон выполнен headless (один LLM-запрос на все три канала); settings-провайдер в live-профиле не смонтирован (ветка «YAML only» подтверждена джамп-конфигурацией, ветка installSection — юнит-тестом). Web-GUI-профиль обновлён до 0.2.0 на диске — вступает в силу после рестарта web-сервера.

## Отчёт P2a — критерии приёмки (2026-09-13, v0.4.0)

Спека не даёт отдельного списка приёмки P2a; принималось по пакету фазы 8 (#1, #2, #8, #12, #14, #16 + доки #13/#15). В день выпуска найден и закрыт boot-крэш 0.3.0 (`z.enum`, см. Решения 2026-09-13) — ниже проверка уже исправленного пакета.

| # | Критерий | Результат |
|---|---|---|
| 1 | Пакет #1 `injectMode`: pre-step по mode; sourced — crux топ-1 (≤8 строк) + указатели; pointers — компактно; map-only — без CLI | ✅ TDD (hooks.spec): map-only → `ask` не вызывается; pointers → без `--source`; sourced → `ask --source` + `renderPromptHitsSourced` (crux топ-1, остальное указателями, byte-бюджет, fallback на pointers без `code`). Контракт CLI живьём (0.18.0): топ-хит несёт `code` |
| 2 | Пакет #2 nudge: один раз на (session, repo), широкий grep/glob при 0 graph-вызовах; reminder, не ban | ✅ TDD: широкий grep → `agent.inject` текстового напоминания один раз; повтор/сужённый grep (есть `path`)/после graph-вызова/флаг off → молчание; deny/ask downstream не трогается |
| 3 | Пакет #8 `scopeFromLastEdit`: `--in <top-level-dir>` из `lastFile` (rel-путь, не basename) | ✅ TDD: после edit `src/auth.ts` следующий `ask` получает `--in src`; basename (без `/`) → без scope; флаг off → без scope |
| 4 | Пакет #12 wiring-guard (opt-in): read `graft/.graph/*` → deny с подсказкой tools | ✅ TDD: при `guardWiringReads` read внутри `graft/.graph/` → `{kind:'deny', reason}` (hint на graft_*); без флага / вне `.graph` → allow; deny только read |
| 5 | Пакет #16 metrics: локальные счётчики `$DSH_HOME/context-graph-stats.json`, fail-soft, prune 32 | ✅ TDD (metrics.spec): graph-вызовы vs source-чтения (read/grep/glob, только внутри git-root и вне `graft/`), prune, битый JSON → перезапись без броска; сетевых вызовов нет (инвариант #14 — static scan `src/**`) |
| 6 | Доки #13/#15: README EN+RU — P2a-флаги, приватность (metrics локальные), coexistence | ✅ README.md/README.ru.md: таблица флагоv + §P2a (v0.3.0) |
| 7 | `dsh web` поднимается с плагином (регресс крэша) | ✅ `pnpm dsh plugin --profile web add …0.3.0.tgz` (reconcile: bundle добавлен); `pnpm dsh web --no-open --port 3199` — бут зелёный, app отдаёт страницу (303 с токеном), `apply()` установил `$DSH_HOME/skills/graph/SKILL.md`; standalone-смоук: Config строится на РЕАЛЬНОМ schemastery 3.18.2 |
| 8 | Headless-прогон на живом хосте (регресс P0/P1 + P2a-хуки в agent loop) | ✅ `cg` воссоздан (headless-шаблон + плагин), `dsh --profile cg` в `/tmp/graph-sample` (граф 8 узлов/10 рёбер): exit 0, ответ модели получен; pre-execute/post-execute/pre-step-хуки зарегистрированы, исключений из loop не было |
| 9 | Тесты | ✅ 175 unit (TDD, +3 api-guard) + e2e 3/3 с реальным CLI (`GRAPH_E2E=1`); typecheck strict; инвариант #14 зелёный |

Ограничение проверки: P2a-поведение моделей (nudge/sourced) подтверждено TDD + контрактом хоста (packages/core/tools, hooks-claude-code сверены) + живым буюм; многораундовый LLM-прогон «модель сама вызывает graph_* после nudge» не делался (один headless-запрос). Профиль `web` на :3080 поднят до переустановки конфигурации — подхватит 0.3.0 после его рестарта (текущий бегущий инстанс работает на старом профиле без плагина).

## Не в этом релизе (Won't)
- P2 (18 расширений из спеки): injectMode, nudge, graph_blast, Code Mode SDK, subagent-карта, compaction, local --deep, mono-repo scope, followSandbox, toolOrder, wiring-охрана, watcher, метрики, и др. — только по явной команде, каждое за отдельным флагом конфига.
- `writeAgentsMd` (opt-in патч AGENTS.md) — вне P1.
- UI-часть settings (редактирование полей из GUI) — в P1 заведены только schema-секция и provider-конsumption; UI хоста её отрисует, когда смонтирует провайдер.
- Статуслайн, телеметрия, `graft viz` как UI DSH, эмбеддинг-поиск, MCP-сервер движка параллельно, патч AGENTS.md по умолчанию (opt-in `writeAgentsMd` позже), свой tree-sitter.
