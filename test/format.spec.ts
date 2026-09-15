import { describe, expect, it } from 'vitest'
import { GraphError } from '../src/cli.ts'
import {
  formatPointer,
  parsePointer,
  renderAsk,
  renderBlast,
  renderBlastRadius,
  renderCheck,
  renderError,
  renderMap,
  renderNudge,
  renderPromptHits,
  renderPromptHitsSourced,
  renderSkeleton,
  truncateToBytes,
} from '../src/format.ts'

describe('format.ts — pointers', () => {
  it('parses path-only pointers', () => {
    expect(parsePointer('src/auth.ts')).toEqual({ path: 'src/auth.ts' })
  })

  it('parses single-line and range pointers', () => {
    expect(parsePointer('src/auth.ts:L8')).toEqual({ path: 'src/auth.ts', startLine: 8 })
    expect(parsePointer('src/auth.ts:L8-L10')).toEqual({ path: 'src/auth.ts', startLine: 8, endLine: 10 })
  })

  it('round-trips through formatPointer', () => {
    expect(formatPointer(parsePointer('src/auth.ts:L8-L10'))).toBe('src/auth.ts:L8-L10')
    expect(formatPointer(parsePointer('src/auth.ts:L8-L8'))).toBe('src/auth.ts:L8')
    expect(formatPointer(parsePointer('src/auth.ts'))).toBe('src/auth.ts')
  })
})

describe('format.ts — truncateToBytes', () => {
  it('returns the input unchanged when it fits', () => {
    expect(truncateToBytes('abc', 10)).toBe('abc')
  })

  it('stays within the byte budget and marks the cut', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'
    const truncated = truncateToBytes(text, 20)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(20)
    expect(truncated).toContain('(truncated)')
  })

  it('does not split multi-byte UTF-8 characters', () => {
    const text = 'а\n'.repeat(100)
    const truncated = truncateToBytes(text, 37)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(37)
    expect(Buffer.from(truncated, 'utf8').toString('utf8')).toBe(truncated)
    expect(truncated.endsWith('(truncated)')).toBe(true)
  })

  it('never returns more bytes than the budget even with a tiny budget', () => {
    const truncated = truncateToBytes('hello world', 5)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(5)
  })
})

describe('format.ts — renderAsk', () => {
  it('renders empty hits as a useful pointer to other tools', () => {
    const text = renderAsk({ hits: [] }, 3)
    expect(text).toContain('No graph hits')
  })

  it('renders pointer lines with title and score, capped at maxHits', () => {
    const text = renderAsk({
      hits: [
        { title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', snippet: 'function issueToken()', score: 1.33 },
        { title: 'verify · function', pointer: 'src/tokens.ts:L1-L3', score: 0.31 },
        { title: 'third', pointer: 'src/c.ts' },
      ],
    }, 2)
    expect(text).toContain('issueToken (function)')
    expect(text).toContain('src/auth.ts:L8-L10')
    expect(text).toContain('1.33')
    expect(text).toContain('verify (function)')
    expect(text).not.toContain('third')
  })
})

describe('format.ts — renderSkeleton', () => {
  it('renders signatures without bodies', () => {
    const text = renderSkeleton({
      file: 'src/auth.ts',
      entries: [
        { name: 'authenticate', kind: 'function', span: 'L3-L6', signature: 'function authenticate(user, password): boolean' },
      ],
    })
    expect(text).toContain('src/auth.ts')
    expect(text).toContain('authenticate (function) @L3-L6')
    expect(text).toContain('function authenticate(user, password): boolean')
  })

  it('handles missing entries', () => {
    expect(renderSkeleton({ file: 'x.ts' })).toContain('No indexed symbols')
  })
})

describe('format.ts — renderMap', () => {
  const mapPayload = {
    totals: { files: 3, symbols: 5, edges: 10, languages: ['typescript'] },
    dirs: [
      { path: 'src', files: 2, symbols: 4, hubs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] },
      { path: 'test', files: 1, symbols: 1 },
    ],
    hotspots: [
      { name: 'authenticate', path: 'src/auth.ts', span: 'L3-L6', inDegree: 3 },
      { name: 'verify', path: 'src/tokens.ts', inDegree: 2 },
    ],
    dropped: 4,
  }

  it('renders totals, dirs (hubs capped at 3), dropped note, hotspots (capped at 5)', () => {
    const text = renderMap(mapPayload, 4096)
    expect(text).toContain('repo map — 3 files · 5 symbols · 10 edges · typescript')
    expect(text).toContain('src   2 files · 4 symbols   hubs: a, b, c')
    // the 4th hub of the same dir must be capped out
    expect(text).not.toContain('a, b, c, d')
    expect(text).toContain('(… 4 more entries dropped)')
    expect(text).toContain('hotspots: authenticate @ src/auth.ts:L3-L6 (3 callers) · verify @ src/tokens.ts (2 callers)')
  })

  it('honors the byte budget', () => {
    const big = {
      ...mapPayload,
      dirs: Array.from({ length: 200 }, (_, i) => ({ path: `dir-${i}`, files: 1, symbols: 1, hubs: [{ name: `h${i}` }] })),
    }
    const text = renderMap(big, 512)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512)
    expect(text).toContain('(truncated)')
  })

  it('degrades gracefully on an empty payload', () => {
    const text = renderMap({}, 1024)
    expect(text).toBe('repo map')
  })
})

