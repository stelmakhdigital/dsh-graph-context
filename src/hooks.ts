/**
 * Lifecycle hooks. P0 implements `agent/session-start`:
 *
 * - the repo has `graft/` — pull `graft map --json`, render it within the
 *   byte budget, and inject it for the agent's NEXT request (agent.inject is
 *   never a wake-up; an idle agent stays idle);
 * - the repo has no `graft/` yet — start one structural (no `--deep`, no
 *   network) `graft build` detached under the repo lock, and inject a short
 *   "graph not ready yet" pointer instead of blocking the UI.
 *
 * Everything is fail-open: no git, no CLI, timeout, or bad JSON leaves the
 * agent loop untouched (the invariant tested in the suite: a hook never
 * throws into the loop).
 *
 * P1 adds the remaining Claude-Code cycle:
 * - `agent/pre-step` (waterfall): if the user prompt is long enough, run
 *   `graft ask … --json -n 3` (no `--source`) and APPEND a short
 *   pointer-only context message to the step's admitted messages. The same
 *   top hit is never re-injected in the same (session, repo).
 * - `tools/post-execute` (waterfall): if an edit tool (config.editToolNames)
 *   accepted a source file (never `graft/`), mark the graph dirty and, when
 *   the blast radius is short, append it via `PostToolDecision
 *   .additionalContexts`.
 * - `agent/turn-stopping` (emit): if dirty, start ONE structural
 *   `graft build` detached under the repo lock, without blocking the turn.
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { GraphError, runGraphJson, spawnDetachedBuild } from './cli.ts'
import {
  renderBlastRadius,
  renderMap,
  renderNudge,
  renderPromptHits,
  renderPromptHitsSourced,
  type AskPayload,
  type CallsPayload,
  type MapPayload,
  type SkeletonPayload,
} from './format.ts'
import { resolveRepoAnchor, type RepoAnchor } from './repo.ts'
import { acquireBuildLock, hashPrompt, releaseBuildLock, SessionStateStore } from './session-state.ts'

/** The subset of plugin settings the hook layer consumes. */
export interface HooksConfig {
  /** Inject the repo map at session start. */
  injectSessionMap: boolean
  /** Start a structural build when the repo has no graft/ yet. */
  autoBuild: boolean
  /** Rebuild on turn-stop when dirty (P1). */
  autoSync: boolean
  /** Retrieval hits for user prompts (P1). */
  injectPromptHits: boolean
  /** Blast radius after source edits (P1). */
  injectBlastRadius: boolean
  /** Hard ceiling in bytes for one injected context. */
  maxInjectBytes: number
  /** Minimum prompt length triggering retrieval (P1). */
  promptMinChars: number
  /** Query timeout, ms. */
  timeoutMs: number
  /** Structural build timeout, ms. */
  buildTimeoutMs: number
  /** Explicit engine binary; empty = PATH order. */
  graphPath: string
  /** Host edit-tool names marking the graph dirty (P1). */
  editToolNames: string[]
  /** LLM pass flag; hooks never pass it to the CLI. */
  deep: boolean
  /** Pre-step retrieval shape (P2a). */
  injectMode: 'pointers' | 'sourced' | 'map-only'
  /** One-time blind-search reminder (P2a). */
  nudgeOnBlindSearch: boolean
  /** Scope the next ask to the last-edited file's top-level dir (P2a). */
  scopeFromLastEdit: boolean
  /** Whether tool calls feed the local counters (P2a). */
  metrics: boolean
  /** Deny raw reads of graft/.graph/* with a tool hint (P2a, opt-in). */
  guardWiringReads: boolean
}

export interface HooksDeps {
  /** Per-(session, repo) state. */
  state: SessionStateStore
  /** Spawn seam for the detached build (tests substitute a fake). */
  spawnBuild: typeof spawnDetachedBuild
  /** Release seam for the build lock (tests observe releases). */
  releaseLock?: (repoRoot: string) => void
  /** Plugin name for the injected message source. */
  pluginName: string
  logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  processCwd?: () => string
  /**
   * Metrics sink (P2a, spec #16): bump one local counter. Undefined when
   * `metrics` is off; the hooks never write files themselves, so tests can
   * substitute a spy. Must never throw into the loop.
   */
  recordMetric?: (sessionId: string, kind: 'graph' | 'source') => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the session header cwd defensively (a disposed agent may throw). */
function agentSessionCwd(agent: Agent): string | undefined {
  try {
    return agent.session?.header?.cwd
  } catch {
    return undefined
  }
}

function agentId(agent: Agent): string {
  try {
    return String(agent.id)
  } catch {
    return 'unknown-agent'
  }
}

/**
 * Queue model-facing context for the agent's next request. Guarded: a
 * disposed or non-injectable agent is skipped, never an exception.
 */
function injectSafe(agent: Agent, text: string, deps: HooksDeps): void {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: deps.pluginName },
    }))
  } catch (error) {
    deps.logger.warn(`dsh-context-graph: inject skipped (${errorMessage(error)})`)
  }
}

