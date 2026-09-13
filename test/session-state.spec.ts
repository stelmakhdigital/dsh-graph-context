import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireBuildLock,
  buildLockExists,
  LOCK_FILE_NAME,
  releaseBuildLock,
  SessionStateStore,
} from '../src/session-state.ts'
import { deadPid, makeTmpRoot, removeTmpRoot } from './fixtures.ts'

describe('session-state.ts — per-(session, repo) state', () => {
  it('keys state by (sessionId, gitRoot): parallel sessions do not share flags', () => {
    const store = new SessionStateStore()
    const a = store.get('session-a', '/repo/a')
    const a2 = store.get('session-a', '/repo/a')
    const b = store.get('session-b', '/repo/a')
    const aOtherRepo = store.get('session-a', '/repo/b')
    expect(a2).toBe(a)
    expect(b).not.toBe(a)
    expect(aOtherRepo).not.toBe(a)
    a.dirty = true
    expect(b.dirty).toBe(false)
    expect(aOtherRepo.dirty).toBe(false)
  })

  it('dedupes injected hits per session/repo', () => {
    const store = new SessionStateStore()
    expect(store.markHitInjected('s', '/r', 'src/auth.ts:L3-L6')).toBe(true)
    expect(store.markHitInjected('s', '/r', 'src/auth.ts:L3-L6')).toBe(false)
    // a different session sees the hit as fresh again
    expect(store.markHitInjected('other', '/r', 'src/auth.ts:L3-L6')).toBe(true)
  })

  it('dirty flag is per (session, repo) and toggled via helpers', () => {
    const store = new SessionStateStore()
    expect(store.isDirty('s', '/r')).toBe(false)
    store.markDirty('s', '/r')
    expect(store.isDirty('s', '/r')).toBe(true)
    // other session / other repo unaffected
    expect(store.isDirty('other', '/r')).toBe(false)
    expect(store.isDirty('s', '/other')).toBe(false)
    store.clearDirty('s', '/r')
    expect(store.isDirty('s', '/r')).toBe(false)
    // markDirty is idempotent
    store.markDirty('s', '/r')
    store.markDirty('s', '/r')
    expect(store.isDirty('s', '/r')).toBe(true)
  })

  it('forgetSession drops only that session\'s entries', () => {
    const store = new SessionStateStore()
    store.get('s1', '/r').dirty = true
    store.get('s2', '/r').dirty = true
    store.forgetSession('s1')
    expect(store.get('s1', '/r').dirty).toBe(false)
    expect(store.get('s2', '/r').dirty).toBe(true)
  })
})

describe('session-state.ts — build lock', () => {
  let root: string

  afterAll(() => removeTmpRoot(root))

  it('acquires once; a second live holder is refused', () => {
    root = makeTmpRoot('dsh-cg-lock-')
    const first = acquireBuildLock(root, 20_000)
    expect(first).toMatchObject({ acquired: true, own: true })
    expect(buildLockExists(root)).toBe(true)
    const second = acquireBuildLock(root, 20_000)
    expect(second.acquired).toBe(false)
    expect(second.own).toBe(false)
    expect(second.reason).toContain(String(process.pid))
  })

  it('releases when the lock is ours; re-acquire works afterwards', () => {
    root = makeTmpRoot('dsh-cg-lock2-')
    acquireBuildLock(root, 20_000)
    releaseBuildLock(root)
    expect(buildLockExists(root)).toBe(false)
    expect(acquireBuildLock(root, 20_000).acquired).toBe(true)
    releaseBuildLock(root)
  })

  it('releaseBuildLock leaves a foreign lock untouched', () => {
    root = makeTmpRoot('dsh-cg-lock2b-')
    const lockPath = join(root, LOCK_FILE_NAME)
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: Date.now() }))
    releaseBuildLock(root)
    expect(buildLockExists(root)).toBe(true)
    rmSync(lockPath)
  })

  it('steals a stale lock (older than timeout + grace, dead holder)', () => {
    root = makeTmpRoot('dsh-cg-lock3-')
    const lockPath = join(root, LOCK_FILE_NAME)
    const staleAt = Date.now() - 10 * 60_000 // 10 minutes old
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: staleAt }))
    const claim = acquireBuildLock(root, 20_000)
    expect(claim.acquired).toBe(true)
    const content = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; startedAt: number }
    expect(content.pid).toBe(process.pid)
    releaseBuildLock(root)
  })

  it('steals a fresh lock whose holder pid is already dead', () => {
    root = makeTmpRoot('dsh-cg-lock4-')
    const lockPath = join(root, LOCK_FILE_NAME)
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: Date.now() }))
    expect(acquireBuildLock(root, 20_000).acquired).toBe(true)
  })

  it('two turn-stop-style requests yield a single build (lock serializes)', () => {
    // Simulates the P1 autoSync contract: N stopping events, one build.
    root = makeTmpRoot('dsh-cg-lock5-')
    const claims = [acquireBuildLock(root, 20_000), acquireBuildLock(root, 20_000), acquireBuildLock(root, 20_000)]
    expect(claims.filter((claim) => claim.acquired).length).toBe(1)
    releaseBuildLock(root)
  })
})

describe('session-state.ts — P2a: lastFile scope hint + graph-call/nudge flags', () => {
  const root = '/tmp/repo'

  it('lastFile round-trips as a RELATIVE path (not a basename)', () => {
    const store = new SessionStateStore()
    expect(store.getLastFile('s1', root)).toBeUndefined()
    store.setLastFile('s1', root, 'packages/api/src/auth.ts')
    // Full relative path preserved — the scope is recoverable from it.
    expect(store.getLastFile('s1', root)).toBe('packages/api/src/auth.ts')
    // Per-(session, repo): a different session/repo does not share it.
    expect(store.getLastFile('s2', root)).toBeUndefined()
    expect(store.getLastFile('s1', '/tmp/other')).toBeUndefined()
  })

  it('graphToolCalls increments per accepted graph_* call', () => {
    const store = new SessionStateStore()
    expect(store.hasGraphCalls('s1', root)).toBe(false)
    store.bumpGraphCalls('s1', root)
    expect(store.hasGraphCalls('s1', root)).toBe(true)
    store.bumpGraphCalls('s1', root)
    // A different (session, repo) is independent.
    expect(store.hasGraphCalls('s2', root)).toBe(false)
  })

  it('the nudge is marked sent exactly once per (session, repo)', () => {
    const store = new SessionStateStore()
    expect(store.markNudgeSent('s1', root)).toBe(true)
    // Second attempt (same session/repo): already sent, returns false.
    expect(store.markNudgeSent('s1', root)).toBe(false)
    // A different repo is independent.
    expect(store.markNudgeSent('s1', '/tmp/other')).toBe(true)
  })
})
