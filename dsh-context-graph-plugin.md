# Промпт: нативный DSH-плагин графа контекста репозитория (на базе внешнего движка `@nanonets/graft`)

Скопируй всё ниже разделителя в новый чат агента (новый репозиторий, не `dsh-web-automation`). Это спецификация реализации, не заметка.

---

Ты реализуешь **новый standalone-плагин DeepSeek Harness** — локальный граф контекста кодовой базы. Цель: агент DSH перестаёт каждый ход заново исследовать репозиторий через grep/read и вместо этого читает уже построенную карту (символы, вызовы, узлы, blast radius).

Образец продукта: [trailhq/Graft](https://github.com/trailhq/Graft) (`@nanonets/graft`). Образец **вшивки в чужой агент**: [внешний проект интеграции](https://github.com/DrGekoz/Graft-for-Hermes). Образец **DSH-плагина**: этот репозиторий `dsh-web-automation` (bundle + overlay + `defineTool` + `ctx.systemPrompt.section` + fail-closed где надо / fail-open где граф опционален).

Не форкай движок в DSH. Не ограничивайся MCP-обёрткой. Сделай **нативный Cordis-плагин**: tools + lifecycle inject + фоновая синхронизация графа. Движок графа на v1 можно вызывать как CLI `@nanonets/graft` (spawn), но резолв репо — **на каждый вызов из cwd сессии**, не из cwd процесса harness.

## Зачем это DSH, а не `graft init`

`graft init` не знает DSH. Он пишет `.claude/skills/` и Claude-хуки. DSH читает `AGENTS.md`, `.dsh/skills/`, `.agents/skills/` и native `ctx.tools`. MCP через `@deepseek-ai/dsh-mcp-client` — один процесс на весь harness: разные сессии Web UI с разным cwd получат чужой граф. Имена MCP-tools (`mcp__graft__graph_find_code`) не совпадают с инструкцией движка (`graft ask`). Локальные модели хуже следуют «сначала вызови tool» — им нужен **push** карты в контекст, как у Claude Code, не только pull.

Эталонный цикл Claude Code (скопировать семантику, не файлы `.claude/`):

| Событие движка | Событие DSH | Что сделать |
|---|---|---|
| SessionStart | `agent/session-start` | `graft map` / ориентация из `graft/INDEX.md` → `agent.inject()` |
| UserPromptSubmit | `agent/pre-step` | если текст хода ≥ 12 символов: `graft ask` топ-3 **указателя без тел кода** → additionalContext. Не инжектить повторно те же хиты в этой сессии |
| PostToolUse Write/Edit | `tools/post-execute` | если tool менял файл исходников (не `graft/`): blast radius «кто зависит» + пометить граф dirty |
| Stop | `agent/turn-stopping` | если dirty — фоновый структурный `graft build` ($0, без LLM), не блокируя ход |

Fail-open: нет git, нет CLI, нет `graft/`, таймаут, ошибка парса — плагин молчит, агентный цикл не ломается. Никогда не `throw` из хуков в агентный loop.

## Нецели

- Не статуслайн Claude Code.
- Не телеметрия движка (выключить: `DO_NOT_TRACK=1` / не проксировать ping).
- Не `graft viz` как UI DSH (CLI `graft viz` пользователю можно оставить в README).
- Не эмбеддинг-поиск вместо графа в MVP.
- Не коммитить каталог `graft/` (это локальный кэш, как `node_modules`).
- Не регистрировать MCP-сервер движка параллельно с native tools (конфликт имён и двойной учёт). Документируй взаимное исключение.
- Не читать ambient `GRAFT_API_KEY` через MCP-child без явного `config.env`: `dsh-mcp-client` скрабит `*KEY*`. Этот плагин MCP не использует; ключ `--deep` только в конфиге плагина / явный env spawn.

## Стек и форма пакета

Новый репозиторий, например `dsh-context-graph` (имя пакета `dsh-context-graph`).

Скопируй **форму** `dsh-web-automation`, не его web-логику:

- `"type": "module"`, `main`/`exports` на собранный `lib/index.js`
- peerDependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, плюс то, что реально импортируешь (`dsh-home-paths`, `dsh-settings`, `dsh-invariants` при необходимости)
- `dsh.bundle.patch` → overlay YAML, который `- insert:` строку плагина в профиль
- `export const name`, `export const inject`, `export const Config` (schemastery), `export function apply(ctx, config)`
- `ctx.tools.register(defineTool({...}))` с каноническим `output.schema` + `output.render`
- уважать `exec.signal`; таймаут на spawn
- `lib/` собирать esbuild’ом и коммитить (git/tarball install без dev-deps), как в web-automation
- Node 22.19+ / 24+ как у DSH
- тесты vitest, typecheck против stubs `@deepseek-ai/*`
- README EN + RU, `cordis.yml.example`, MIT

`inject`: `['tools', 'systemPrompt']`. Settings-секция через `ctx.settings.installSection`, если сервис есть; иначе только YAML-конфиг.

Установка:

```text
dsh plugin --profile <name> add git+https://github.com/<org>/dsh-context-graph.git
```

После install overlay сам добавляет строку плагина. Профиль: `dsh web` / `dsh --profile tui`.

## Контракт DSH (обязательно соблюсти)

- Имена tools: snake_case, `[A-Za-z0-9_-]`, ≤ 64 символов. Публичные имена: `graph_find_code`, `graph_file_api`, `graph_trace_calls`, `graph_find_all`, `graph_repo_map`, `graph_check_freshness` — **собственный словарь проекта (решение владельца 2026-09-13: токен «graft» в собственном именовании запрещён), без MCP-префикса**. Так skill/AGENTS.md/модель совпадают.
- `defineTool` из `@deepseek-ai/dsh-tools`. `execute(args, exec)` берёт cwd так:
  1. `exec.agent` → cwd сессии / workspace root агента (проверь актуальный API хоста: поле cwd у Agent / session)
  2. иначе `process.cwd()`
  Затем поднимись до git-root (ближайший предок с `.git`). Граф ищется как у движка: ближайший `graft/` вверх от cwd.
- `agent.inject({ content, source: { kind: 'plugin', plugin: name } })` — контекст на **следующий** запрос, не wake-up. Idle агент остаётся idle. Guard disposed agent (try/catch).
- `agent/session-start` — emit, не veto. Инжект ориентации здесь. Известный лимит DSH: detached inject может не попасть в **первый** запрос — держи ориентацию ещё и в `ctx.systemPrompt.section` (короткий pointer: «граф есть, зови tools, не grep вслепую»), а полный map — inject. Не дублируй megabyte INDEX.md в system prompt.
- `agent/pre-step` — waterfall. Добавляй context, не deny пользовательский ход.
- `tools/post-execute` — matcher по **реальным именам DSH-tools** (не `Write|Edit|MultiEdit` Claude). Определи имена edit/write/apply_patch/bash-that-rewrote-files по хосту (читай `dsh-tools` / tool-fs в установленном DSH). Если не уверен — таблица имён в конфиге `editToolNames` со вменяемым дефолтом и тестом.
- `agent/turn-stopping` — не блокируй долго. Rebuild в detached spawn (`unref`), с lock-файлом чтобы не запустить два build подряд.
- Хуки и query **не ходят в сеть**. `graft build` без `--deep`. `--deep` только явной tool/командой пользователя или `dsh plugin exec`, никогда из session-start.
- Песочница: если есть `ctx.fs`, не обходи его чтением host fs вслепую для исходников; spawn CLI движка работает с реальным деревом сессии — задокументируй, что граф строится по host-видимому cwd. Если сессия remote/sandbox и дерево не то — fail-open.
- Env spawn CLI: передавай явный `env` (PATH, опционально `GRAPH_TEST_DIR`). Не надейся, что harness пробросит `GRAFT_API_KEY`.
- Не регистрируй tools, требующие task-based MCP extension.

Сверь события и поля Agent по установленному хосту (`node_modules/@deepseek-ai/...` или docs): `packages/core` — `agent/session-start`, `agent/pre-step`, `tools/post-execute`, `agent/turn-stopping`; cookbook Adding a tool; `@deepseek-ai/dsh-mcp-client` **не** использовать в этом плагине.

## Движок графа (v1)

Зависимость runtime: CLI `@nanonets/graft` (peer/optional). Резолв бинаря по порядку:

1. `config.graphPath` / `GRAPH_CLI`
2. `graft` в PATH
3. `npx -y @nanonets/graft` (медленный холодный старт — только fallback, залогируй)

Обёртка `runGraph(args, { cwd, timeoutMs, signal })` → stdout string / parsed JSON. Команды:

| Tool / хук | CLI |
|---|---|
| find_code | `graft ask "<q>" --json -n 3` (+ `--source` только если tool-аргумент `source: true`) |
| file_api | `graft skeleton <file> --json` |
| trace_calls | `graft callers <symbol> --json` + `--direction out` + `--depth N` |
| find_all | `graft grep "<regex>" --json` |
| repo_map | `graft map --json` |
| check_freshness | `graft check --json` (exit 1 = stale — это не ошибка плагина) |
| session-start | `graft map` (текстовый, урезать по `maxInjectBytes`) |
| pre-step | `graft ask "<prompt>" --json -n 3` **без** `--source` |
| post-edit | blast: `graft callers` по символам файла или чтение wiring; не падать если wiring нет |
| turn-stop dirty | `graft build` (без `--deep`) |

На старте сессии в git-репо без `graft/`: один структурный `graft build` (таймаут, например 20s). Если не уложились — inject «граф ещё не готов, зови `graph_repo_map` позже», не блокируй UI.

Не реализуй свой tree-sitter в MVP, если CLI доступен. Если CLI нет — tools возвращают понятную ошибку `GRAPH_CLI_MISSING` с командой `npm i -g @nanonets/graft`, хуки no-op.

## Tools (модель)

Описания — короткие, в императиве, когда звать **вместо** grep/read.

1. `graph_find_code` — вопрос/символ/ошибка → ranked nodes + file:line. Параметры: `query` (required), `source` (bool, default false), `limit` (default 3), `scope` (optional, `--in`).
2. `graph_file_api` — сигнатуры файла без тел. `path` required.
3. `graph_trace_calls` — `symbol`, `direction`: `in`\|`out` (default `in`), `depth` (default 1).
4. `graph_find_all` — regex, optional `path` prefix.
5. `graph_repo_map` — без обязательных аргументов; optional `maxDirs`.
6. `graph_check_freshness` — drift report.

Output: структурированный JSON (schema закрытый, `additionalProperties: false`) + `render` в компактный markdown. Бюджет: указатели и crux ≤8 строк; не вываливать целые файлы.

После edit-tool: если blast radius короткий — `additionalContexts` в post-execute (как делает Claude hook). Не отдельный tool в MVP, но добавь `graph_blast` как расширение (см. ниже).

## Инструкции модели

Три канала, согласованные имена:

1. `ctx.systemPrompt.section` — 5–15 строк: граф существует, native tools, запрет слепого grep до `graph_find_code`/`graph_repo_map`, после крупных правок `graph_check_freshness`.
2. Skill: пакет кладёт шаблон; overlay/README говорит скопировать в `.dsh/skills/graph/SKILL.md` **или** плагин при apply пишет skill в `$DSH_HOME/skills/graph/` (user-level) один раз, идемпотентно. Frontmatter: `name: graft`, kebab-case, `description` + `whenToUse`. Тело — те же имена tools.
3. Не обязано патчить `AGENTS.md` репозитория пользователя. Если делаешь opt-in `config.writeAgentsMd: false` по умолчанию — не сюрпризь git diff. Opt-in может upsert fenced-блок `<!-- graft:start -->` … `<!-- graft:end -->`.

Не пиши `.claude/`. DSH его не сканирует.

## Конфиг плагина (дефолты = полный стек)

```yaml
# cordis overlay insert
- id: context-graph
  name: 'dsh-context-graph'
  config:
    tools: true
    injectSessionMap: true      # SessionStart
    injectPromptHits: true      # pre-step ask
    injectBlastRadius: true     # post-edit
    autoBuild: true             # build если нет graft/
    autoSync: true              # rebuild на turn-stop если dirty
    maxInjectBytes: 4096        # жёсткий потолок на push за ход
    promptMinChars: 12
    graphPath: ''               # пусто = PATH
    timeoutMs: 8000             # query
    buildTimeoutMs: 20000
    deep: false                 # никогда из хуков
    # editToolNames: [...]      # override matcher
```

Пустой `config: {}` включает всё. Флаги выключают куски для бенчмарков (cold vs push vs pull).

## Качество и тесты (TDD)

Сначала тесты, потом код. Покрытие ключевых путей ≥ 80% витестами без реального большого репо:

- резолв git-root / ближайший `graft/` (фикстуры tmp)
- резолв cwd из mock `exec.agent` vs process.cwd
- парсинг JSON `graft ask` / `graft check` stale exit 1
- fail-open: spawn ENOENT, timeout, битый JSON
- pre-step: короткий промпт не зовёт CLI; повтор тех же hits не инжектится
- post-execute: игнор файлов под `graft/`; matcher edit tools
- lock: два turn-stop не запускают два build
- имена tools стабильны
- overlay YAML валиден как insert-patch
- инвариант: хук не throw

Мокай `runGraph`, не требуй npm global в CI. Один opt-in интеграционный тест `GRAPH_E2E=1`.

## Фазы поставки

**P0 (должен работать в `dsh web`):** пакет + overlay + 6 tools + systemPrompt section + session-start inject map + fail-open CLI missing.

**P1:** pre-step retrieval, post-edit blast, turn-stop autoSync, settings section, skill template, dirty/freshness.

**P2 (расширения — сделай архитектуру готовой, реализуй по списку ниже после P1):** см. «Расширения сверх функциональности движка».

Не начинай с P2. README: quick start, mutual exclusion с MCP-сервером движка, «каждый клон делает `graft build`», privacy (код не уходит в сеть на структурном build).

## Стиль кода

TypeScript strict, ESM, без `any` в публичных API. Маленькие модули:

```
src/index.ts          apply, Config
src/cli.ts            spawn движка
src/repo.ts           git root, graph dir, freshness
src/tools.ts          6 defineTool
src/hooks.ts          session-start, pre-step, post-execute, turn-stopping
src/session-state.ts  last hits, dirty, lock (на session id, не глобально)
src/format.ts         map/ask/blast → markdown в бюджете байт
src/skill-template.ts
```

Комментарии — зачем, не что. Без эмодзи в коде и в логах.

---

## Расширения сверх функциональности движка (рекомендации автора промпта)

Реализуй **после P1**. Каждое расширение — отдельный флаг конфига, выключенный или включённый явно. Не раздувай MVP.

### 1. Локальная модель важнее Claude: агрессивный push, крошечный pack

Компактный режим (указатели без тел) инжектит только указатели и ждёт, что модель сама сделает `ask --source`. Локальные/маленькие модели часто не делают второй вызов. Добавь `config.injectMode: pointers | sourced | map-only`. Для DSH дефолт **`sourced`**: в pre-step класть crux (≤8 строк) топ-1 хита, не только file:line. Жёсткий `maxInjectBytes`. Это сознательный trade-off токенов ради того, что модель вообще попадёт в файл.

### 2. Напоминание вместо запрета grep (`tools/pre-execute`)

Не блокируй `grep`/`glob`/`read` (это сломает бенчмарки и законные поиски). Если за сессию ещё не было ни одного graph-tool, а модель пошла в широкий grep по репо — один раз `inject` reminder: «сначала `graph_find_code` / `graph_repo_map`». Счётчик на session id. Выключатель `nudgeOnBlindSearch`.

### 3. `graph_blast` + review/plan режимы

Tool: blast radius diff (`graft blast --base origin/main --json`). На `agent/session-start` если `source` = resume/plan — инжектить короткий blast относительно merge-base, когда dirty git. Полезно для «что сломает этот PR». Не звать LLM `--name` без ключа.

### 4. Code Mode SDK

DSH Code Mode оркестрирует tools из сгенерированного TS. Экспортируй чистые функции `findCode`/`fileApi`/`traceCalls` (тот же `runGraph`) и зарегистрируй их как SDK, если хост это позволяет. Иначе — документируй, что native tools уже видны Code Mode как обычные tools. Не пили второй канал без проверки API хоста.

### 5. Subagent: карта в исследователя

На `subagent/start` inject укороченный `graft map` в child, если parent уже в репо с графом. Иначе explore-субагент снова идёт в cold grep. Fail-open, бюджет ещё меньше (`maxInjectBytes / 2`).

### 6. Compaction: не потерять карту

После уплотнения истории ориентация SessionStart выпадает. Подпишись на событие compaction хоста (найди актуальное имя в `@deepseek-ai/dsh-compaction` / session events). Повторно inject pointer+map, если сессия ещё в том же git-root. Без этого выигрыш от движка исчезает на длинных чатах.

### 7. Локальный `--deep` через Ollama / DeepSeek local

Прокинь в spawn только из **явной** tool `graph_enrich` (не хук): `GRAFT_PROVIDER=openai`, `GRAFT_BASE_URL=http://127.0.0.1:11434/v1`, `GRAFT_MODEL=...`. Ключ из конфига `deep.apiKey` / `deep.apiKeyEnv`, не из scrubbed ambient. По умолчанию tool выключен (`deep.tool: false`), чтобы случайно не сжечь CPU. Кэш движка по content-hash уже делает повтор дешёвым.

### 8. Монорепо: scope от последнего edit

Аналог `lastFileScopeHint` у движка: если wiring.json имеет несколько scope, следующий `ask` автоматически `--in <scope>/`. Храни `lastFile` **относительным путём**, не basename (у движка это слабое место — почини в нашем плагине).

### 9. Несколько сессий DSH = несколько графов

Состояние (`dirty`, last hits, lock, lastFile) ключуй `(sessionId, gitRoot)`, не одним глобальным файлом. Web UI держит параллельные агенты в разных репо — это главная причина не использовать MCP Graft as-is.

### 10. `ctx.fs` и sandbox

Если harness даёт виртуальную FS, строй граф только по видимому дереву или честно документируй «граф = host cwd». Опция `config.followSandbox: true` позже: копировать/указывать движок на overlay. В P2 достаточно теста «нет git-root → no-op».

### 11. Settings UI + toolOrder

`installSection` с тумблерами inject/autoSync. Если доступен `systemPrompt` toolOrder — поставь graph-tools **перед** grep/read в рекомендательном порядке (не ломай деплой, если API нет).

### 12. Игнорировать чтение сырого `graft/.graph/wiring.json` моделью

wiring.json огромный. В описании tools и skill: «не читай wiring.json, не читай весь INDEX.md — зови tools». Опционально: `tools/pre-execute` на read абсолютного пути внутри `graft/.graph/` → короткий отказ с подсказкой tool.

### 13. Языки и этот стек

DSH-плагины — TS/JS full-fidelity в движке. Задокументируй: Python/Go работают; неизвестные языки пропускаются. Не обещай 100% языков. Для `--lsp` (pyright, tsserver) — opt-in `config.lsp: false` по умолчанию (тяжёлый spawn).

### 14. Инвариант «граф не секретнее исходников»

`graft/` содержит выдержки кода. Нельзя заливать в облако, нельзя в телеметрию. Плагин не отправляет содержимое репо никуда. `--deep` — только на URL, который задал пользователь. Тест: хуки не содержат fetch/http.

### 15. Сосуществование с `dsh-web-automation`

Это другой пакет. Не импортируй web-seam. Можно в README: поиск в интернете — web-automation; поиск в репо — этот плагин. Разные tool names, конфликта нет.

### 16. Метрики без телеметрии наружу

Локальный счётчик в `$DSH_HOME/context-graph-stats.json`: graphReads vs sourceReads за сессию (аналог session-metrics движка). Только чтобы в README честно сказать «модель реально зовёт граф». Никакого POST.

### 17. Watcher (осторожно)

Chokidar на исходники → dirty flag без ожидания edit-tool. Выключен по умолчанию (шум, CPU, sandbox). Имеет смысл для TUI, где пользователь правит в IDE рядом с агентом.

### 18. Не изобретать второй граф

Если появится in-process API `@nanonets/graft` (library, не CLI) — замени spawn в `cli.ts`, сохрани те же tools. Не пиши свой tree-sitter-экстрактор, пока CLI покрывает языки.

## Критерий готовности P0

1. `dsh plugin --profile web add <пакет>` поднимает harness без ошибки.
2. В сессии с cwd = git-репо, где сделан `graft build`, модель видит 6 tools и короткий system section.
3. Промпт «как устроен auth / как устроен apply плагина» → модель зовёт `graph_find_code` или `graph_repo_map`, а не сразу широкий grep (проверь глазами или фикстурой tool-trace).
4. Без `graft` в PATH harness всё равно стартует; tools возвращают `GRAPH_CLI_MISSING`.
5. Две сессии, два репо — каждая получает свой git-root.

После P0 остановись, покажи diff и README. P1/P2 — по явной команде пользователя.
