# PROJECT_MEMORY: dsh-context-graph

## 1. Проект (одно предложение)
Standalone-плагин DeepSeek Harness, дающий агенту готовую карту репозитория (символы, вызовы, blast radius) через локальный граф контекста (движок — CLI `@nanonets/graft`), чтобы агент не исследовал репо grep/read с нуля каждый ход.

## 2. Цель и KPI
- Цель: P0 работает в `dsh web` (критерии готовности P0 — в `dsh-context-graph-plugin.md` §«Критерий готовности P0», 5 пунктов).
- KPI:
  - В сессии на git-репо модель зовёт `graph_find_code` / `graph_repo_map` вместо широкого grep (проверка глазами / tool-trace).
  - Harness стартует без CLI в PATH (tools → `GRAPH_CLI_MISSING`), без графа, без git — агентный цикл не ломается (0 throw из хуков).
  - Покрытие ключевых путей витестом ≥ 80%, мок `runGraph`, без глобального npm в CI.

## 3. Люди и стейкхолдеры
| Кто | Роль | Решает | Как/сколько часто общаться |
|---|---|---|---|
| arka (пользователь) | владелец продукта | scope, P1/P2 старт | в чате, по каждому гейту фазы |
| DSH-агент | разработчик | реализация, тесты | отчёт после P0 (diff + README) |

## 4. Решения (ADR-lite)
- **2026-09-12 — Нативный плагин, не MCP-обёртка.** Почему: MCP — один процесс на весь harness (разные сессии с разным cwd получат чужой граф), MCP-имена внешнего движка (префикс `mcp__`) не совпадают с инструкцией, локальным моделям нужен push карты в контекст. Альтернативы: MCP-обёртка движка (отклонено), форк движка в DSH (отклонён — не форкай). Решение: владелец (спецификация `dsh-context-graph-plugin.md`).
- **2026-09-12 — Движок v1 = spawn CLI `@nanonets/graft`.** Почему: не пишем свой tree-sitter, покрывает языки. Резолв: `config.graphPath`/`GRAPH_CLI` → `graft` в PATH → `npx -y @nanonets/graft` (fallback, лог). Резолв репо — из cwd сессии на каждый вызов. Альтернативы: in-process API (нет), собственный экстрактор (отклонено в MVP).
- **2026-09-12 — Fail-open в хуках.** Нет git / нет CLI / нет `graft/` / таймаут / битый JSON → плагин молчит; `throw` из хука в агентный loop запрещён. Tools возвращают структурированную ошибку (`GRAPH_CLI_MISSING`).
- **2026-09-13 — Имена tools — собственные `graph_*` (решение владельца: токен «graft» в собственном именовании проекта запрещён).** `graph_find_code`, `graph_file_api`, `graph_trace_calls`, `graph_find_all`, `graph_repo_map`, `graph_check_freshness`. Причина: skill/AGENTS.md/модель должны совпадать; токен «graft» сохраняется только как имя внешнего продукта (пакет `@nanonets/graft`, бинарник `graft`, кэш-каталог `graft/`). Переворачивает ADR 2026-09-12 «имена как у Graft MCP» (v0.4.0, ломающее переименование выпущенных tools).
- **2026-09-12 — cwd из `exec.agent?.session.header.cwd`**, fallback `process.cwd()`, затем подъём до git-root. Подтверждено хостом: тот же паттерн в `tool-bash`/`tool-fs`/`tool-pwsh` (packages/shell, packages/fs).
- **2026-09-12 — Scaffolding-формы из хоста, не из dsh-web-automation.** Репозиторий dsh-web-automation на этом хосте отсутствует; форма пакета (bundle + overlay + `defineTool` + `ctx.systemPrompt.section`) воспроизведена по документации хоста (`docs/user/develop/basic/*`) и референсам `packages/hooks/hooks-claude-code` (Семантика SessionStart/UserPromptSubmit/PostToolUse/Stop), `packages/context/time-context` (Config/inject/pre-step), `apps/cli/src/plugin.ts` (механика `dsh plugin add`).
- **2026-09-12 — Scope: только P0.** P1/P2 — по явной команде владельца (change control). P2-расширения (18 шт.) не начинаем.
- **2026-09-12 — PM-дисциплина из скилла awesome-coding (раздел pm):** SDLC-гейты, roadmap.md, PROJECT_MEMORY.md, реестр рисков; решения — в день принятия.

