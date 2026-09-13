/**
 * The six model-facing graph tools.
 *
 * Names use the project's own `graph_*` vocabulary (owner decision
 * 2026-09-13: the token "graft" is forbidden in our naming) so AGENTS.md,
 * skills, and the model agree. Every tool resolves the repo from
 * the SESSION cwd (exec.agent → session header → process.cwd fallback),
 * returns one closed canonical JSON value (additionalProperties: false),
 * and fails soft: infrastructure problems become a stable `error` code,
 * never a thrown error out of the tool body.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GraphError, runGraphJson } from './cli.ts'
import {
  formatPointer,
  parsePointer,
  renderCheck,
  renderMap,
  type CheckPayload,
  type MapDir,
  type MapHotspot,
  type MapPayload,
} from './format.ts'
import { resolveRepoAnchor, type RepoAnchor } from './repo.ts'

/** Plugin tool-name vocabulary (stable contract with skills/AGENTS.md). */
export const TOOL_NAMES = {
  findCode: 'graph_find_code',
  fileApi: 'graph_file_api',
  traceCalls: 'graph_trace_calls',
  findAll: 'graph_find_all',
  repoMap: 'graph_repo_map',
  checkFreshness: 'graph_check_freshness',
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

/** Settings the tool layer needs. */
export interface ToolsConfig {
  /** Explicit engine binary; empty = PATH, then npx fallback. */
  graphPath: string
  /** Query timeout, ms. */
  timeoutMs: number
  /** Hard ceiling for one tool-rendered context (bytes). */
  maxInjectBytes: number
}

export interface ToolsDeps {
  /** Spawn seam (tests substitute a fake runner). */
  runGraphJson: typeof runGraphJson
  /** Process-cwd fallback when the session header has none. */
  processCwd?: () => string
  /** Cold-start notice for the npx fallback. */
  onNpxFallback?: (note: string) => void
}

/** Canonical failure value every tool may return. */
export interface ToolFailure {
  ok: false
  error: string
  hint?: string
}

const CLI_MISSING_HINT = 'npm i -g @nanonets/graft'

/**
 * Run one query against the resolved repo. Concentrates the shared
 * fail-open path: missing CLI, missing graph, spawn errors, bad JSON.
 */
async function withGraph<T, J>(
  anchor: RepoAnchor,
  config: ToolsConfig,
  deps: ToolsDeps,
  signal: AbortSignal | undefined,
  buildArgs: (dir: string) => readonly string[],
  interpret: (json: J, code: number, dir: string) => T,
): Promise<T | ToolFailure> {
  const dir = anchor.graphRepoRoot ?? anchor.gitRoot ?? anchor.cwd
  if (anchor.graphDir === undefined) {
    return {
      ok: false,
      error: 'GRAPH_MISSING',
      hint: `no graft/ index found from ${anchor.cwd}; run: graft build${anchor.gitRoot !== undefined ? ` (in ${anchor.gitRoot})` : ''}`,
    }
  }
  try {
    const { json, code, result } = await deps.runGraphJson<J>(buildArgs(dir), {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      graphPath: config.graphPath,
    })
    if (result.viaNpx) deps.onNpxFallback?.('graft CLI resolved via npx (cold start); install globally: npm i -g @nanonets/graft')
    return interpret(json, code, dir)
  } catch (error) {
    if (error instanceof GraphError) {
      return {
        ok: false,
        error: error.code,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
      }
    }
    return {
      ok: false,
      error: 'GRAPH_FAILED',
      ...(error instanceof Error ? { hint: error.message } : {}),
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Clamp an optional integer into [min, max] with a default. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function stringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item)
    if (out.length >= cap) break
  }
  return out
}

/** The shared cwd-resolution head of every tool body. */
function anchorFromExec(exec: { agent?: { session?: { header?: { cwd?: string } } } }, deps: ToolsDeps): RepoAnchor {
  const sessionCwd = exec.agent?.session?.header?.cwd
  return resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd())
}

// ---------------------------------------------------------------------------
// graph_find_code
// ---------------------------------------------------------------------------

interface FindCodeHit {
  path: string
  line?: number
  endLine?: number
  symbol?: string
  kind?: string
  snippet?: string
  score?: number
}

const findCodeHitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    line: { type: 'integer' },
    endLine: { type: 'integer' },
    symbol: { type: 'string' },
    kind: { type: 'string' },
    snippet: { type: 'string' },
    score: { type: 'number' },
  },
} as const

/** Rank graph nodes for a question/symbol/error and return exact file:line. */
export function buildFindCodeTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.findCode,
    description:
      'Locate code by question, symbol, or error message using the repo context graph. '
      + 'Call this BEFORE broad grep/read when orienting in the repo; returns ranked pointers (file:line) '
      + 'with crux snippets. Set source=true to inline the defining source at each hit.',
    parameters: {
      query: { type: 'string', required: true, description: 'Question, symbol, or error message.' },
      source: { type: 'boolean', description: 'Inline source crux at each hit (default false = pointers only).' },
      limit: { type: 'integer', description: 'Max hits, 1-10 (default 3).' },
      scope: { type: 'string', description: 'Path prefix to narrow the search (repo-relative).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          mode: { type: 'string' },
          hits: { type: 'array', items: findCodeHitSchema },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${record.error ?? ''} ${typeof record.hint === 'string' ? `— ${record.hint}` : ''}`.trim() }]
        }
        const hits = Array.isArray(record.hits) ? (record.hits as unknown as FindCodeHit[]) : []
        if (hits.length === 0) return [{ type: 'text', text: 'No graph hits for that query. Try graph_repo_map for orientation or graph_check_freshness.' }]
        const lines = hits.map((hit) => {
          const where = formatPointer({
            path: hit.path,
            ...(hit.line !== undefined ? { startLine: hit.line } : {}),
            ...(hit.endLine !== undefined ? { endLine: hit.endLine } : {}),
          })
          const who = hit.symbol !== undefined ? `${hit.symbol}${hit.kind !== undefined ? ` (${hit.kind})` : ''}` : undefined
          const score = hit.score !== undefined ? ` [${hit.score.toFixed(2)}]` : ''
          const body = hit.snippet !== undefined && hit.snippet !== '' ? `\n  ${hit.snippet}` : ''
          return `- ${who !== undefined ? `${who} @ ` : ''}${where}${score}${body}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const limit = clampInt(args.limit, 1, 10, 3)
      const query = args.query.trim()
      if (query === '') return { ok: false, error: 'GRAPH_BAD_ARGS', hint: 'query must be non-empty' }
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => {
          const parts: string[] = ['ask', query, '--json', '-n', String(limit)]
          if (args.source === true) parts.push('--source')
          if (args.scope !== undefined && args.scope.trim() !== '') parts.push('--in', args.scope.trim())
          parts.push(dir)
          return parts
        },
        (json) => {
          const payload = asRecord(json) ?? {}
          const rawHits = Array.isArray(payload.hits) ? payload.hits : []
          const hits: FindCodeHit[] = []
          for (const raw of rawHits) {
            const hit = asRecord(raw)
            if (hit === undefined) continue
            const pointer = typeof hit.pointer === 'string' ? parsePointer(hit.pointer) : undefined
            if (pointer === undefined) continue
            const title = typeof hit.title === 'string' ? hit.title : ''
            const [symbolName, symbolKind] = title.split(' · ')
            hits.push({
              path: pointer.path,
              ...(pointer.startLine !== undefined ? { line: pointer.startLine } : {}),
              ...(pointer.endLine !== undefined ? { endLine: pointer.endLine } : {}),
              ...(symbolName !== undefined && symbolName !== '' ? { symbol: symbolName } : {}),
              ...(symbolKind !== undefined && symbolKind !== '' ? { kind: symbolKind } : {}),
              ...(typeof hit.snippet === 'string' && hit.snippet !== '' ? { snippet: hit.snippet } : {}),
              ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
            })
            if (hits.length >= limit) break
          }
          return {
            ok: true,
            ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}),
            hits,
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// graph_file_api
// ---------------------------------------------------------------------------

interface FileApiEntry {
  name: string
  kind?: string
  span?: string
  signature?: string
}

const fileApiEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    kind: { type: 'string' },
    span: { type: 'string' },
    signature: { type: 'string' },
  },
} as const

