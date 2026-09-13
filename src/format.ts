/**
 * Compact markdown rendering of engine CLI JSON payloads, bounded by a byte
 * budget. The model receives pointers and crux excerpts, never whole files:
 * every renderer is defensive (unknown shapes degrade to a short note) and
 * deterministic — no I/O, no clock.
 */
import { GraphError } from './cli.ts'

/** Pointer like `src/auth.ts:L8-L10` (file hits carry no line span). */
export interface ParsedPointer {
  path: string
  startLine?: number
  endLine?: number
}

/** Parse one engine pointer into path + optional line span. */
export function parsePointer(pointer: string): ParsedPointer {
  const match = /^(?<path>.+?)(?::L(?<start>\d+)(?:-L(?<end>\d+))?)?$/.exec(pointer)
  if (match === null || match.groups === undefined) return { path: pointer }
  const start = match.groups.start !== undefined ? Number(match.groups.start) : undefined
  const end = match.groups.end !== undefined ? Number(match.groups.end) : undefined
  return {
    path: match.groups.path ?? pointer,
    ...(start !== undefined ? { startLine: start } : {}),
    ...(end !== undefined ? { endLine: end } : {}),
  }
}

/** `src/auth.ts:L8` or `src/auth.ts:L8-L10`. */
export function formatPointer(parsed: ParsedPointer): string {
  if (parsed.startLine === undefined) return parsed.path
  if (parsed.endLine !== undefined && parsed.endLine !== parsed.startLine) {
    return `${parsed.path}:L${parsed.startLine}-L${parsed.endLine}`
  }
  return `${parsed.path}:L${parsed.startLine}`
}

/**
 * UTF-8-safe truncation to a byte budget, cutting at a line boundary and
 * marking the cut. Returns the input unchanged when it fits.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.byteLength(text, 'utf8')
  if (encoded <= maxBytes) return text
  const marker = '\n… (truncated)'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  // No room for the marker: cut at a character boundary without it.
  if (maxBytes < markerBytes) {
    let byteCount = 0
    let charCount = 0
    for (let i = 0; i < text.length; i += 1) {
      const charBytes = Buffer.byteLength(text.charAt(i), 'utf8')
      if (byteCount + charBytes > maxBytes) break
      byteCount += charBytes
      charCount += 1
    }
    return text.slice(0, charCount)
  }
  const budget = maxBytes - markerBytes
  let byteCount = 0
  let charCount = 0
  for (let i = 0; i < text.length; i += 1) {
    const charBytes = Buffer.byteLength(text.charAt(i), 'utf8')
    if (byteCount + charBytes > budget) break
    byteCount += charBytes
    charCount += 1
  }
  let cut = text.slice(0, charCount)
  const newlineAt = cut.lastIndexOf('\n')
  if (newlineAt > Math.floor(cut.length / 2)) cut = cut.slice(0, newlineAt)
  return cut + marker
}

/** Ask payload (graft ask --json). */
export interface AskHit {
  title?: string
  pointer?: string
  snippet?: string
  score?: number
  /**
   * Present when the CLI was asked with `--source` (retriever mode): the
   * inlined source at the hit — a ≤8-line crux excerpt by default
   * (`--full` would widen it to the whole definition span).
   */
  code?: string
}
export interface AskPayload {
  query?: string
  mode?: string
  hits?: AskHit[]
  coverage?: number
}

