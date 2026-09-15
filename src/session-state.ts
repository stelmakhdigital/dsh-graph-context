/**
 * Per-(session, repo) graph state: dirty flag, already-injected hits, the
 * last edited file (monorepo scope hint), and the in-memory mirror of the
 * cross-session build lock.
 *
 * Web UI runs several agents in different repos in parallel, so nothing
 * here is keyed by process or by a single global file: the key is
 * `(sessionId, gitRoot)`. The build lock is the one cross-session resource
 * and therefore lives on disk (see {@link LOCK_FILE_NAME}).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Lock file name inside the repo root (gitignored by convention). */
export const LOCK_FILE_NAME = '.dsh-context-graph-build.lock'

/** Grace beyond the build timeout after which a stale lock is stealable. */
const LOCK_GRACE_MS = 30_000

/** Keys of hits already injected into this session (dedupe, never repeat). */
export type HitKey = string

/** Prompt-hash memo entries kept per (session, repo) (bounded). */
const PROMPT_MEMO_MAX = 32

export interface SessionGraphState {
  /** Set by post-execute when a source edit tool succeeds (P1 consumption). */
  dirty: boolean
  /** Hit keys already injected into this session's context. */
  injectedHits: Set<HitKey>
  /**
   * Recent prompt hash → top-hit key (P1 pre-step memo): an identical prompt
   * is not re-run through the CLI at all when its hits were already injected.
   * Bounded; oldest entries evict.
   */
  promptMemo: Map<string, HitKey>
  /**
   * Repo-relative path of the last edited file (P2 monorepo scope hint).
   * Relative by design — a basename (the engine's weakness) would lose the scope.
   */
  lastFile?: string
  /** Accepted graph_* tool calls so far (nudge precondition, P2a). */
  graphToolCalls: number
  /** The blind-search nudge was sent for this (session, repo) (P2a). */
  nudgeSent: boolean
  /** Last observed compaction id for this (session, repo) (P2b, spec #6). */
  lastCompactionId?: string
  /** Compaction id whose one-shot map re-inject has not been consumed yet (P2b). */
  compactionPending?: string
  /**
   * Subagent short-map arming (P2b, spec #5): set at `agent/created`,
   * consumed at the session's first pre-step. Delivered through the
   * pre-step decision (not `agent.inject`) so the very first step claims
   * it — an inject races the subagent's immediately-submitted prompt
   * (verified live 2026-09-13: the inject lost the race).
   */
  subagentMapPending?: boolean
}

/** djb2 over the prompt (truncated): a cheap, stable dedupe key. */
export function hashPrompt(prompt: string): string {
  const text = prompt.slice(0, 1024)
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return `p${hash >>> 0}`
}

/**
 * In-memory session/repo state store. One process hosts many sessions, so
 * state is keyed, not global; nothing is persisted (a restart simply loses
 * the dirty/hit-dedupe flags — the graph on disk is the source of truth).
 */
export class SessionStateStore {
  private readonly states = new Map<string, SessionGraphState>()

  private static key(sessionId: string, gitRoot: string | undefined): string {
    return `${sessionId}\0${gitRoot ?? ''}`
  }

  /** Get (or lazily create) the state for one (session, repo) pair. */
  get(sessionId: string, gitRoot: string | undefined): SessionGraphState {
    const key = SessionStateStore.key(sessionId, gitRoot)
    let state = this.states.get(key)
    if (state === undefined) {
      state = { dirty: false, injectedHits: new Set(), promptMemo: new Map(), graphToolCalls: 0, nudgeSent: false }
      this.states.set(key, state)
    }
    return state
  }

  /** Remember the repo-relative path of the last edited file (P2 scope hint). */
  setLastFile(sessionId: string, gitRoot: string | undefined, relPath: string): void {
    this.get(sessionId, gitRoot).lastFile = relPath
  }

  /** The last edited file (relative), or undefined before the first edit. */
  getLastFile(sessionId: string, gitRoot: string | undefined): string | undefined {
    return this.states.get(SessionStateStore.key(sessionId, gitRoot))?.lastFile
  }

  /** Count one accepted graph_* tool call (resets the nudge precondition). */
  bumpGraphCalls(sessionId: string, gitRoot: string | undefined): void {
    this.get(sessionId, gitRoot).graphToolCalls += 1
  }

  /** Whether any graph_* tool was called in this (session, repo). */
  hasGraphCalls(sessionId: string, gitRoot: string | undefined): boolean {
    return (this.states.get(SessionStateStore.key(sessionId, gitRoot))?.graphToolCalls ?? 0) > 0
  }

  /**
   * True (and recorded) when the nudge had NOT been sent before. Sent once
   * per (session, repo), ever — the spec asks for a single reminder.
   */
  markNudgeSent(sessionId: string, gitRoot: string | undefined): boolean {
    const state = this.get(sessionId, gitRoot)
    if (state.nudgeSent) return false
    state.nudgeSent = true
    return true
  }

  /**
   * Observe a compaction (P2b, spec #6): a NEW compaction id arms a one-shot
   * map re-inject for this (session, repo); re-observing the same id does not
   * re-arm (the summary event is replayed across listeners).
   */
  markCompaction(sessionId: string, gitRoot: string | undefined, compactionId: string): void {
    const state = this.get(sessionId, gitRoot)
    if (state.lastCompactionId === compactionId) return
    state.lastCompactionId = compactionId
    state.compactionPending = compactionId
  }

  /**
   * Take the pending compaction re-inject (P2b): returns the compaction id
   * exactly once, then clears it. Undefined when nothing is pending.
   */
  takePendingCompaction(sessionId: string, gitRoot: string | undefined): string | undefined {
    const state = this.states.get(SessionStateStore.key(sessionId, gitRoot))
    const pending = state?.compactionPending
    if (state !== undefined && state.compactionPending !== undefined) state.compactionPending = undefined
    return pending
  }