/** Signatures-only view of one file (its API surface) without file bodies. */
export function buildFileApiTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.fileApi,
    description:
      'Show a file\'s API surface — exported/local signatures with line spans, no bodies. '
      + 'Cheaper than read when you only need to know what a file declares before calling into it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Repo-relative file path (or unique basename).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          file: { type: 'string' },
          entries: { type: 'array', items: fileApiEntrySchema },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${typeof record.hint === 'string' ? record.hint : ''}`.trim() }]
        }
        const entries = Array.isArray(record.entries) ? (record.entries as unknown as FileApiEntry[]) : []
        if (entries.length === 0) return [{ type: 'text', text: typeof record.file === 'string' ? `No indexed symbols for ${record.file}.` : 'No indexed symbols.' }]
        const lines = [`${record.file ?? 'file'} API:`]
        for (const entry of entries) {
          const span = entry.span !== undefined ? ` @${entry.span}` : ''
          const signature = entry.signature !== undefined ? ` — ${entry.signature}` : ''
          lines.push(`- ${entry.name}${entry.kind !== undefined ? ` (${entry.kind})` : ''}${span}${signature}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const path = args.path.trim()
      if (path === '') return { ok: false, error: 'GRAPH_BAD_ARGS', hint: 'path must be non-empty' }
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => ['skeleton', path, '--json', dir],
        (json) => {
          const payload = asRecord(json) ?? {}
          const rawEntries = Array.isArray(payload.entries) ? payload.entries : []
          const entries: FileApiEntry[] = []
          for (const raw of rawEntries) {
            const entry = asRecord(raw)
            if (entry === undefined || typeof entry.name !== 'string') continue
            entries.push({
              name: entry.name,
              ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
              ...(typeof entry.span === 'string' ? { span: entry.span } : {}),
              ...(typeof entry.signature === 'string' ? { signature: entry.signature } : {}),
            })
            if (entries.length >= 40) break
          }
          return {
            ok: true,
            ...(typeof payload.file === 'string' ? { file: payload.file } : {}),
            entries,
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// graph_trace_calls
// ---------------------------------------------------------------------------

interface TraceHit {
  name: string
  path?: string
  span?: string
  relation?: string
  depth?: number
}

const traceHitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    path: { type: 'string' },
    span: { type: 'string' },
    relation: { type: 'string' },
    depth: { type: 'integer' },
  },
} as const