const MAP_INTRO = 'Repo context graph (built by dsh-context-graph; refresh with graft build after large edits):'

/**
 * One session-start pass for one agent. The caller wraps this in a promise
 * it does not await (the event is emit-mode; the loop must not wait).
 */
export async function handleSessionStart(
  agent: Agent,
  source: SessionStartSource,
  config: HooksConfig,
  deps: HooksDeps,
  runGraph: typeof runGraphJson,
): Promise<void> {
  if (!config.injectSessionMap) return
  // Resolve the repo from the session's OWN cwd. When the header carries no
  // cwd (a server process may not have populated it at this event), fail open
  // silently: falling back to process.cwd() would mean acting on the server's
  // launch directory — the wrong, possibly huge repo (observed in the wild:
  // a background graft build of the harness checkout itself). Per-turn tool
  // calls keep their process-cwd fallback; by then the header is populated.
  const sessionCwd = agentSessionCwd(agent)
  if (sessionCwd === undefined) return
  let anchor: RepoAnchor
  try {
    anchor = resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd())
  } catch {
    return
  }
  // No git repo: the plugin stays silent (documented fail-open).
  if (anchor.outsideGit) return
  const root = anchor.gitRoot
  if (root === undefined) return

  const sessionKey = agentId(agent)
  deps.state.get(sessionKey, root) // ensure the per-session state exists (P1 flags live here)

  if (anchor.graphDir === undefined) {
    if (!config.autoBuild) return
    const claim = acquireBuildLock(root, config.buildTimeoutMs)
    if (!claim.acquired) {
      // Another session/process is already building: just tell the model.
      injectSafe(agent,
        'The repo context graph is not built yet and a structural engine build is already running. '
        + 'If graph tools report GRAPH_MISSING, wait briefly and retry; until then prefer targeted reads over whole-repo grep.',
        deps)
      return
    }
    const handle = deps.spawnBuild(root, { graphPath: config.graphPath, buildTimeoutMs: config.buildTimeoutMs })
    if (handle.error !== undefined) {
      deps.logger.warn(`dsh-context-graph: autoBuild failed: ${handle.error}`)
      injectSafe(agent,
        'The repo context graph is not built yet and the background build could not start. '
        + 'Fall back to ordinary read/grep; run `graft build` manually to enable the graph_* tools.',
        deps)
      return
    }
    deps.logger.info(`dsh-context-graph: structural graft build started in ${root} (pid ${handle.pid ?? 'unknown'}, source ${source})`)
    void handle.exited?.then(() => {
      // The lock frees only when the build truly exits (including the
      // timeout kill), so a retry is safe right after.
      if (deps.releaseLock !== undefined) deps.releaseLock(root)
      else releaseBuildLock(root)
    })
    injectSafe(agent,
      'The repo context graph is being built in the background (structural graft build, no LLM). '
      + 'If graph_repo_map or graph_find_code report GRAPH_MISSING, the build is still running — retry shortly. '
      + 'Until it is ready, prefer targeted reads over whole-repo grep.',
      deps)
    return
  }

  // Graph exists: pull the map, render within budget, inject for next request.
  const dir = anchor.graphRepoRoot ?? root
  try {
    const { json, code } = await runGraph<MapPayload>(['map', '--json', dir], {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath,
    })
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: graft map exited ${code}; skipping session map inject`)
      return
    }
    injectSafe(agent, `${MAP_INTRO}\n${renderMap(json, config.maxInjectBytes)}`, deps)
  } catch (error) {
    if (error instanceof GraphError && error.code === 'GRAPH_CLI_MISSING') {
      // Documented: harness boots without the CLI; hooks stay silent here
      // because the system-prompt section already names the tools.
      return
    }
    deps.logger.warn(`dsh-context-graph: session map inject failed (${errorMessage(error)})`)
  }
}

/**
 * Shared guard for the P1 handlers: resolve the repo from the session's OWN
 * cwd. A missing header cwd (server context) means "stay silent" — never act
 * on the process cwd (see handleSessionStart for the field incident).
 */
function sessionAnchor(agent: Agent, deps: HooksDeps): RepoAnchor | undefined {
  const sessionCwd = agentSessionCwd(agent)
  if (sessionCwd === undefined) return undefined
  try {
    return resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd())
  } catch {
    return undefined
  }
}

/** Prompt text for retrieval: the last admitted message carrying text. */
function promptText(messages: readonly UserMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content
    if (content === undefined || !Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => block.text)
      .join('')
    if (text.length > 0) return text
  }
  return ''
}

/** The edited file path from an edit-tool argument shape (file_path/path). */
function editedFilePath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Pre-step retrieval (P1, waterfall): delegate downstream first, then — if
 * the prompt is long enough and the repo has a graph — run `graft ask`
 * (pointers only) and append ONE compact context message. Identical prompts
 * are memoized so they never hit the CLI twice; the same top hit is never
 * re-injected in this (session, repo). Fail-open at every step.
 */
export async function handlePreStep(
  payload: { agent: Agent; messages: readonly UserMessage[]; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
  config: HooksConfig,
  deps: HooksDeps,
  runGraph: typeof runGraphJson,
): Promise<PreStepDecision> {
  // Downstream waterfall: its errors are the chain's own business.
  const decision = await next()
  if (!config.injectPromptHits || config.injectMode === 'map-only') return decision
  if (decision.kind !== 'enter') return decision
  try {
    const prompt = promptText(decision.messages)
    if (prompt.length < config.promptMinChars) return decision
    const agent = payload.agent
    const anchor = sessionAnchor(agent, deps)
    if (anchor === undefined || anchor.outsideGit) return decision
    const root = anchor.gitRoot
    if (root === undefined || anchor.graphDir === undefined) return decision
    const sessionKey = agentId(agent)
    const dir = anchor.graphRepoRoot ?? root

    const promptHash = hashPrompt(prompt)
    const memoized = deps.state.lookupPromptHit(sessionKey, root, promptHash)
    if (memoized !== undefined && deps.state.isHitInjected(sessionKey, root, memoized)) {
      // Same prompt, same top hit, already in context: skip the CLI entirely.
      return decision
    }

    // Scope hint (P2a, spec #8): when enabled and a file was edited, narrow
    // the query to the top-level dir of that file (monorepo benefit). The
    // lastFile is a RELATIVE path by design — its first segment is the scope.
    const lastFile = config.scopeFromLastEdit
      ? deps.state.getLastFile(sessionKey, root)
      : undefined
    const scope = lastFile !== undefined && lastFile.includes('/')
      ? lastFile.slice(0, lastFile.indexOf('/'))
      : undefined
    const args: string[] = ['ask', prompt.slice(0, 1024), '--json', '-n', '3']
    if (config.injectMode === 'sourced') args.push('--source')
    if (scope !== undefined) args.push('--in', scope)
    args.push(dir)
    const { json, code } = await runGraph<AskPayload>(args, {
      cwd: dir, timeoutMs: config.timeoutMs, graphPath: config.graphPath, signal: payload.signal,
    })
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: pre-step ask exited ${code}; skipping`)
      return decision
    }
    const hits = Array.isArray(json.hits) ? json.hits : []
    const top = hits[0]
    if (top === undefined || typeof top !== 'object' || top === null) return decision
    const hitKey = `${typeof top.pointer === 'string' ? top.pointer : ''}\0${typeof top.title === 'string' ? top.title : ''}`
    deps.state.recordPromptHit(sessionKey, root, promptHash, hitKey)
    if (!deps.state.markHitInjected(sessionKey, root, hitKey)) return decision
    const rendered = config.injectMode === 'sourced'
      ? renderPromptHitsSourced(json, config.maxInjectBytes)
      : renderPromptHits(json, config.maxInjectBytes)
    if (rendered === '') return decision
    const message = createUserMessage({
      content: [{ type: 'text', text: rendered }],
      source: { kind: 'plugin', plugin: deps.pluginName },
    })
    return { ...decision, messages: [...decision.messages, message] }
  } catch (error) {
    if (error instanceof GraphError && error.code === 'GRAPH_CLI_MISSING') return decision
    deps.logger.error(`dsh-context-graph: pre-step hook failed (${errorMessage(error)})`)
    return decision
  }
}