  /** Arm the one-shot subagent short map for this (session, repo) (P2b, spec #5). */
  markSubagentMap(sessionId: string, gitRoot: string | undefined): void {
    this.get(sessionId, gitRoot).subagentMapPending = true
  }

  /** Take the armed subagent short map (P2b): true exactly once, then cleared. */
  takeSubagentMap(sessionId: string, gitRoot: string | undefined): boolean {
    const state = this.states.get(SessionStateStore.key(sessionId, gitRoot))
    const pending = state?.subagentMapPending === true
    if (state !== undefined && pending) state.subagentMapPending = undefined
    return pending
  }

  /** Whether a hit key was already injected in this (session, repo). */
  isHitInjected(sessionId: string, gitRoot: string | undefined, hit: HitKey): boolean {
    return this.states.get(SessionStateStore.key(sessionId, gitRoot))?.injectedHits.has(hit) === true
  }

  /** Top-hit key memoized for a recent prompt (undefined when unseen). */
  lookupPromptHit(sessionId: string, gitRoot: string | undefined, promptHash: string): HitKey | undefined {
    return this.get(sessionId, gitRoot).promptMemo.get(promptHash)
  }

  /** Remember the top hit a prompt produced (bounded, oldest evicted). */
  recordPromptHit(sessionId: string, gitRoot: string | undefined, promptHash: string, hit: HitKey): void {
    const memo = this.get(sessionId, gitRoot).promptMemo
    if (memo.has(promptHash)) memo.delete(promptHash)
    memo.set(promptHash, hit)
    while (memo.size > PROMPT_MEMO_MAX) {
      const oldest = memo.keys().next().value
      if (oldest === undefined) break
      memo.delete(oldest)
    }
  }

  /**
   * Mark every known (session, repo) state for the repo dirty (P2c #17 file
   * watcher: the user edited in an IDE, no edit-tool event will come).
   * Unknown sessions are not created — the watcher marks what exists.
   */
  markRepoDirty(gitRoot: string): void {
    for (const [key, state] of this.states) {
      const repo = key.split('\0')[1]
      if (repo === gitRoot) state.dirty = true
    }
  }

  /** Mark the (session, repo) graph dirty (a source edit happened). */
  markDirty(sessionId: string, gitRoot: string | undefined): void {
    this.get(sessionId, gitRoot).dirty = true
  }

  /** Clear the dirty flag (a rebuild is running or done). */
  clearDirty(sessionId: string, gitRoot: string | undefined): void {
    this.get(sessionId, gitRoot).dirty = false
  }

  /** Whether the (session, repo) graph needs a rebuild. */
  isDirty(sessionId: string, gitRoot: string | undefined): boolean {
    return this.states.get(SessionStateStore.key(sessionId, gitRoot))?.dirty === true
  }

  /** True (and recorded) when the hit was not injected before in this session. */
  markHitInjected(sessionId: string, gitRoot: string | undefined, hit: HitKey): boolean {
    const state = this.get(sessionId, gitRoot)
    if (state.injectedHits.has(hit)) return false
    state.injectedHits.add(hit)
    return true
  }

  /** Drop all state for one session (agent disposal hook, if wired later). */
  forgetSession(sessionId: string): void {
    for (const key of this.states.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.states.delete(key)
    }
  }
}

export interface LockClaim {
  /** The lock is held (by this or another process); do not start a build. */
  acquired: boolean
  /** The holder was this process's claim (release when done). */
  own: boolean
  /** Diagnostic detail for logging. */
  reason?: string
}

interface LockFileContent {
  pid: number
  startedAt: number
}

function readLock(lockPath: string): LockFileContent | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { pid?: unknown }).pid === 'number'
      && typeof (parsed as { startedAt?: unknown }).startedAt === 'number'
    ) {
      return { pid: (parsed as { pid: number }).pid, startedAt: (parsed as { startedAt: number }).startedAt }
    }
  } catch {
    // missing or torn lock file: treat as free
  }
  return undefined
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Claim the repo's build lock. A lock is held while it is younger than
 * `buildTimeoutMs + grace` AND its holder pid is alive; otherwise the stale
 * lock is stolen. Atomic enough for a single-user harness: two claims race
 * on write, and a second build for the same repo is harmless (the engine is
 * idempotent) — the lock only removes the common double-build, not in
 * principle.
 */
export function acquireBuildLock(
  repoRoot: string,
  buildTimeoutMs: number,
  now: number = Date.now(),
): LockClaim {
  const lockPath = join(repoRoot, LOCK_FILE_NAME)
  const existing = readLock(lockPath)
  if (existing !== undefined) {
    const fresh = now - existing.startedAt < buildTimeoutMs + LOCK_GRACE_MS
    if (fresh && pidAlive(existing.pid)) {
      return { acquired: false, own: false, reason: `build in progress (pid ${existing.pid})` }
    }
  }
  try {
    mkdirSync(repoRoot, { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: now }), 'utf8')
    return { acquired: true, own: true }
  } catch (error) {
    return { acquired: false, own: false, reason: `lock write failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Release the repo build lock when it is ours (torn or foreign locks are left). */
export function releaseBuildLock(repoRoot: string): void {
  const lockPath = join(repoRoot, LOCK_FILE_NAME)
  const existing = readLock(lockPath)
  if (existing !== undefined && existing.pid === process.pid) {
    try {
      rmSync(lockPath)
    } catch {
      // best effort; a stale lock is stealable
    }
  }
}

/** True when a lock file currently exists in the repo (any holder). */
export function buildLockExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, LOCK_FILE_NAME))
}
