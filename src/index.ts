/**
 * dsh-context-graph — native DeepSeek Harness plugin: local repo context
 * graph (engine: the external `@nanonets/graft` CLI) as tools + lifecycle inject + fail-open.
 *
 * Module form (function plugin): the loader imports this file, reads `name`
 * and `inject`, validates the row config against `Config` (Schemastery,
 * Standard Schema), and calls `apply(ctx, config)`.
 */
import type { Context, SettingsService } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { runGraphJson, spawnDetachedBuild } from './cli.ts'
import { registerHooks, type HooksConfig } from './hooks.ts'
import { recordToolCall } from './metrics.ts'
import { installSkill } from './skill.ts'
import { releaseBuildLock, SessionStateStore } from './session-state.ts'
import { buildGraphTools, TOOL_NAMES, type ToolsConfig } from './tools.ts'

/** Settings-UI namespace for the plugin's own section (lowercase hyphenated). */
const SETTINGS_NAMESPACE = 'context-graph'

/** Cordis plugin name (used in loader diagnostics and message sources). */
export const name = 'dsh-context-graph'

/** Services the loader must provide before apply() runs. */
export const inject = ['tools', 'systemPrompt']

/**
 * Plugin settings. Defaults = the full stack; an empty `config: {}` row
 * enables everything. The flags exist so deployments can benchmark cold vs
 * push vs pull and trim pieces without code edits.
 */
export interface Config {
  /** Register the six graph_* tools. */
  tools: boolean
  /** Inject the repo map at session start (SessionStart). */
  injectSessionMap: boolean
  /** Retrieval hits for user prompts (P1). */
  injectPromptHits: boolean
  /** Blast radius after source edits (P1). */
  injectBlastRadius: boolean
  /** Build graft/ at session start when the repo has none. */
  autoBuild: boolean
  /** Rebuild on turn-stop when dirty (P1). */
  autoSync: boolean
  /** Hard ceiling in bytes for one injected context per turn. */
  maxInjectBytes: number
  /** Minimum prompt length (chars) triggering retrieval (P1). */
  promptMinChars: number
  /** Explicit engine CLI binary; empty = PATH, then npx fallback. */
  graphPath: string
  /** Query timeout, ms. */
  timeoutMs: number
  /** Structural build timeout, ms. */
  buildTimeoutMs: number
  /** LLM pass; hooks never use it (explicit user commands only). */
  deep: boolean
  /** Host tool names whose success marks the graph dirty (P1). */
  editToolNames: string[]
  /**
   * Pre-step retrieval shape (P2a, spec #1). Local/small models often skip
   * the follow-up `ask --source`, so the DSH default is `sourced`: the top
   * hit arrives with its ≤8-line crux, not just file:line.
   * - `sourced`: top-1 hit with source crux + remaining pointers.
   * - `pointers`: compact pointers only (the Sonnet-style behavior).
   * - `map-only`: no pre-step retrieval at all (session map is the only push).
   */
  injectMode: 'pointers' | 'sourced' | 'map-only'
  /**
   * One-time reminder (P2a, spec #2) when the model goes to a wide
   * grep/glob before ever calling a graph tool. Never blocks the search.
   */
  nudgeOnBlindSearch: boolean
  /**
   * Scope the next pre-step `ask` to the top-level dir of the last edited
   * file (P2a, spec #8; monorepo benefit — off by default so single-package
   * repos keep repo-wide retrieval).
   */
  scopeFromLastEdit: boolean
  /**
   * Local per-session counters (P2a, spec #16) in
   * `$DSH_HOME/context-graph-stats.json`. Local only — never a network POST.
   */
  metrics: boolean
  /**
   * Deny raw reads of `graft/.graph/*` with a tool hint (P2a, spec #12
   * optional part). The textual guidance already lives in the system section
   * and the skill; the hard guard is opt-in.
   */
  guardWiringReads: boolean
}