/**
 * Blast radius for one edited file: its top-3 symbols' direct callers.
 * Per-symbol fail-open (a missing/partial graph degrades to fewer lines).
 */
async function blastRadiusForFile(
  relPath: string,
  dir: string,
  config: HooksConfig,
  runGraph: typeof runGraphJson,
): Promise<string> {
  const { json: skeleton, code } = await runGraph<SkeletonPayload>(
    ['skeleton', relPath, '--json', dir],
    { cwd: dir, timeoutMs: config.timeoutMs, graphPath: config.graphPath },
  )
  if (code !== 0) return ''
  const entries = Array.isArray(skeleton.entries) ? skeleton.entries.slice(0, 3) : []
  const symbols: Array<{ name: string; callers: Array<{ name?: string; path?: string; span?: string; relation?: string }> }> = []
  for (const entry of entries) {
    const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : undefined
    if (name === undefined) continue
    let callers: Array<{ name?: string; path?: string; span?: string; relation?: string }> = []
    try {
      const { json: calls } = await runGraph<CallsPayload>(
        ['callers', name, '--direction', 'in', '-d', '1', '--json', dir],
        { cwd: dir, timeoutMs: config.timeoutMs, graphPath: config.graphPath },
      )
      const match = Array.isArray(calls.matches) ? calls.matches[0] : undefined
      const hits = typeof match === 'object' && match !== null && Array.isArray(match.hits) ? match.hits : []
      callers = hits.map((hit) => ({
        name: typeof hit?.name === 'string' ? hit.name : undefined,
        path: typeof hit?.path === 'string' ? hit.path : undefined,
        span: typeof hit?.span === 'string' ? hit.span : undefined,
        relation: typeof hit?.relation === 'string' ? hit.relation : undefined,
      }))
    } catch {
      continue // one symbol's failure never sinks the whole blast
    }
    symbols.push({ name, callers })
  }
  return renderBlastRadius(relPath, symbols, config.maxInjectBytes)
}