## 5. Ограничения и риски (top)
Ограничения: TypeScript strict + ESM, без `any` в публичных API; маленькие модули по layout из спецификации; `lib/` собирать esbuild и коммитить; Node 22.19+/24+; `graft/` не коммитится (локальный кэш); без телеметрии; `--deep` никогда из хуков. **Названия: проект = `dsh-graph-context`; токен «graft» в СОБСТВЕННОМ именовании (файлы, ветки, тесты, переменные, артефакты, имена tools/конфига/ошибок/скилла) запрещён — использовать «graph» (решение владельца, 2026-09-13; записанное 2026-09-12 правило про «draft» было опиской). Внешний движок `@nanonets/graft` (пакет, бинарник, каталог `graft/`, его env-переменные) цитируется по реальному имени как зависимость.**

Реестр рисков:

| ID | Риск | P (1–5) | I (1–5) | Score | Митигция | Владелец | Статус |
|---|---|---|---|---|---|---|---|
| R1 | Интерфейс CLI движка (флаги/JSON) отличается от спецификации | 3 | 5 | 15 | **Смито** (2026-09-12): CLI 0.18.0 поставлен, формы JSON сверены живьём (ask/skeleton/callers/grep/map/check), e2e `GRAPH_E2E=1` зелёный; `runGraph` изолирован, парсеры — фикстуры | агент | смитирован |
| R2 | Разница DSH API от допущений спеки (pre-step, settings) | 2 | 4 | 8 | **Смито** (2026-09-12): сверено с live-чек-аутом хоста (events, Agent.inject, session.header.cwd, systemPrompt.section, defineTool); headless-прогон на реальном хосте | агент | смитирован |
| R3 | Session-start inject не попадает в первый запрос (известный лимит DSH) | 4 | 3 | 12 | Короткий pointer в `ctx.systemPrompt.section` + полный map inject'ом (повторные запросы) | агент | активен |
| R4 | Scope creep в P1/P2 | 3 | 4 | 12 | Won't-список в roadmap + правило: новые куски — только через «Решения» | владелец | активен |
| R5 | Нет git/CLI/сети в среде запуска — плагин должен молчать | 2 | 3 | 6 | **Смито** (2026-09-12): fail-open покрыт тестами + живая проверка `GRAPH_CLI_MISSING` (PATH без graft/npx) | агент | смитирован |
| R6 | Module identity: `link:`-чек-аут подтягивает чужие/реестровые `@deepseek-ai/*` и ломает шаринг с хостом | 3 | 4 | 12 | Репозиторий не ставит peer'ы (`autoInstallPeers=false`); верификация/установка — через tarball (realpath в профиле); зафиксировано в roadmap | агент | смитирован (P0), следить |
| R7 | Session-start хук при отсутствии session-cwd падал на `process.cwd()` (в сервере — каталог ЗАПУСКА) и собирал граф чужого репо | 3 | 4 | 12 | **Смито 0.1.1** (2026-09-12): хук молчит, если у сессии нет cwd (regress-тест «session header has no cwd»); per-turn инструменты fallback сохраняют (к моменту вызова header заполнен). Живой web-флоу (session/create + workspace) воспроизведён — header.cwd там установлен; точный GUI-триггер не воспроизведён | агент | смитирован (0.1.1), следить |
| R8 | Guarded-контекст хоста БРОСАЕТ на access к недекларированному сервису (`cannot get property "settings" without inject`), а не отдаёт undefined — наивная проверка `ctx.settings` роняет весь плагин при загрузке | 3 | 5 | 15 | **Смито P1/0.2.0** (2026-09-12): чтение `ctx.settings` обёрнуто try/catch (regress-тест «host whose guarded context THROWS on settings access»); найдено живьём на headless-буте (dump-config не покрывает apply) | агент | смитирован (0.2.0), следить |
| R9 | Stub-drift: локальный type-stub/тест-мок объявляет API, которого нет в РЕАЛЬНОМ peer-пакете (host резолвит реальный) — typecheck и юниты зелёные, хост падает на import плагина. Реализовано 2026-09-13 в 0.3.0: выдуманная `z.enum` (нет в schemastery 3.18.2) → `z.enum is not a function` ронял весь бут `dsh web` | 2 | 5 | 10 | **Смито 0.3.0** (2026-09-13): `injectMode = z.union([z.const…])` (реальный API, сверен с vendor/schemastery d.ts + standalone-смоук); `enum` удалена из stub+мок; **guard-тест `test/schemastery-api-guard.spec.ts`** (call-sites в `src/` и статик-поверхность мок ⊆ allowlist реального API); anti-drift правила в заголовках stub/мок; любой новый host-API — сверять с реальным хостом ДО typecheck | агент | смитирован (0.3.0), следить |