/** Schemastery validation for {@link Config}; defaults live on the fields. */
export const Config: z<Config> = z.object({
  tools: z.boolean().default(true),
  injectSessionMap: z.boolean().default(true),
  injectPromptHits: z.boolean().default(true),
  injectBlastRadius: z.boolean().default(true),
  autoBuild: z.boolean().default(true),
  autoSync: z.boolean().default(true),
  maxInjectBytes: z.number().default(4096),
  promptMinChars: z.number().default(12),
  graphPath: z.string().default(''),
  timeoutMs: z.number().default(8000),
  buildTimeoutMs: z.number().default(20000),
  deep: z.boolean().default(false),
  editToolNames: z.array(z.string()).default(['write', 'edit']),
  // schemastery (v3.18.2) has no z.enum: a closed set of literals is a union of consts.
  injectMode: z.union([z.const('pointers'), z.const('sourced'), z.const('map-only')]).default('sourced'),
  nudgeOnBlindSearch: z.boolean().default(true),
  scopeFromLastEdit: z.boolean().default(false),
  metrics: z.boolean().default(true),
  guardWiringReads: z.boolean().default(false),
})

/**
 * Defensive normalization: the loader fills schema defaults, but a hand-built
 * row (or a future host) may still pass sparse values; the plugin must
 * behave identically either way.
 */