/**
 * Where an accepted read/grep/glob call points (for local metrics, P2a):
 * `source` = raw repo material (counts against the graph), `nonSource` =
 * outside the repo or under `graft/` (the graph reading itself — never
 * counted), `unknown` = cannot be resolved (not counted).
 */
function readTargetKind(
  exec: ToolExecution,
  agent: Agent,
  anchor: RepoAnchor | undefined,
  deps: HooksDeps,
): 'source' | 'nonSource' | 'unknown' {
  if (anchor === undefined || anchor.outsideGit || anchor.gitRoot === undefined) return 'unknown'
  const root = anchor.gitRoot
  const args = typeof exec.arguments === 'object' && exec.arguments !== null
    ? exec.arguments as Record<string, unknown>
    : {}
  const readPath = typeof args.file_path === 'string' && args.file_path !== ''
    ? args.file_path
    : typeof args.path === 'string' && args.path !== ''
      ? args.path
      : undefined
  // A pathless grep/glob scans the whole workspace (the repo) — a source read.
  if (readPath === undefined) return exec.name === 'read' ? 'unknown' : 'source'
  const sessionCwd = agentSessionCwd(agent)
  if (sessionCwd === undefined) return 'unknown'
  const resolved = isAbsolute(readPath) ? readPath : resolve(sessionCwd, readPath)
  const rel = relative(root, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return 'nonSource'
  const graphDir = anchor.graphDir ?? join(root, 'graft')
  if (resolved === graphDir || resolved.startsWith(graphDir + '/')) return 'nonSource'
  return 'source'
}

/**
 * Post-execute (P1, waterfall): after an accepted edit of a source file
 * (never `graft/`), mark the graph dirty and, when short, append the blast
 * radius via `additionalContexts`. P2a adds local counters (graph reads vs
 * source reads) and the lastFile scope hint. Fail-open at every step.
 */
export async function handlePostExecute(
  exec: ToolExecution,
  _result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>,
  config: HooksConfig,
  deps: HooksDeps,
  runGraph: typeof runGraphJson,
): Promise<PostToolDecision> {
  const decision = await next()
  try {
    if (decision.kind !== 'accept') return decision
    const agent = exec.agent
    if (agent === undefined) return decision
    const sessionKey = agentId(agent)

    // ---- local metrics (P2a): count accepted reads, before the edit logic --
    if (config.metrics && deps.recordMetric !== undefined) {
      if (exec.name.startsWith('graph_')) {
        deps.recordMetric(sessionKey, 'graph')
      } else if (exec.name === 'read' || exec.name === 'grep' || exec.name === 'glob') {
        const kind = readTargetKind(exec, agent, sessionAnchor(agent, deps), deps)
        if (kind === 'source') deps.recordMetric(sessionKey, 'source')
      }
    }

    if (!config.editToolNames.includes(exec.name)) return decision
    const sessionCwd = agentSessionCwd(agent)
    if (sessionCwd === undefined) return decision
    const filePath = editedFilePath(exec.arguments)
    if (filePath === undefined) return decision
    const anchor = sessionAnchor(agent, deps)
    if (anchor === undefined || anchor.outsideGit) return decision
    const root = anchor.gitRoot
    if (root === undefined) return decision
    const resolved = isAbsolute(filePath) ? filePath : resolve(sessionCwd, filePath)
    const rel = relative(root, resolved)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return decision
    const graphDir = anchor.graphDir ?? join(root, 'graft')
    if (resolved === graphDir || resolved.startsWith(graphDir + '/')) return decision

    // A source edit inside the repo: the graph is dirty regardless of blast,
    // and the file becomes the monorepo scope hint for the next retrieval.
    deps.state.markDirty(sessionKey, root)
    deps.state.setLastFile(sessionKey, root, rel)
    if (!config.injectBlastRadius || anchor.graphDir === undefined) return decision
    const dir = anchor.graphRepoRoot ?? root
    const blast = await blastRadiusForFile(rel, dir, config, runGraph)
    if (blast === '') return decision
    const message = createUserMessage({
      content: [{ type: 'text', text: blast }],
      source: { kind: 'plugin', plugin: deps.pluginName },
    })
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] }
  } catch (error) {
    if (error instanceof GraphError && error.code === 'GRAPH_CLI_MISSING') return decision
    deps.logger.error(`dsh-context-graph: post-execute hook failed (${errorMessage(error)})`)
    return decision
  }
}