describe('format.ts — renderCheck', () => {
  it('reports a fresh graph', () => {
    const text = renderCheck({ graph: { ok: true, nodes: 42 } }, 10)
    expect(text).toContain('Fresh')
    expect(text).toContain('42 nodes')
  })

  it('reports drift with capped path lists', () => {
    const text = renderCheck({
      graph: {
        ok: false,
        added: ['a.ts', 'b.ts', 'c.ts'],
        removed: ['old.ts'],
        changed: [],
        stale: [],
        pending: 2,
      },
    }, 2)
    expect(text).toContain('Stale')
    expect(text).toContain('added: a.ts, b.ts (+1 more)')
    expect(text).toContain('removed: old.ts')
    expect(text).toContain('graft build')
  })

  it('reports a missing graph', () => {
    expect(renderCheck({ graph: { missing: true } }, 5)).toContain('No graft/')
  })

  it('notes the absent LLM context layer', () => {
    const text = renderCheck({ context: { missing: true }, graph: { ok: true } }, 5)
    expect(text).toContain('LLM context layer absent')
  })
})

describe('format.ts — renderError', () => {
  it('renders GraphError with code and hint', () => {
    const text = renderError(new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft'))
    expect(text).toContain('[GRAPH_CLI_MISSING]')
    expect(text).toContain('npm i -g @nanonets/graft')
  })

  it('falls back to GRAPH_FAILED for unknown errors', () => {
    expect(renderError(new Error('boom'))).toContain('[GRAPH_FAILED]')
    expect(renderError('stringy')).toContain('[GRAPH_FAILED]')
  })
})

describe('format.ts — renderPromptHits (pre-step)', () => {
  const payload = {
    query: 'where is auth',
    hits: [
      { title: 'authenticate · function', pointer: 'src/auth.ts:L3-L6', score: 0.9 },
      { title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', score: 0.7 },
    ],
  }

  it('renders compact pointer lines without code bodies, capped by hits', () => {
    const text = renderPromptHits(payload, 4096)
    expect(text).toContain('src/auth.ts:L3-L6')
    expect(text).toContain('authenticate')
    expect(text).toContain('src/auth.ts:L8-L10')
    // no source bodies leak in
    expect(text).not.toContain('function authenticate(')
  })

  it('honors the byte budget', () => {
    const big = {
      hits: Array.from({ length: 40 }, (_, i) => ({
        title: `symbol${i} · function`,
        pointer: `src/f${i}.ts:L${i}-L${i + 5}`,
        score: 0.5,
      })),
    }
    const text = renderPromptHits(big, 300)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(300)
  })

  it('returns an empty string when there are no hits (nothing to inject)', () => {
    expect(renderPromptHits({ hits: [] }, 4096)).toBe('')
    expect(renderPromptHits({}, 4096)).toBe('')
  })

  it('degrades to empty on unparseable hit shapes', () => {
    expect(renderPromptHits({ hits: [null, 42, 'x'] as unknown as never }, 4096)).toBe('')
  })
})

describe('format.ts — renderBlastRadius (post-edit)', () => {
  it('renders "who depends on" per symbol with caller pointers', () => {
    const text = renderBlastRadius('src/auth.ts', [
      { name: 'issueToken', callers: [{ name: 'authenticate', path: 'src/auth.ts', span: 'L3-L6' }] },
      { name: 'authenticate', callers: [{ name: 'login', path: 'src/web.ts', span: 'L20-L25' }] },
    ], 4096)
    expect(text).toContain('src/auth.ts')
    expect(text).toContain('issueToken')
    expect(text).toContain('authenticate @ src/auth.ts:L3-L6')
    expect(text).toContain('login @ src/web.ts:L20-L25')
  })

  it('returns empty when no symbol has callers (nothing worth injecting)', () => {
    expect(renderBlastRadius('src/auth.ts', [{ name: 'issueToken', callers: [] }], 4096)).toBe('')
    expect(renderBlastRadius('src/auth.ts', [], 4096)).toBe('')
  })

  it('caps the caller list per symbol and honors the byte budget', () => {
    const many = {
      name: 'hub',
      callers: Array.from({ length: 50 }, (_, i) => ({
        name: `c${i}`, path: `src/c${i}.ts`, span: `L1-L9`,
      })),
    }
    const text = renderBlastRadius('src/hub.ts', [many], 4096)
    expect(text).toContain('hub')
    // capped to a small number, not all 50 (each caller renders as "name @ path")
    const matches = text.match(/c\d+ @ /g) ?? []
    expect(matches.length).toBeLessThanOrEqual(5)
  })

  it('stays within a tiny byte budget without throwing', () => {
    const many = {
      name: 'hub',
      callers: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, path: `src/cccccccccccccccccc${i}.ts`, span: 'L1-L9' })),
    }
    const text = renderBlastRadius('src/hub.ts', [many], 120)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(120)
  })
})

