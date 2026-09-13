# dsh-context-graph

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: your repo's **local context graph** (engine: the external [`@nanonets/graft`](https://www.npmjs.com/package/@nanonets/graft) CLI) as model tools + lifecycle context injection + fail-open.

The model gets exact `file:line` pointers, signatures without bodies, and caller/callee traces instead of blind grep/read exploration. Everything runs locally against the `@nanonets/graft` CLI; no index leaves the machine, no LLM is ever invoked by the plugin.

## Requirements

- Node.js **22.19+ / 24+** (ESM, TypeScript strict)
- DSH with a profile that boots Cordis bundles (web / headless / tui / …)
- The engine CLI, once per machine:

  ```sh
  npm i -g @nanonets/graft
  ```

  The plugin also falls back to `npx -y @nanonets/graft` (slow first call) and lets you pin a binary via `graphPath` / `GRAPH_CLI`. Without any CLI the plugin is fully inert (fail-open, see below).

## Install

```sh
dsh plugin --profile web add dsh-context-graph   # registry, when published
# or from a checkout:
dsh plugin --profile web add /path/to/dsh-graph-context
```

The `dsh plugin` forwarder links the package into the profile and appends `dsh-context-graph` to the profile's bundle stack automatically (it declares `dsh.bundle.patch`). Every boot re-applies the overlay from `cordis.patch.yml`.

> **Every clone runs its own build.** The graph is per-repo (the `graft/` directory, gitignored by the CLI). With `autoBuild: true` (default) the plugin starts `graft build` in the background at session start when a repo has no graph yet — structural indexing only, no LLM, no network.

## What it does

| Tool | Purpose |
| --- | --- |
| `graph_repo_map` | Orientation: directory clusters, hub symbols, global hotspots. First call in an unfamiliar repo. |
| `graph_find_code` | Question / symbol / error message → ranked `file:line` pointers (+ `source: true` inlines the crux). |
| `graph_file_api` | A file's signatures without reading its body. |
| `graph_trace_calls` | Callers (`direction: in`) or callees (`out`) of a symbol; `depth > 1` walks transitively (blast radius). |
| `graph_find_all` | Regex over indexed sources, ranked by coupling. |
| `graph_check_freshness` | Drift report after edits; `stale` → run `graft build`. |

Plus a lifecycle that mirrors the Claude-Code-style push cycle — the model
gets orientation *pushed* into context, not just pull tools:

- **System-prompt section** (5–15 stable lines): the graph exists, these are the native tools, call them before broad grep; fallback guidance when the graph/CLI is missing.
- **Session-start inject** (`agent/session-start`): the rendered repo map (byte-budgeted, default 4096 B) is queued for the *next* request via `agent.inject` — it never wakes the agent. If the repo has no `graft/` yet, one structural build starts detached under the repo lock and a short "being built" pointer is injected instead.
- **Prompt retrieval** (`agent/pre-step`): when a user prompt is ≥ `promptMinChars`, the plugin runs `graft ask … --json -n 3` (pointers only, no source) and appends the top hits as a short context message to the step. The same top hit is never re-injected in the same session/repo, and an identical prompt is not re-run through the CLI.
- **Blast radius after edits** (`tools/post-execute`): when an edit tool (`editToolNames`) accepts a source file (never `graft/`), the graph is marked dirty and — when the blast radius is short — "who depends on it" is appended via `additionalContexts`.
- **Turn-stop auto-sync** (`agent/turn-stopping`): if the graph is dirty when the turn stops, ONE structural `graft build` starts detached under the repo lock — without blocking the turn.
- **User-level skill**: on load the plugin installs `skills/graph/SKILL.md` into `$DSH_HOME` once (idempotent; a customized file is never overwritten), so the tool vocabulary is available to the model even before the first map inject.

Every channel is fail-open: no git, no CLI, no `graft/`, a timeout, or bad JSON leaves the agent loop untouched — a hook never throws into the loop.

P2a refines the push for local models, each behind its own flag:

- **Sourced retrieval by default** (`injectMode: sourced`): the pre-step pack inlines the top hit's ≤8-line source crux (`graft ask --source`), not just `file:line` — small models often skip the follow-up call, so the crux arrives up front. `pointers` keeps the compact Sonnet-style behavior; `map-only` disables pre-step retrieval entirely.
- **Nudge, not a ban** (`nudgeOnBlindSearch`): a wide `grep`/`glob` (no path narrowing) before any graph tool queues one short reminder for the next request — the search itself is never blocked.
- **Monorepo scope** (`scopeFromLastEdit`): after an edit, the next retrieval is scoped (`ask --in <top-level-dir>`) to the last edited file's directory. The hint is a *relative* path (the engine's basename weakness is corrected here).
- **Local metrics** (`metrics`): accepted graph-tool reads vs raw source reads per session land in `$DSH_HOME/context-graph-stats.json` — a local file only, nothing is ever POSTed (see Privacy below).
- **Wiring guard** (`guardWiringReads`, opt-in): a raw read of `graft/.graph/*` is denied with a pointer to the `graft_*` tools.

## Configuration

Defaults in the bundle overlay (`cordis.patch.yml`) enable the full stack; an empty `config: {}` row keeps everything. All fields:

| Key | Default | Meaning |
| --- | --- | --- |
| `tools` | `true` | Register the six `graph_*` tools. |
| `injectSessionMap` | `true` | Inject the repo map at session start. |
| `injectPromptHits` | `true` | (P1) retrieval hits for user prompts. |
| `injectBlastRadius` | `true` | (P1) blast radius after source edits. |
| `autoBuild` | `true` | Start `graft build` at session start when the repo has no graph. |
| `autoSync` | `true` | (P1) rebuild on turn-stop when dirty. |
| `maxInjectBytes` | `4096` | Hard byte ceiling for one injected context. |
| `promptMinChars` | `12` | (P1) minimum prompt length triggering retrieval. |
| `graphPath` | `''` | Explicit engine binary (path or PATH name). Empty → the `graft` binary on PATH → `npx` fallback. `GRAPH_CLI` env is honored. |
| `timeoutMs` | `8000` | Query timeout. |
| `buildTimeoutMs` | `20000` | Structural build timeout. |
| `deep` | `false` | LLM pass flag; hooks never use it — only explicit user commands may. |
| `editToolNames` | `["write","edit"]` | (P1) host tool names that mark the graph dirty. |
| `injectMode` | `sourced` | (P2a) pre-step retrieval shape: `sourced` (top hit with its ≤8-line crux + related pointers — the DSH default for local models), `pointers` (compact pointers only), or `map-only` (no pre-step retrieval; the session map is the only push). |
| `nudgeOnBlindSearch` | `true` | (P2a) one-time reminder when the model goes to a wide grep/glob before ever calling a graph tool. Never blocks. |
| `scopeFromLastEdit` | `false` | (P2a) scope the next pre-step `ask` to the top-level dir of the last edited file (monorepo benefit; off by default so single-package repos keep repo-wide retrieval). |
| `metrics` | `true` | (P2a) local per-session graph-vs-source counters in `$DSH_HOME/context-graph-stats.json`. Local only — never a network POST. |
| `guardWiringReads` | `false` | (P2a) deny raw reads of `graft/.graph/*` with a tool hint. The textual guidance already lives in the system section and skill; the hard guard is opt-in. |