/** True when the search arguments narrow the scan to a subpath (not whole-repo). */
function isPathNarrowed(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false
  const path = (args as Record<string, unknown>).path
  return typeof path === 'string' && path.trim() !== ''
}

/**
 * Pre-execute (P2a, ordered waterfall): the plugin's pre-dispatch concerns.
 * - NUDGE (spec #2): once per (session, repo), when the model goes to a WIDE
 *   grep/glob (no path narrowing) without ever having called a graph tool,
 *   queue a short reminder for the next request. Never blocks — a reminder
 *   instead of a ban (blocking would break benchmarks and legit searches).
 * - WIRING GUARD (spec #12 optional part, opt-in): a read targeting
 *   `graft/.graph/*` is denied with a tool hint — the raw engine output is
 *   not the graph's interface.
 * Also counts accepted graph_* calls (the nudge precondition). Fail-open.
 */
export async function handlePreExecute(
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
  config: HooksConfig,
  deps: HooksDeps,
): Promise<PreToolDecision> {
  const decision = await next()
  try {
    // A downstream deny/ask is the chain's own decision — never touch it.
    if (decision.kind !== 'allow') return decision
    const agent = exec.agent
    if (agent === undefined) return decision
    const sessionCwd = agentSessionCwd(agent)
    if (sessionCwd === undefined) return decision
    const anchor = sessionAnchor(agent, deps)
    if (anchor === undefined || anchor.outsideGit) return decision
    const root = anchor.gitRoot
    if (root === undefined) return decision
    const sessionKey = agentId(agent)

    // An accepted graph_* call: the model has found the graph (nudge over).
    if (exec.name.startsWith('graph_')) deps.state.bumpGraphCalls(sessionKey, root)

    // ---- wiring read guard (opt-in): deny raw engine-output reads ----
    if (config.guardWiringReads && exec.name === 'read') {
      const args = typeof exec.arguments === 'object' && exec.arguments !== null
        ? exec.arguments as Record<string, unknown>
        : {}
      const readPath = typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
      if (readPath !== undefined) {
        const resolved = isAbsolute(readPath) ? readPath : resolve(sessionCwd, readPath)
        const graphInner = join(anchor.graphDir ?? join(root, 'graft'), '.graph')
        if (resolved === graphInner || resolved.startsWith(graphInner + '/')) {
          return {
            kind: 'deny',
            reason: 'Do not read raw graft/.graph files (wiring.json and friends) — they are engine internals, not the interface. '
              + 'Use the graph_* tools instead: graph_find_code, graph_repo_map, graph_trace_calls, graph_file_api, graph_find_all.',
          }
        }
      }
    }

    // ---- blind-search nudge: ONE reminder per (session, repo), never a block
    if (
      config.nudgeOnBlindSearch
      && (exec.name === 'grep' || exec.name === 'glob')
      && !isPathNarrowed(exec.arguments)
      && !deps.state.hasGraphCalls(sessionKey, root)
      && deps.state.markNudgeSent(sessionKey, root)
    ) {
      injectSafe(agent, renderNudge(), deps)
    }
    return decision
  } catch (error) {
    deps.logger.error(`dsh-context-graph: pre-execute hook failed (${errorMessage(error)})`)
    return decision
  }
}

