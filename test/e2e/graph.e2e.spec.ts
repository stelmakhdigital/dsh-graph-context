/**
 * Opt-in end-to-end test against the REAL @nanonets/graft CLI and the sample
 * repo fixture. Skipped unless GRAPH_E2E=1 (CI without the CLI stays green):
 *   pnpm test:e2e
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolveGraphBin, runGraphJson } from '../../src/cli.ts'
import { buildGraphTools } from '../../src/tools.ts'

const SAMPLE_DIR = '/tmp/graph-sample'
const ENABLED = process.env.GRAPH_E2E === '1' && existsSync(SAMPLE_DIR)

function fakeExec(cwd: string) {
  return {
    callId: 'e2e', rootCallId: 'e2e', name: 'tool', arguments: {},
    agent: { id: 's', status: 'idle', session: { header: { id: 's', createdAt: 0, cwd } } },
    signal: new AbortController().signal,
  }
}

describe('e2e — real graft CLI against the sample repo (GRAPH_E2E=1)', () => {
  beforeAll(() => {
    if (!ENABLED) return
    const bin = resolveGraphBin('', process.env)
    expect(bin).toBeDefined()
  })

  it('graph_find_code returns ranked hits for a real symbol', async () => {
    if (!ENABLED) {
      console.log('skipped: GRAPH_E2E not set or /tmp/graph-sample missing')
      return
    }
    const tools = buildGraphTools({ graphPath: '', timeoutMs: 15_000, maxInjectBytes: 4096 }, {
      runGraphJson,
      processCwd: () => SAMPLE_DIR,
    })
    const value = (await tools.findCode.execute({ query: 'issueToken' }, fakeExec(SAMPLE_DIR))) as { ok: boolean; hits?: unknown[] }
    expect(value.ok).toBe(true)
    expect(value.hits?.length).toBeGreaterThan(0)
  })

  it('graph_repo_map returns totals with files > 0', async () => {
    if (!ENABLED) return
    const tools = buildGraphTools({ graphPath: '', timeoutMs: 15_000, maxInjectBytes: 4096 }, {
      runGraphJson,
      processCwd: () => SAMPLE_DIR,
    })
    const value = (await tools.repoMap.execute({}, fakeExec(SAMPLE_DIR))) as { ok: boolean; totals?: { files?: number } }
    expect(value.ok).toBe(true)
    expect(value.totals?.files).toBeGreaterThan(0)
  })

  it('graph_check_freshness runs on the built graph', async () => {
    if (!ENABLED) return
    const tools = buildGraphTools({ graphPath: '', timeoutMs: 15_000, maxInjectBytes: 4096 }, {
      runGraphJson,
      processCwd: () => SAMPLE_DIR,
    })
    const value = (await tools.checkFreshness.execute({}, fakeExec(SAMPLE_DIR))) as { ok: boolean; fresh?: boolean }
    expect(value.ok).toBe(true)
    expect(typeof value.fresh).toBe('boolean')
  })
})
