import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordToolCall, STATS_FILE_NAME } from '../src/metrics.ts'

/**
 * recordToolCall writes to $DSH_HOME/context-graph-stats.json. We pin
 * DSH_HOME to a temp dir per test file (the harness env may set a real
 * DSH_HOME — tests must never touch it).
 */
describe('metrics.ts — local per-session counters (P2a, spec #16)', () => {
  let home: string
  const savedHome = process.env.DSH_HOME

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-cg-metrics-'))
    process.env.DSH_HOME = home
  })

  afterAll(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const file = (): string => join(home, STATS_FILE_NAME)

  it('bumps graphReads for graph and sourceReads for source, per session', () => {
    recordToolCall('s1', 'graph')
    recordToolCall('s1', 'graph')
    recordToolCall('s1', 'source')
    const stats = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, { graphReads: number; sourceReads: number }>
    expect(stats.s1).toEqual({ graphReads: 2, sourceReads: 1, updatedAt: expect.any(Number) })
    // A different session is independent.
    recordToolCall('s2', 'graph')
    const again = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, { graphReads: number }>
    expect(again.s2?.graphReads).toBe(1)
    expect(again.s1?.graphReads).toBe(2)
  })

  it('a torn or missing file does not throw (fail-soft)', () => {
    // Missing: starts fresh.
    rmSync(file(), { force: true })
    expect(() => recordToolCall('sX', 'source')).not.toThrow()
    expect(existsSync(file())).toBe(true)
    // Torn (invalid JSON): swallowed, file rewritten.
    writeFileSync(file(), '{not json', 'utf8')
    expect(() => recordToolCall('sY', 'graph')).not.toThrow()
    const stats = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, { graphReads: number }>
    expect(stats.sY?.graphReads).toBe(1)
  })

  it('keeps only the most recent 32 sessions (bounded file)', async () => {
    for (let i = 0; i < 40; i += 1) {
      recordToolCall(`bulk-${i}`, 'graph')
      // give each row a distinct updatedAt so the prune order is stable
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const stats = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
    expect(Object.keys(stats).length).toBeLessThanOrEqual(32)
  })

  it('a read-only DSH home swallows the write error (never throws)', () => {
    // Point DSH_HOME at a FILE (not a dir): mkdir/write fail, must be swallowed.
    const aFile = join(home, 'not-a-dir')
    writeFileSync(aFile, 'x', 'utf8')
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = aFile
    try {
      expect(() => recordToolCall('sRO', 'graph')).not.toThrow()
    } finally {
      process.env.DSH_HOME = saved
    }
  })

  it('mkdirSync is not required for the write (home exists)', () => {
    // The stats file lives directly in the DSH home, which exists by contract.
    mkdirSync(home, { recursive: true })
    expect(() => recordToolCall('sM', 'source')).not.toThrow()
  })
})