/** Walk call edges: who calls a symbol (in), or what it calls (out). */
export function buildTraceCallsTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.traceCalls,
    description:
      'Trace call edges of a symbol: direction=in returns its callers, direction=out its callees; '
      + 'depth>1 walks transitively for blast radius. Use instead of manual grep for "who uses X".',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Bare name, qualified (Class.method), or package-qualified (pkg.Fn).' },
      direction: { type: 'string', enum: ['in', 'out'], description: 'in = callers (default), out = callees.' },
      depth: { type: 'integer', description: 'Transitive hops, 1-6 (default 1).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          root: { type: 'string' },
          direction: { type: 'string' },
          hits: { type: 'array', items: traceHitSchema },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${typeof record.hint === 'string' ? record.hint : ''}`.trim() }]
        }
        const hits = Array.isArray(record.hits) ? (record.hits as unknown as TraceHit[]) : []
        if (hits.length === 0) return [{ type: 'text', text: `No call edges found for ${typeof record.root === 'string' ? record.root : 'that symbol'}.` }]
        const lines = [`${record.root ?? '?'} (${record.direction ?? 'in'}):`]
        for (const hit of hits) {
          const where = hit.path !== undefined ? `${hit.path}${hit.span !== undefined ? `:${hit.span}` : ''}` : '?'
          const depth = typeof hit.depth === 'number' && hit.depth > 1 ? ` (depth ${hit.depth})` : ''
          lines.push(`- ${hit.name} @ ${where}[${hit.relation ?? 'calls'}]${depth}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const symbol = args.symbol.trim()
      if (symbol === '') return { ok: false, error: 'GRAPH_BAD_ARGS', hint: 'symbol must be non-empty' }
      const direction = args.direction === 'out' ? 'out' : 'in'
      const depth = clampInt(args.depth, 1, 6, 1)
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => ['callers', symbol, '--direction', direction, '-d', String(depth), '--json', dir],
        (json) => {
          const payload = asRecord(json) ?? {}
          const matches = Array.isArray(payload.matches) ? payload.matches : []
          const hits: TraceHit[] = []
          let root: string | undefined
          for (const raw of matches) {
            const match = asRecord(raw)
            if (match === undefined) continue
            const symbolRecord = asRecord(match.symbol)
            if (root === undefined && symbolRecord !== undefined && typeof symbolRecord.name === 'string') {
              root = symbolRecord.name
            }
            const rawHits = Array.isArray(match.hits) ? match.hits : []
            for (const rawHit of rawHits) {
              const hit = asRecord(rawHit)
              if (hit === undefined || typeof hit.name !== 'string') continue
              hits.push({
                name: hit.name,
                ...(typeof hit.path === 'string' ? { path: hit.path } : {}),
                ...(typeof hit.span === 'string' ? { span: hit.span } : {}),
                ...(typeof hit.relation === 'string' ? { relation: hit.relation } : {}),
                ...(typeof hit.depth === 'number' ? { depth: hit.depth } : {}),
              })
              if (hits.length >= 40) break
            }
            if (hits.length >= 40) break
          }
          return {
            ok: true,
            ...(root !== undefined ? { root } : { root: symbol }),
            direction,
            hits,
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// graph_find_all
// ---------------------------------------------------------------------------

interface FindAllMatch {
  path?: string
  symbol?: string
  line?: number
  text?: string
}

const findAllMatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    symbol: { type: 'string' },
    line: { type: 'integer' },
    text: { type: 'string' },
  },
} as const

const FIND_ALL_CAP = 30

/** Regex search over graph-indexed files, ranked by coupling. */
export function buildFindAllTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.findAll,
    description:
      'Regex search across the graph-indexed source files, hits grouped by enclosing symbol and ranked '
      + 'by coupling. Prefer over raw grep for code that is already in the graph; it also reports which file/symbol owns each hit.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regex pattern (or literal string).' },
      path: { type: 'string', description: 'Narrow to files under this repo-relative prefix.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          totalHits: { type: 'integer' },
          filesSearched: { type: 'integer' },
          matches: { type: 'array', items: findAllMatchSchema },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${typeof record.hint === 'string' ? record.hint : ''}`.trim() }]
        }
        const matches = Array.isArray(record.matches) ? (record.matches as unknown as FindAllMatch[]) : []
        if (matches.length === 0) {
          return [{ type: 'text', text: `No matches in ${typeof record.filesSearched === 'number' ? record.filesSearched : 'the'} indexed file(s).` }]
        }
        const lines: string[] = []
        let currentPath: string | undefined
        for (const match of matches) {
          if (match.path !== undefined && match.path !== currentPath) {
            currentPath = match.path
            lines.push(`### ${currentPath}${match.symbol !== undefined ? ` · ${match.symbol}` : ''}`)
          }
          lines.push(`- L${match.line ?? '?'}: ${match.text ?? ''}`)
        }
        if (typeof record.totalHits === 'number' && record.totalHits > matches.length) {
          lines.push(`… (showing ${matches.length} of ${record.totalHits} matches)`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const pattern = args.pattern
      if (pattern.trim() === '') return { ok: false, error: 'GRAPH_BAD_ARGS', hint: 'pattern must be non-empty' }
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => {
          const parts: string[] = ['grep', pattern, '--json']
          if (args.path !== undefined && args.path.trim() !== '') parts.push('--in', args.path.trim())
          parts.push(dir)
          return parts
        },
        (json) => {
          const payload = asRecord(json) ?? {}
          const groups = Array.isArray(payload.groups) ? payload.groups : []
          const matches: FindAllMatch[] = []
          for (const rawGroup of groups) {
            const group = asRecord(rawGroup)
            if (group === undefined) continue
            const groupPath = typeof group.path === 'string' ? group.path : undefined
            const symbol = asRecord(group.symbol)
            const symbolName = symbol !== undefined && typeof symbol.name === 'string' ? symbol.name : undefined
            const rawHits = Array.isArray(group.hits) ? group.hits : []
            for (const rawHit of rawHits) {
              const hit = asRecord(rawHit)
              if (hit === undefined) continue
              matches.push({
                ...(groupPath !== undefined ? { path: groupPath } : {}),
                ...(symbolName !== undefined ? { symbol: symbolName } : {}),
                ...(typeof hit.line === 'number' ? { line: hit.line } : {}),
                ...(typeof hit.text === 'string' ? { text: hit.text } : {}),
              })
              if (matches.length >= FIND_ALL_CAP) break
            }
            if (matches.length >= FIND_ALL_CAP) break
          }
          return {
            ok: true,
            ...(typeof payload.totalHits === 'number' ? { totalHits: payload.totalHits } : {}),
            ...(typeof payload.filesSearched === 'number' ? { filesSearched: payload.filesSearched } : {}),
            matches,
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// graph_repo_map
// ---------------------------------------------------------------------------

interface RepoMapDir {
  path: string
  files?: number
  symbols?: number
  hubs: string[]
}

interface RepoMapHotspot {
  name: string
  path?: string
  inDegree?: number
}

const repoMapDirSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    files: { type: 'integer' },
    symbols: { type: 'integer' },
    hubs: { type: 'array', items: { type: 'string' } },
  },
} as const

const repoMapHotspotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    path: { type: 'string' },
    inDegree: { type: 'integer' },
  },
} as const