/**
 * Turn-stop auto-sync (P1, emit): if the session marked the graph dirty,
 * start ONE structural build detached under the repo lock and clear the
 * flag. Never blocks the turn (spawn returns immediately); a held lock means
 * a build is already running, so nothing starts.
 */
export async function handleTurnStopping(
  agent: Agent,
  config: HooksConfig,
  deps: HooksDeps,
): Promise<void> {
  if (!config.autoSync) return
  const anchor = sessionAnchor(agent, deps)
  if (anchor === undefined || anchor.outsideGit) return
  const root = anchor.gitRoot
  if (root === undefined) return
  const sessionKey = agentId(agent)
  if (!deps.state.isDirty(sessionKey, root)) return
  const claim = acquireBuildLock(root, config.buildTimeoutMs)
  if (!claim.acquired) {
    deps.logger.info(`dsh-context-graph: turn-stop autoSync skipped (${claim.reason ?? 'lock held'})`)
    return
  }
  const handle = deps.spawnBuild(root, { graphPath: config.graphPath, buildTimeoutMs: config.buildTimeoutMs })
  // The flag clears either way: a failed spawn (e.g. CLI missing) would
  // otherwise retry — and warn — on every subsequent turn stop.
  deps.state.clearDirty(sessionKey, root)
  if (handle.error !== undefined) {
    deps.logger.warn(`dsh-context-graph: autoSync build failed: ${handle.error}`)
    if (deps.releaseLock !== undefined) deps.releaseLock(root)
    else releaseBuildLock(root)
    return
  }
  deps.logger.info(`dsh-context-graph: structural graft build started on turn-stop in ${root} (pid ${handle.pid ?? 'unknown'})`)
  void handle.exited?.then(() => {
    if (deps.releaseLock !== undefined) deps.releaseLock(root)
    else releaseBuildLock(root)
  })
}

/** Register all lifecycle hooks. Pure registrations; no work happens here. */
export function registerHooks(
  ctx: Context,
  config: HooksConfig,
  deps: HooksDeps,
  runGraph: typeof runGraphJson,
): void {
  if (config.injectSessionMap) {
    ctx.on('agent/session-start', (payload) => {
      // Emit-mode event: the listener must return synchronously. The graph
      // pull is detached so a slow CLI can never block the loop.
      void handleSessionStart(payload.agent, payload.source, config, deps, runGraph).catch((error: unknown) => {
        // The invariant: a hook never throws into the agent loop.
        deps.logger.error(`dsh-context-graph: session-start hook failed (${errorMessage(error)})`)
      })
    })
  }
  // Waterfall listeners return the decision; internal failures are caught
  // inside the handlers (fail-open) — only a DOWNSTREAM waterfall rejection
  // propagates, which is the chain's own behavior.
  ctx.on('agent/pre-step', (payload, next) => {
    return handlePreStep(payload, next, config, deps, runGraph)
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    return handlePreExecute(exec, next, config, deps)
  })
  ctx.on('tools/post-execute', (exec, result, next) => {
    return handlePostExecute(exec, result, next, config, deps, runGraph)
  })
  ctx.on('agent/turn-stopping', (payload) => {
    void handleTurnStopping(payload.agent, config, deps).catch((error: unknown) => {
      deps.logger.error(`dsh-context-graph: turn-stopping hook failed (${errorMessage(error)})`)
    })
  })
}
