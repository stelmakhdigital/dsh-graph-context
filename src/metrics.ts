/**
 * Local per-session counters (P2a, spec #16): how often the model reaches for
 * the graph (`graphReads`) versus raw source reads (`sourceReads`). The point
 * is to let the README claim "the model really calls the graph" honestly, with
 * a number a user can inspect.
 *
 * Privacy invariant (spec #14): the graph is never more secret than the
 * sources — and these counters go NOWHERE. The file is written to the local
 * DSH home, nothing is ever POSTed, and a write failure is swallowed:
 * metrics must never be a reason a hook throws into the agent loop.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from './skill.ts'

/** File name inside the DSH home. */
export const STATS_FILE_NAME = 'context-graph-stats.json'

/** Bounded: only the most recent sessions are kept. */
const MAX_SESSIONS = 32

interface SessionCounters {
  graphReads: number
  sourceReads: number
  updatedAt: number
}

type StatsFile = Record<string, SessionCounters>

function statsPath(): string {
  return join(resolveDshHome(), STATS_FILE_NAME)
}

/**
 * Bump one counter for one session. Best effort by contract: any filesystem
 * problem (missing home, read-only fs, torn file) is swallowed silently.
 * @param sessionId - the session (agent) id; keys the counter row.
 * @param kind - `graph` (a graph_* tool call) or `source` (a raw read/grep of the repo).
 */
export function recordToolCall(sessionId: string, kind: 'graph' | 'source'): void {
  try {
    const path = statsPath()
    let stats: StatsFile = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        stats = parsed as StatsFile
      }
    } catch {
      stats = {} // missing or torn file: start fresh
    }
    const row: SessionCounters = stats[sessionId] ?? { graphReads: 0, sourceReads: 0, updatedAt: 0 }
    if (kind === 'graph') row.graphReads += 1
    else row.sourceReads += 1
    row.updatedAt = Date.now()
    stats[sessionId] = row
    // Bound the file: keep the most recent MAX_SESSIONS rows.
    const keys = Object.keys(stats)
    if (keys.length > MAX_SESSIONS) {
      keys
        .sort((a, b) => (stats[b]?.updatedAt ?? 0) - (stats[a]?.updatedAt ?? 0))
        .slice(MAX_SESSIONS)
        .forEach((key) => { delete stats[key] })
    }
    writeFileSync(path, JSON.stringify(stats, null, 1), 'utf8')
  } catch {
    // Metrics are advisory: never propagate into the agent loop.
  }
}