/** Render ranked hits as pointer lines: `- path:line — title (score)`. */
export function renderAsk(payload: AskPayload, maxHits: number): string {
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, maxHits) : []
  if (hits.length === 0) return 'No graph hits for that query (empty or stale graph? try graph_repo_map or graph_check_freshness).'
  const lines: string[] = []
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue
    const pointer = typeof hit.pointer === 'string' ? parsePointer(hit.pointer) : undefined
    const rawTitle = typeof hit.title === 'string' && hit.title !== '' ? hit.title : undefined
    // Engine titles are "name · kind"; render as "name (kind)".
    const [titleName, titleKind] = rawTitle?.split(' · ') ?? []
    const title = titleName !== undefined && titleName !== ''
      ? (titleKind !== undefined && titleKind !== '' ? `${titleName} (${titleKind})` : titleName)
      : rawTitle
    const score = typeof hit.score === 'number' ? hit.score.toFixed(2) : undefined
    const parts: string[] = []
    if (pointer !== undefined) parts.push(formatPointer(pointer))
    if (title !== undefined) parts.push(title)
    if (score !== undefined) parts.push(`score ${score}`)
    if (parts.length === 0) continue
    lines.push(`- ${parts.join(' — ')}`)
    if (typeof hit.snippet === 'string' && hit.snippet !== '') {
      lines.push(`  ${hit.snippet}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No parseable hits in the query result.'
}

/**
 * Render pre-step retrieval hits as a compact pointer list (NO source
 * bodies — the model pulls source through the graph tools). Returns '' when
 * there is nothing worth injecting.
 */
export function renderPromptHits(payload: AskPayload, maxBytes: number): string {
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, 3) : []
  const lines: string[] = []
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue
    const pointer = typeof hit.pointer === 'string' ? parsePointer(hit.pointer) : undefined
    const rawTitle = typeof hit.title === 'string' && hit.title !== '' ? hit.title : undefined
    const [titleName, titleKind] = rawTitle?.split(' · ') ?? []
    const title = titleName !== undefined && titleName !== ''
      ? (titleKind !== undefined && titleKind !== '' ? `${titleName} (${titleKind})` : titleName)
      : undefined
    const score = typeof hit.score === 'number' ? hit.score.toFixed(2) : undefined
    const parts: string[] = []
    if (pointer !== undefined) parts.push(formatPointer(pointer))
    if (title !== undefined) parts.push(title)
    if (score !== undefined) parts.push(`score ${score}`)
    if (parts.length === 0) continue
    lines.push(`- ${parts.join(' — ')}`)
  }
  if (lines.length === 0) return ''
  const header = 'Graph prompt hits for your question (pointers only — use the graph tools for source):'
  return truncateToBytes(`${header}\n${lines.join('\n')}`, maxBytes)
}

/**
 * Sourced variant of {@link renderPromptHits} (P2a, spec #1): the top hit
 * arrives WITH its source crux (≤8 lines from `graft ask --source`), the
 * remaining hits stay pointers. Local/small models often skip the follow-up
 * `ask --source`, so the DSH default injects the crux up front — a deliberate
 * token trade for actually landing in the file. Byte-budgeted.
 * Falls back to the plain pointer rendering when the top hit carries no code.
 */
export function renderPromptHitsSourced(payload: AskPayload, maxBytes: number): string {
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, 3) : []
  const top = hits[0]
  if (top === undefined) return renderPromptHits(payload, maxBytes)
  const topCode = typeof top.code === 'string' && top.code.trim() !== '' ? top.code.trim() : undefined
  if (topCode === undefined) return renderPromptHits(payload, maxBytes)
  const lines: string[] = []
  const pointer = typeof top.pointer === 'string' ? parsePointer(top.pointer) : undefined
  const header = pointer !== undefined
    ? `Graph top hit for your question (with source — the crux is inlined; related pointers below):`
    : 'Graph top hit for your question (with source):'
  lines.push(header)
  if (pointer !== undefined) lines.push(`- ${formatPointer(pointer)}`)
  if (typeof top.title === 'string' && top.title !== '') lines.push(`  ${top.title}`)
  lines.push('  ```')
  for (const codeLine of topCode.split('\n')) lines.push(`  ${codeLine}`)
  lines.push('  ```')
  for (const hit of hits.slice(1)) {
    if (typeof hit !== 'object' || hit === null) continue
    const p = typeof hit.pointer === 'string' ? parsePointer(hit.pointer) : undefined
    const score = typeof hit.score === 'number' ? hit.score.toFixed(2) : undefined
    const parts: string[] = []
    if (p !== undefined) parts.push(formatPointer(p))
    if (typeof hit.title === 'string' && hit.title !== '') parts.push(hit.title)
    if (score !== undefined) parts.push(`score ${score}`)
    if (parts.length === 0) continue
    lines.push(`- ${parts.join(' — ')}`)
  }
  return truncateToBytes(lines.join('\n'), maxBytes)
}

/**
 * The one-time blind-search reminder (P2a, spec #2): a NUDGE, never a block.
 * Emitted once per (session, repo) when the model reaches for a wide
 * grep/glob before ever calling a graph tool.
 */
export function renderNudge(): string {
  return 'Tip: before a broad grep/glob over the whole repo, try the graph tools first — '
    + 'graph_find_code for a concrete question, graph_repo_map to orient. '
    + 'They return ranked file:line pointers (with source on request) and are cheaper than a blind scan.'
}

/** One symbol of the edited file with the callers that depend on it. */
export interface BlastSymbol {
  name?: string
  callers?: Array<{ name?: string; path?: string; span?: string; relation?: string }>
}

/**
 * Render a post-edit blast radius ("who depends on the edited file") within
 * the byte budget. Returns '' when no symbol has callers — nothing worth
 * injecting. Callers are capped per symbol so one hub cannot blow the budget.
 */
export function renderBlastRadius(filePath: string, symbols: BlastSymbol[], maxBytes: number, maxCallersPerSymbol = 5): string {
  const lines: string[] = []
  for (const symbol of symbols) {
    if (typeof symbol !== 'object' || symbol === null) continue
    const name = typeof symbol.name === 'string' && symbol.name !== '' ? symbol.name : undefined
    const callers = Array.isArray(symbol.callers) ? symbol.callers : []
    const shown = callers
      .filter((caller): caller is { name?: string; path?: string; span?: string; relation?: string } =>
        typeof caller === 'object' && caller !== null && typeof caller.name === 'string')
      .slice(0, maxCallersPerSymbol)
    if (name === undefined || shown.length === 0) continue
    const parts = shown.map((caller) => {
      const where = caller.path !== undefined ? `${caller.path}${caller.span !== undefined ? `:${caller.span}` : ''}` : undefined
      return where !== undefined ? `${caller.name} @ ${where}` : (caller.name as string)
    })
    lines.push(`- ${name} ← ${parts.join(', ')}`)
  }
  if (lines.length === 0) return ''
  const header = `Graph blast radius after editing ${filePath} (who depends on it):`
  return truncateToBytes(`${header}\n${lines.join('\n')}`, maxBytes)
}

/** Skeleton payload (graft skeleton --json): signatures without bodies. */
export interface SkeletonEntry {
  name?: string
  kind?: string
  span?: string
  signature?: string
}
export interface SkeletonPayload {
  file?: string
  entries?: SkeletonEntry[]
}

export function renderSkeleton(payload: SkeletonPayload): string {
  const entries = Array.isArray(payload.entries) ? payload.entries : []
  if (entries.length === 0) return payload.file !== undefined ? `No indexed symbols for ${payload.file}.` : 'No indexed symbols.'
  const lines = payload.file !== undefined ? [`API surface of ${payload.file}:`] : []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = typeof entry.name === 'string' ? entry.name : '?'
    const kind = typeof entry.kind === 'string' ? ` (${entry.kind})` : ''
    const span = typeof entry.span === 'string' ? ` @${entry.span}` : ''
    const signature = typeof entry.signature === 'string' && entry.signature !== '' ? ` — ${entry.signature}` : ''
    lines.push(`- ${name}${kind}${span}${signature}`)
  }
  return lines.join('\n')
}