export function normalizeConfig(raw: Partial<Config> | null | undefined): Config {
  const source = raw ?? {}
  const out: Config = {
    tools: source.tools ?? true,
    injectSessionMap: source.injectSessionMap ?? true,
    injectPromptHits: source.injectPromptHits ?? true,
    injectBlastRadius: source.injectBlastRadius ?? true,
    autoBuild: source.autoBuild ?? true,
    autoSync: source.autoSync ?? true,
    maxInjectBytes: positiveInt(source.maxInjectBytes, 4096),
    promptMinChars: positiveInt(source.promptMinChars, 12),
    graphPath: typeof source.graphPath === 'string' ? source.graphPath : '',
    timeoutMs: positiveInt(source.timeoutMs, 8000),
    buildTimeoutMs: positiveInt(source.buildTimeoutMs, 20000),
    deep: source.deep ?? false,
    editToolNames: Array.isArray(source.editToolNames)
      ? source.editToolNames.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      : ['write', 'edit'],
    injectMode: source.injectMode === 'pointers' || source.injectMode === 'sourced' || source.injectMode === 'map-only'
      ? source.injectMode
      : 'sourced',
    nudgeOnBlindSearch: source.nudgeOnBlindSearch ?? true,
    scopeFromLastEdit: source.scopeFromLastEdit ?? false,
    metrics: source.metrics ?? true,
    guardWiringReads: source.guardWiringReads ?? false,
  }
  return out
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

/**
 * Short, stable system-prompt pointer: the graph exists, these are the
 * native tools, and blind grep-before-graph is discouraged. Deliberately a
 * few lines — the FULL map is delivered by the session-start inject, and a
 * megabyte INDEX.md must never land in the system prompt.
 */
function systemPromptSection(config: Config): string {
  return [
    'Repo context graph (dsh-context-graph) is available for this workspace.',
    `Native tools: ${TOOL_NAMES.repoMap} (orientation), ${TOOL_NAMES.findCode} (question/symbol/error to file:line), `
      + `${TOOL_NAMES.fileApi} (file signatures without bodies), ${TOOL_NAMES.traceCalls} (callers/callees, depth for blast radius), `
      + `${TOOL_NAMES.findAll} (ranked regex), ${TOOL_NAMES.checkFreshness} (drift).`,
    'Before broad grep/read, call graph_repo_map (unfamiliar repo) or graph_find_code (a concrete question).',
    'After larger edits, call graph_check_freshness; on drift run `graft build` (structural, no LLM).',
    'Never read graft/.graph/wiring.json or the full graft/INDEX.md — the tools are the interface.',
    `If a graph tool reports GRAPH_MISSING or GRAPH_CLI_MISSING, fall back to ordinary read/grep${config.tools ? '' : ''} and note the graph is unavailable.`,
  ].join('\n')
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger

  // ---- tools ---------------------------------------------------------------
  if (config.tools) {
    const toolsConfig: ToolsConfig = {
      graphPath: config.graphPath,
      timeoutMs: config.timeoutMs,
      maxInjectBytes: config.maxInjectBytes,
    }
    const tools = buildGraphTools(toolsConfig, {
      runGraphJson,
      onNpxFallback: (note) => logger.warn(`dsh-context-graph: ${note}`),
    })
    ctx.tools.register(tools.findCode)
    ctx.tools.register(tools.fileApi)
    ctx.tools.register(tools.traceCalls)
    ctx.tools.register(tools.findAll)
    ctx.tools.register(tools.repoMap)
    ctx.tools.register(tools.checkFreshness)
  }

  // ---- system prompt pointer ------------------------------------------------
  ctx.systemPrompt.section({
    name: 'plugin:dsh-context-graph',
    order: 1490,
    text: systemPromptSection(config),
  })

  // ---- lifecycle hooks (P0: session-start map inject + autoBuild) ----------
  const state = new SessionStateStore()
  const hooksConfig: HooksConfig = {
    injectSessionMap: config.injectSessionMap,
    injectPromptHits: config.injectPromptHits,
    injectBlastRadius: config.injectBlastRadius,
    autoBuild: config.autoBuild,
    autoSync: config.autoSync,
    maxInjectBytes: config.maxInjectBytes,
    promptMinChars: config.promptMinChars,
    timeoutMs: config.timeoutMs,
    buildTimeoutMs: config.buildTimeoutMs,
    graphPath: config.graphPath,
    editToolNames: config.editToolNames,
    deep: config.deep,
    injectMode: config.injectMode,
    nudgeOnBlindSearch: config.nudgeOnBlindSearch,
    scopeFromLastEdit: config.scopeFromLastEdit,
    metrics: config.metrics,
    guardWiringReads: config.guardWiringReads,
  }
  registerHooks(ctx, hooksConfig, {
    state,
    spawnBuild: spawnDetachedBuild,
    releaseLock: (repoRoot) => releaseBuildLock(repoRoot),
    pluginName: name,
    logger,
    recordMetric: config.metrics
      ? (sessionId, kind) => { recordToolCall(sessionId, kind) }
      : undefined,
  }, runGraphJson)

  // ---- settings section (only if the host mounts the settings provider) ----
  // The web/headless bundles may not expose `settings`; the spec is explicit:
  // use it when present, otherwise the YAML config row is the sole surface.
  // NOTE: the host's guarded context THROWS on accessing an undeclared
  // service (it is not simply undefined), so the read itself must be guarded.
  let settingsService: SettingsService | undefined
  try {
    settingsService = ctx.settings
  } catch {
    settingsService = undefined
  }
  if (settingsService !== undefined && typeof settingsService.installSection === 'function') {
    try {
      settingsService.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: () => { /* the YAML row remains authoritative in P1 */ },
        onChange: () => { /* config is read once at apply; flags are static */ },
      })
    } catch (error) {
      // Fail-soft: a settings wiring problem must never break plugin load.
      logger.warn(`dsh-context-graph: settings section skipped (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  // ---- user-level skill install (idempotent, fail-open) ---------------------
  const skill = installSkill({ logger })
  if (skill.ok && skill.path !== undefined) {
    logger.info(`dsh-context-graph: skill ready at ${skill.path}`)
  }

  logger.info(`dsh-context-graph: loaded (tools=${config.tools}, sessionMap=${config.injectSessionMap}, autoBuild=${config.autoBuild}, promptHits=${config.injectPromptHits}/${config.injectMode}, blast=${config.injectBlastRadius}, autoSync=${config.autoSync}, nudge=${config.nudgeOnBlindSearch}, scope=${config.scopeFromLastEdit}, metrics=${config.metrics}, guardWiring=${config.guardWiringReads})`)
}

// Re-exported for consumers that compose the plugin programmatically (e.g.
// headless hosts building the tool set without a Cordis context).
export { buildGraphTools, TOOL_NAMES }
export type { ToolsConfig, ToolsDeps } from './tools.ts'
export type { HooksConfig, HooksDeps } from './hooks.ts'
export { SessionStateStore } from './session-state.ts'
export type { Agent as DshAgent } from '@deepseek-ai/dsh-agent'