describe('format.ts — renderPromptHitsSourced (P2a, spec #1)', () => {
  const payload = {
    hits: [
      { title: 'authenticate · function', pointer: 'src/auth.ts:L3-L6', score: 0.9, code: 'function authenticate(): boolean {\n  return true\n}' },
      { title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', score: 0.7 },
    ],
  }

  it('inlines the top hit crux and keeps the rest as pointers', () => {
    const text = renderPromptHitsSourced(payload, 4096)
    expect(text).toContain('with source')
    expect(text).toContain('src/auth.ts:L3-L6')
    expect(text).toContain('function authenticate(): boolean {') // the crux body
    expect(text).toContain('```') // fenced code block
    expect(text).toContain('src/auth.ts:L8-L10') // the second hit stays a pointer
  })

  it('falls back to plain pointers when the top hit has no code', () => {
    const noCode = { hits: [{ title: 'x · function', pointer: 'src/x.ts:L1-L2', score: 1 }] }
    const text = renderPromptHitsSourced(noCode, 4096)
    expect(text).toContain('pointers only') // the fallback renderPromptHits header
    expect(text).not.toContain('```')
  })

  it('handles an empty/missing hits list', () => {
    expect(renderPromptHitsSourced({ hits: [] }, 4096)).toBe('')
    expect(renderPromptHitsSourced({}, 4096)).toBe('')
  })

  it('honors the byte budget even with a long crux', () => {
    const long = { hits: [{ title: 'big', pointer: 'src/big.ts:L1-L9', code: 'line\n'.repeat(500) }] }
    const text = renderPromptHitsSourced(long, 200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200)
  })
})

describe('format.ts — renderNudge (P2a, spec #2)', () => {
  it('is a stable, tool-hinting reminder (never a ban)', () => {
    const a = renderNudge()
    const b = renderNudge()
    expect(a).toBe(b)
    expect(a).toContain('graph_find_code')
    expect(a).toContain('graph_repo_map')
    expect(a).not.toMatch(/forbidden|not allowed|refused/i) // a reminder, not a block
  })
})

// ---------------------------------------------------------------------------
// renderBlast (P2c #3) — graft blast --format json
// ---------------------------------------------------------------------------

const BLAST_JSON = {
  basis: 'working tree vs HEAD',
  depth: 2,
  changed: [{ path: 'src/a.ts', status: 'modified', ranges: [{ start: 1, end: 1 }], hunks: [] }],
  unindexed: [],
  deleted: [],
  seeds: [{ id: 'src/a.ts#alpha', name: 'alpha', kind: 'function', path: 'src/a.ts', span: 'L1-L1', wholeFile: false }],
  impacted: [
    { id: 'src/a.ts#beta', name: 'beta', kind: 'function', path: 'src/a.ts', span: 'L2-L2', relation: 'calls', depth: 1 },
    { id: 'src/b.ts#gamma', name: 'gamma', kind: 'function', path: 'src/b.ts', span: 'L2-L2', relation: 'calls', depth: 2 },
  ],
  modules: [],
  testModules: [],
  areas: [],
  reviewers: [],
}

describe('format.ts — renderBlast (P2c #3)', () => {
  it('renders basis header, changed files, seeds and impacted by depth', () => {
    const text = renderBlast(BLAST_JSON, 4096)
    expect(text).toContain('Blast radius (working tree vs HEAD, depth 2)')
    expect(text).toContain('src/a.ts (modified)')
    expect(text).toContain('alpha @ src/a.ts:L1-L1')
    expect(text).toContain('beta @ src/a.ts:L2-L2')
    expect(text).toContain('gamma @ src/b.ts:L2-L2')
    // impacted lines carry the relation and depth
    expect(text).toContain('(calls, depth 1)')
    expect(text).toContain('(calls, depth 2)')
  })

  it('empty impacted renders the no-impact line', () => {
    const text = renderBlast({ ...BLAST_JSON, seeds: [], impacted: [] }, 4096)
    expect(text).toContain('No impacted symbols')
  })

  it('no changed lines and no seeds renders the empty-diff line', () => {
    const text = renderBlast({ ...BLAST_JSON, changed: [], seeds: [], impacted: [] }, 4096)
    expect(text).toContain('No diff to analyze')
  })

  it('respects the byte budget and marks truncation', () => {
    const many = {
      ...BLAST_JSON,
      impacted: Array.from({ length: 80 }, (_, i) => ({
        id: `src/f${i}.ts#s${i}`, name: `s${i}`, kind: 'function', path: `src/f${i}.ts`, span: 'L1-L1', relation: 'calls', depth: 1,
      })),
    }
    const text = renderBlast(many, 300)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(400)
    expect(text).toContain('truncated')
  })

  it('lists unindexed changed files', () => {
    const text = renderBlast({ ...BLAST_JSON, unindexed: ['docs/x.md'] }, 4096)
    expect(text).toContain('docs/x.md')
  })
})