User overlay (a patch replaces a row's **entire** config — restate every key you want to keep), e.g. from `cordis.yml.example`:

```yaml
- insert:
    - id: context-graph
      name: 'dsh-context-graph'
      inject: ['tools', 'systemPrompt']
      config:
        tools: true
        # …every other key restated…
        graphPath: '/usr/local/bin/graft'
        maxInjectBytes: 8192
```

## Fail-open contract

Hooks never throw into the agent loop and tools never reject: infrastructure problems become a stable `error` code inside the (closed) tool value.

| Code | Meaning | What the model should do |
| --- | --- | --- |
| `GRAPH_CLI_MISSING` | No engine CLI resolvable | Fall back to read/grep; hint suggests `npm i -g @nanonets/graft`. |
| `GRAPH_MISSING` | No `graft/` index from the session cwd | Wait for the background build / run `graft build`. |
| `GRAPH_TIMEOUT` | Query or build exceeded its budget | Retry once, then fall back. |
| `GRAPH_BAD_JSON` | CLI output was not parseable | Fall back; check CLI version. |
| `GRAPH_FAILED` | Any other spawn/CLI failure | Fall back to ordinary tools. |

No git repo → the plugin stays completely silent (no tool errors, no injects, no logs). Cross-session build coordination uses a per-repo lock file (`.dsh-context-graph-build.lock`) so N sessions starting on one repo start exactly one build; stale locks (older than the timeout + 30 s grace, dead pid) are stolen.

## Privacy & telemetry

- The CLI is spawned with an explicit minimal environment: `PATH`, `HOME`/`USERPROFILE` if set, and `DO_NOT_TRACK=1`. No API keys or ambient env are forwarded.
- Structural `graft build` makes no network calls. The optional LLM pass (`--deep`) is never triggered by the plugin.
- No telemetry from the plugin itself.
- **Invariant: the graph is never more secret than the sources.** `graft/` holds code excerpts; the plugin sends repo content nowhere — the hooks contain no network primitives at all (enforced by a static-scan test), and the `metrics` counters are written only to the local `$DSH_HOME`.

## Mutually exclusive with the engine's MCP server

Do **not** register the engine's MCP server alongside this plugin: the surfaces would overlap (the native `graph_*` tools vs the MCP-prefixed external names) and a duplicate tool set confuses the model and doubles index work. Pick one surface per profile — the native plugin is the recommended one (lifecycle hooks included).

## Languages & coexistence

- **Language coverage** — the engine is TypeScript/JavaScript full-fidelity in this stack; Python and Go are supported, and unknown languages are skipped gracefully. The plugin does not promise 100% language coverage — an unrecognized file simply does not produce graph nodes. (An optional LSP pass, e.g. pyright/tsserver, is *not* wired in P0–P2a; it would be a heavy opt-in spawn behind a future flag.)
- **vs `dsh-web-automation`** — that is a separate package for *web* search; this plugin is for *repo* search. Different tool names, no conflict; they can coexist in one profile.

## Troubleshooting

- **Tools report `GRAPH_CLI_MISSING`** — `npm i -g @nanonets/graft` (or set `graphPath`). The session continues normally without the graph.
- **`GRAPH_MISSING` persists after session start** — the background build may still be running (large repos); check `graft check`, or run `graft build` manually in the repo.
- **Two repos, two sessions** — each session resolves its own repo from its *own* session cwd (session header); graphs never cross repo roots. The session-start hook additionally requires the session cwd to be present — if it is not, it stays silent rather than guessing the server's launch directory (v0.1.1).
- **A stray `.ignore` file in the repo root** — the engine writes it (re-admits the git-ignored `graft/` cards to ripgrep search). It is an engine artifact, not this plugin's; add it to `.gitignore` if it bothers you.
- **Stale graph** — `graph_check_freshness` reports drift; `graft build` (structural) refreshes it.

## Roadmap

P0 (shipped): package + overlay + 6 tools + system-prompt section + session-start map inject + autoBuild + fail-open.
P1 (shipped, v0.2.0): prompt-hits retrieval (`agent/pre-step`), blast radius after edits (`tools/post-execute`), turn-stop autoSync, dirty tracking, user-level skill install, settings section (when the host mounts the provider).
P2a (shipped, v0.3.0): `injectMode` (sourced/pointers/map-only), blind-search nudge, monorepo scope-from-last-edit, local metrics, wiring read guard, privacy-invariant test.
P2b/P2c (each behind its own flag): host surfaces (compaction re-inject, subagent map, tool order), then heavy features (`graph_blast`, local `--deep` enrich, watcher, Code Mode).

See `roadmap.md` for gates and acceptance criteria.

## License

MIT — see [LICENSE](LICENSE).