## 6. Текущее состояние (свежесть ≤ 1 недели)
- Фаза: **P2b завершён (v0.5.0)** (roadmap.md фазы 8–9 ✅, P2b-строка ✅ M10, 2026-09-13). P2b-пакет: #5 subagent-карта (`agent/created` + guard `agent.parentAgent`, короткий мап, бюджет `maxInjectBytes/2`), #6 compaction re-inject (`session/event` → `compaction/summary|prune`, одноразовый мап на следующем pre-step), #11 toolOrder (waterfall `system-prompt/assemble` → graph-tools первыми, no-op без события). Три новых флага конфига: `injectSubagentMap` / `reinjectAfterCompaction` / `toolOrder` (default on).
- Контракты хоста (сверены с реальным кодом 2026-09-13): `agent/created` emit `{agent}` (`packages/core/agent` runtime-types); session-события — durable `SessionEvent` (`compaction/summary {compactionId, summary, shadowedRange…}`, `compaction/prune`); прецедент подписки плагинов — `ctx.on('session/event')` (goal/todo/token-meter); `PromptAssembly {sections, contexts, tools: ToolSchema[], variables}`; `ToolSchema {name, description, parameters}`. Stubs расширены с anti-drift-пометками (R9-процесс).
- v0.4.0 (2026-09-13): ренейм по решению владельца — токен «graft» убран из всего собственного именования (tools `graph_*`, `graphPath`, `GRAPH_*`, скилл `skills/graph/`, доки). Осталось только имя внешнего продукта. История удалённого репо удалена полностью (новый первый коммит); локальный `master-history-backup` = старая история.
- Инцидент 2026-09-13 (закрыт): 0.3.0 не грузился — `z.enum is not a function` (R9: `enum` была выдумана в stub+мок). Исправлено: `z.union([z.const…])`, guard-тест (test/schemastery-api-guard.spec.ts), standalone-смоук на реальном schemastery 3.18.2.
- Статус-кво: 200 юнит-тестов (TDD, вкл. api-guard) + opt-in e2e 3/3 с реальным CLI (fixture `/tmp/graph-sample`); typecheck strict (`noUncheckedIndexedAccess` — индексные доступы дают `T | undefined`); `lib/` собран esbuild (коммитится); `dsh-context-graph-0.5.1.tgz` в web+cg (live: web-бут + headless exit 0).
- Артефакты: `dsh-context-graph-0.5.1.tgz`; профили: `web` и `cg` (headless-шаблон) с плагином 0.5.1; `~/.dsh/skills/graph/SKILL.md` установлен (старый `~/.dsh/skills/graft/` удалён).
- Live (2026-09-13): web-бут 0.5.1 (3199, tokenized URL отдаёт 303→app), headless `cg` exit 0. Плагин живьём работает в этой GUI-сессии (session-start-мап, pre-step prompt hits, post-edit blast radius). **P2b live-проверка**: toolOrder ✅ (список tools сессии: 6 graph-tools первыми, далее алфавит); subagent-мап: live-субагент получил FULL_MAP (session-start, на 2-м шаге — inject race) но SHORT_MAP потерян (race с immediately-submitted prompt драйвера) → **0.5.1: доставка через pre-step decision** (arming в `agent/created` без CLI + мап в messages первого pre-step). Компакция (#6) headless форснуть нельзя (одноразовая задача, у SDK нет command-RPC) — покрыто TDD + сверенным контрактом подписки; live-наблюдение = `/compact` в GUI.
- Live-проверка P2b после рестарта GUI на 0.5.1: перезапустить субагент-чек (ожидаемо SHORT_MAP: YES на первом шаге).
- Важно: GUI (:3080) работает на bundle'е, загруженном при последнем рестарте — чтобы подхватить 0.5.0, нужен ещё один рестарт web-сервера.
- Следующее: **СТОП** — ждём владельца. P2c (#3 graph_blast, #4 Code Mode, #7 graph_enrich, #17 watcher) — только по явной команде (change control, Won't-список roadmap).
- Обновлено: 2026-09-13

## 7. Глоссарий
- **граф / graft/** — локальный кэш карты репозитория, создаётся CLI движка (`@nanonets/graft`); аналог `node_modules`, не коммитится.
- **push vs pull** — push: карта инжектится в контекст (session-start/pre-step); pull: модель сама зовёт tools.
- **fail-open** — при любой ошибке инфраструктуры хуки не ломают агентный цикл.
- **P0/P1/P2** — фазы поставки из спецификации (обязательное ядро / расширения цикла / P2-расширения).
- **bundle** — npm-пакет с `dsh.bundle.patch`, слой конфигурации профиля DSH.