/** Callers payload (graft callers --json). */
export interface CallsHit {
  name?: string
  path?: string
  span?: string
  relation?: string
  depth?: number
}
export interface CallsMatch {
  symbol?: { name?: string; kind?: string; path?: string; span?: string }
  hits?: CallsHit[]
}
export interface CallsPayload {
  query?: string
  matches?: CallsMatch[]
}

/** Render a call graph walk: the root symbol plus its callers/callees. */
export function renderCalls(payload: CallsPayload, maxHits: number): string {
  const matches = Array.isArray(payload.matches) ? payload.matches : []
  if (matches.length === 0) return 'No call edges found for that symbol.'
  const lines: string[] = []
  for (const match of matches) {
    if (typeof match !== 'object' || match === null) continue
    const symbol = match.symbol
    const root = symbol?.name !== undefined
      ? `${symbol.name}${symbol.kind !== undefined ? ` (${symbol.kind})` : ''}${symbol.path !== undefined ? ` — ${symbol.path}${symbol.span !== undefined ? `:${symbol.span}` : ''}` : ''}`
      : '?'
    const hits = Array.isArray(match.hits) ? match.hits.slice(0, maxHits) : []
    lines.push(`- ${root}`)
    for (const hit of hits) {
      if (typeof hit !== 'object' || hit === null) continue
      const where = hit.path !== undefined ? `${hit.path}${hit.span !== undefined ? `:${hit.span}` : ''}` : '?'
      const depth = typeof hit.depth === 'number' && hit.depth > 1 ? ` (depth ${hit.depth})` : ''
      const relation = typeof hit.relation === 'string' ? hit.relation : 'calls'
      lines.push(`  - ${hit.name ?? '?'} @ ${where} [${relation}]${depth}`)
    }
  }
  return lines.join('\n')
}