/** Token-budgeted repo orientation: directory clusters, hubs, hotspots. */
export function buildRepoMapTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.repoMap,
    description:
      'Orient in the repo: directory clusters with their hub symbols and global hotspots, token-budgeted. '
      + 'Call this first when entering an unfamiliar repo, instead of listing/reading everything.',
    parameters: {
      maxDirs: { type: 'integer', description: 'Max directory entries, 4-64 (default 16).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          totals: {
            type: 'object',
            additionalProperties: false,
            properties: {
              files: { type: 'integer' },
              symbols: { type: 'integer' },
              edges: { type: 'integer' },
              languages: { type: 'array', items: { type: 'string' } },
            },
          },
          dirs: { type: 'array', items: repoMapDirSchema },
          hotspots: { type: 'array', items: repoMapHotspotSchema },
          dropped: { type: 'integer' },
          mapText: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${typeof record.hint === 'string' ? record.hint : ''}`.trim() }]
        }
        const mapText = typeof record.mapText === 'string' && record.mapText !== ''
          ? record.mapText
          : 'No map entries (empty graph?). Run graft build.'
        return [{ type: 'text', text: mapText }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const maxDirs = clampInt(args.maxDirs, 4, 64, 16)
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => ['map', '--max-dirs', String(maxDirs), '--json', dir],
        (json) => {
          const payload = json as MapPayload
          const totals = asRecord(payload.totals)
          const dirs: RepoMapDir[] = []
          const rawDirs = Array.isArray(payload.dirs) ? payload.dirs : []
          for (const rawDir of rawDirs) {
            const dir = rawDir as MapDir
            if (typeof dir !== 'object' || dir === null || typeof dir.path !== 'string') continue
            const hubs = Array.isArray(dir.hubs)
              ? dir.hubs.filter((hub): hub is { name?: string } => typeof hub === 'object' && hub !== null && typeof hub.name === 'string').map((hub) => hub.name as string)
              : []
            dirs.push({
              path: dir.path,
              ...(typeof dir.files === 'number' ? { files: dir.files } : {}),
              ...(typeof dir.symbols === 'number' ? { symbols: dir.symbols } : {}),
              hubs,
            })
          }
          const hotspots: RepoMapHotspot[] = []
          const rawHotspots = Array.isArray(payload.hotspots) ? payload.hotspots : []
          for (const hotspot of rawHotspots) {
            if (typeof hotspot !== 'object' || hotspot === null || typeof hotspot.name !== 'string') continue
            hotspots.push({
              name: hotspot.name,
              ...(typeof hotspot.path === 'string' ? { path: hotspot.path } : {}),
              ...(typeof hotspot.inDegree === 'number' ? { inDegree: hotspot.inDegree } : {}),
            })
            if (hotspots.length >= 10) break
          }
          const mapText = renderMap(payload, config.maxInjectBytes)
          return {
            ok: true,
            ...(totals !== undefined
              ? {
                totals: {
                  ...(typeof totals.files === 'number' ? { files: totals.files } : {}),
                  ...(typeof totals.symbols === 'number' ? { symbols: totals.symbols } : {}),
                  ...(typeof totals.edges === 'number' ? { edges: totals.edges } : {}),
                  ...(Array.isArray(totals.languages) ? { languages: stringArray(totals.languages, 8) } : {}),
                },
              }
              : {}),
            dirs,
            hotspots,
            ...(typeof payload.dropped === 'number' ? { dropped: payload.dropped } : {}),
            mapText,
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// graph_check_freshness
// ---------------------------------------------------------------------------

interface FreshnessDrift {
  added: string[]
  removed: string[]
  changed: string[]
  stale: string[]
}

const driftSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    added: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    changed: { type: 'array', items: { type: 'string' } },
    stale: { type: 'array', items: { type: 'string' } },
  },
} as const

const DRIFT_CAP = 20

/** Drift report: is the graph up to date with the working tree? */
export function buildCheckFreshnessTool(config: ToolsConfig, deps: ToolsDeps) {
  return defineTool({
    name: TOOL_NAMES.checkFreshness,
    description:
      'Check whether the context graph is stale relative to the code (drift report). '
      + 'Call after larger edits, or when graph results look off; a stale graph needs `graft build`.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          fresh: { type: 'boolean' },
          drift: driftSchema,
          pending: { type: 'integer' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {}
        if (record.ok !== true) {
          return [{ type: 'text', text: `[${record.error ?? 'GRAPH_FAILED'}] ${typeof record.hint === 'string' ? record.hint : ''}`.trim() }]
        }
        const drift = asRecord(record.drift)
        const payload: CheckPayload = {
          context: {},
          graph: {
            ok: record.fresh === true,
            added: drift !== undefined ? (drift.added as string[]) : [],
            removed: drift !== undefined ? (drift.removed as string[]) : [],
            changed: drift !== undefined ? (drift.changed as string[]) : [],
            stale: drift !== undefined ? (drift.stale as string[]) : [],
            ...(typeof record.pending === 'number' ? { pending: record.pending } : {}),
          },
        }
        const text = renderCheck(payload, DRIFT_CAP)
        return [{ type: 'text', text: typeof record.note === 'string' ? `${text}\n${record.note}` : text }]
      },
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps)
      const result = await withGraph(anchor, config, deps, exec.signal,
        (dir) => ['check', '--json', dir],
        (json, code) => {
          // exit 1 = stale graph: data, not an error.
          const payload = json as CheckPayload
          const graph = typeof payload.graph === 'object' && payload.graph !== null ? payload.graph : undefined
          if (graph === undefined) {
            return {
              ok: true,
              fresh: false,
              note: 'Freshness check returned no graph report (no graph/ directory?).',
            }
          }
          const fresh = code === 0 && graph.ok === true
          const drift: FreshnessDrift = {
            added: stringArray(graph.added, DRIFT_CAP),
            removed: stringArray(graph.removed, DRIFT_CAP),
            changed: stringArray(graph.changed, DRIFT_CAP),
            stale: stringArray(graph.stale, DRIFT_CAP),
          }
          return {
            ok: true,
            fresh,
            drift,
            ...(typeof graph.pending === 'number' ? { pending: graph.pending } : {}),
            ...(typeof payload.context === 'object' && payload.context !== null && payload.context.missing === true
              ? { note: 'LLM context layer absent (expected without --deep).' }
              : {}),
          }
        })
      return result
    },
    timeoutMs: config.timeoutMs + 45_000,
  })
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

export interface GraphTools {
  findCode: ReturnType<typeof buildFindCodeTool>
  fileApi: ReturnType<typeof buildFileApiTool>
  traceCalls: ReturnType<typeof buildTraceCallsTool>
  findAll: ReturnType<typeof buildFindAllTool>
  repoMap: ReturnType<typeof buildRepoMapTool>
  checkFreshness: ReturnType<typeof buildCheckFreshnessTool>
}

/** Build all six tools with one config/deps pair (registration is separate). */
export function buildGraphTools(config: ToolsConfig, deps: ToolsDeps): GraphTools {
  return {
    findCode: buildFindCodeTool(config, deps),
    fileApi: buildFileApiTool(config, deps),
    traceCalls: buildTraceCallsTool(config, deps),
    findAll: buildFindAllTool(config, deps),
    repoMap: buildRepoMapTool(config, deps),
    checkFreshness: buildCheckFreshnessTool(config, deps),
  }
}