/** Grep payload (graft grep --json): hits grouped by enclosing symbol. */
export interface GrepHit {
  line?: number
  text?: string
}
export interface GrepGroup {
  path?: string
  symbol?: { name?: string; path?: string; span?: string }
  inDegree?: number
  hits?: GrepHit[]
}
export interface GrepPayload {
  pattern?: string
  filesSearched?: number
  totalHits?: number
  groups?: GrepGroup[]
}

export function renderGrep(payload: GrepPayload, maxMatches: number): string {
  const groups = Array.isArray(payload.groups) ? payload.groups : []
  if (groups.length === 0) return `No matches for pattern in ${payload.filesSearched ?? 0} indexed file(s).`
  const lines: string[] = []
  let emitted = 0
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const symbolName = group.symbol?.name !== undefined ? group.symbol.name : undefined
    const header = group.path !== undefined
      ? `### ${group.path}${symbolName !== undefined ? ` · ${symbolName}` : ''}`
      : `### ${symbolName ?? 'unknown file'}`
    lines.push(header)
    const hits = Array.isArray(group.hits) ? group.hits : []
    for (const hit of hits) {
      if (emitted >= maxMatches) break
      if (typeof hit !== 'object' || hit === null) continue
      const lineNo = typeof hit.line === 'number' ? hit.line : '?'
      const text = typeof hit.text === 'string' ? hit.text : ''
      lines.push(`- L${lineNo}: ${text}`)
      emitted += 1
    }
    if (emitted >= maxMatches) {
      const total = typeof payload.totalHits === 'number' ? payload.totalHits : undefined
      lines.push(`… (capped at ${maxMatches} of ${total ?? '…'} matches)`)
      break
    }
  }
  return lines.join('\n')
}

/** Map payload (graft map --json): token-budgeted repo orientation. */
export interface MapHub {
  name?: string
  path?: string
  span?: string
  inDegree?: number
}
export interface MapDir {
  path?: string
  files?: number
  symbols?: number
  hubs?: MapHub[]
  isFile?: boolean
}
export interface MapHotspot {
  name?: string
  path?: string
  span?: string
  inDegree?: number
}
export interface MapPayload {
  totals?: { files?: number; symbols?: number; edges?: number; languages?: string[] }
  dirs?: MapDir[]
  hotspots?: MapHotspot[]
  dropped?: number
}

/**
 * Render the repo map for injection. One totals line, one line per
 * directory cluster (with hub symbols), one hotspots line — the whole
 * orientation in a few lines, then truncated to the byte budget.
 */
export function renderMap(payload: MapPayload, maxBytes: number): string {
  const totals = payload.totals
  const head = totals !== undefined && typeof totals === 'object'
    ? `repo map — ${totals.files ?? '?'} files · ${totals.symbols ?? '?'} symbols · ${totals.edges ?? '?'} edges${Array.isArray(totals.languages) && totals.languages.length > 0 ? ` · ${totals.languages.join(', ')}` : ''}`
    : 'repo map'
  const lines: string[] = [head]
  const dirs = Array.isArray(payload.dirs) ? payload.dirs : []
  for (const dir of dirs) {
    if (typeof dir !== 'object' || dir === null) continue
    const path = typeof dir.path === 'string' ? dir.path : '?'
    const hubs = Array.isArray(dir.hubs)
      ? dir.hubs
        .filter((hub): hub is MapHub => typeof hub === 'object' && hub !== null && typeof hub.name === 'string')
        .slice(0, 3)
        .map((hub) => hub.name)
        .join(', ')
      : ''
    const hubText = hubs !== '' ? `   hubs: ${hubs}` : ''
    lines.push(`${path}   ${dir.files ?? '?'} files · ${dir.symbols ?? '?'} symbols${hubText}`)
  }
  if (typeof payload.dropped === 'number' && payload.dropped > 0) {
    lines.push(`(… ${payload.dropped} more entries dropped)`)
  }
  const hotspots = Array.isArray(payload.hotspots) ? payload.hotspots : []
  if (hotspots.length > 0) {
    const top = hotspots
      .filter((hotspot): hotspot is MapHotspot => typeof hotspot === 'object' && hotspot !== null && typeof hotspot.name === 'string')
      .slice(0, 5)
      .map((hotspot) => {
        const pointer = hotspot.path !== undefined
          ? `${hotspot.path}${hotspot.span !== undefined ? `:${hotspot.span}` : ''}`
          : undefined
        return `${hotspot.name}${pointer !== undefined ? ` @ ${pointer}` : ''}${typeof hotspot.inDegree === 'number' ? ` (${hotspot.inDegree} callers)` : ''}`
      })
      .join(' · ')
    lines.push(`hotspots: ${top}`)
  }
  return truncateToBytes(lines.join('\n'), maxBytes)
}

/** Check payload (graft check --json). */
export interface CheckContext {
  ok?: boolean
  missing?: boolean
}
export interface CheckGraph {
  ok?: boolean
  missing?: boolean
  added?: string[]
  removed?: string[]
  changed?: string[]
  stale?: string[]
  pending?: number
  nodes?: number
}
export interface CheckPayload {
  context?: CheckContext
  graph?: CheckGraph
}

/** Fresh drift summary; a stale graph is data, not an error. */
export function renderCheck(payload: CheckPayload, maxPaths: number): string {
  const graph = typeof payload.graph === 'object' && payload.graph !== null ? payload.graph : undefined
  const context = typeof payload.context === 'object' && payload.context !== null ? payload.context : undefined
  if (graph === undefined) return 'Freshness check returned no graph report (no graph/ directory?).'
  if (graph.missing === true) return 'No graft/ index found — run `graft build` in the repo root first.'
  const lines: string[] = []
  if (graph.ok === true) {
    lines.push(`Fresh: graph covers the working tree (${graph.nodes ?? '?'} nodes${typeof graph.pending === 'number' && graph.pending > 0 ? `, ${graph.pending} pending rebuild` : ''}).`)
  } else {
    lines.push('Stale: the graph does not cover the current code.')
    const drift = (label: string, paths?: string[]): string | undefined => {
      if (!Array.isArray(paths) || paths.length === 0) return undefined
      const shown = paths.slice(0, maxPaths).map((p) => String(p)).join(', ')
      const more = paths.length > maxPaths ? ` (+${paths.length - maxPaths} more)` : ''
      return `${label}: ${shown}${more}`
    }
    const parts = [drift('added', graph.added), drift('removed', graph.removed), drift('changed', graph.changed), drift('stale', graph.stale)].filter((part): part is string => part !== undefined)
    if (parts.length > 0) lines.push(parts.join('\n'))
    lines.push('Run `graft build` to refresh (structural, no LLM).')
  }
  if (context !== undefined && context.missing === true) {
    lines.push('Note: LLM context layer absent (expected without `--deep`).')
  }
  return lines.join('\n')
}

/**
 * Render a GraphError as a short model-facing note. The error code is stable
 * so AGENTS.md/skills can key off it; the hint carries the fix command.
 */
export function renderError(error: unknown): string {
  if (error instanceof GraphError) {
    const lines = [`[${error.code}] ${error.message}`]
    if (error.hint !== undefined) lines.push(`Fix: ${error.hint}`)
    return lines.join('\n')
  }
  const message = error instanceof Error ? error.message : String(error)
  return `[GRAPH_FAILED] ${message}`
}
