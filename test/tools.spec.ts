import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { GraphSpawnOptions, GraphSpawnResult } from '../src/cli.ts'
import { GraphError, type runGraph, type runGraphJson, type GraphSpawnResult as SpawnResult } from '../src/cli.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildGraphTools, TOOL_NAMES, type ToolFailure } from '../src/tools.ts'
import { makeGraphDir, makeGitRepo, makeTmpRoot, removeTmpRoot } from './fixtures.ts'

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface Call {
  args: string[]
  options: GraphSpawnOptions
}

type Handler = (args: readonly string[], options: GraphSpawnOptions) => { json: unknown; code?: number } | GraphError

function fakeRunner(handler: Handler) {
  const calls: Call[] = []
  const runner: typeof runGraphJson = (async (args, options) => {
    calls.push({ args: [...args], options })
    const outcome = handler(args, options)
    if (outcome instanceof GraphError) throw outcome
    const result: GraphSpawnResult = { stdout: '', stderr: '', code: outcome.code ?? 0, viaNpx: false }
    return { json: outcome.json, code: outcome.code ?? 0, result }
  }) as typeof runGraphJson
  return { runner, calls }
}

function makeAgent(cwd: string | undefined): Agent {
  return {
    id: 'session-1',
    status: 'idle',
    session: { header: { id: 'session-1', createdAt: 0, ...(cwd !== undefined ? { cwd } : {}) } },
    inject: () => undefined,
    steer: () => undefined,
    followup: () => undefined,
  } as unknown as Agent
}

function fakeExec(cwd: string | undefined) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'tool',
    arguments: {},
    ...(cwd !== undefined ? { agent: makeAgent(cwd) } : {}),
    signal: new AbortController().signal,
  }
}

// Real CLI payload fixtures (captured from @nanonets/graft 0.18.0).
const ASK_JSON = {
  query: 'issueToken',
  mode: 'lexical',
  hits: [
    { kind: 'symbol', title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', snippet: 'function issueToken(user: string): string', score: 1.325615784605632 },
    { kind: 'symbol', title: 'verify · function', pointer: 'src/tokens.ts:L1-L3', snippet: 'function verify(token: string): boolean', score: 0.316460784605632 },
  ],
  coverage: 1,
  coverageStrong: 1,
}

const SKELETON_JSON = {
  file: 'src/auth.ts',
  entries: [
    { name: 'authenticate', kind: 'function', span: 'L3-L6', signature: 'function authenticate(user: string, password: string): boolean' },
    { name: 'issueToken', kind: 'function', span: 'L8-L10', signature: 'function issueToken(user: string): string' },
  ],
  saved: { files: 1, baselineChars: 341 },
}

const CALLERS_JSON = {
  query: 'issueToken',
  matches: [
    {
      symbol: { id: 'src/auth.ts#issueToken', name: 'issueToken', kind: 'function', path: 'src/auth.ts', span: 'L8-L10' },
      hits: [
        { id: 'src/auth.ts#authenticate', relation: 'calls', depth: 1, name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6' },
      ],
    },
  ],
  saved: { files: 1, baselineChars: 341 },
}

const GREP_JSON = {
  pattern: 'token',
  filesSearched: 3,
  totalHits: 5,
  groups: [
    {
      symbol: { id: 'src/auth.ts#authenticate', name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6' },
      path: 'src/auth.ts',
      inDegree: 1,
      hits: [
        { line: 4, text: 'const token = issueToken(user)' },
        { line: 5, text: 'return verify(token)' },
      ],
    },
    {
      symbol: { id: 'src/tokens.ts#verify', name: 'verify', kind: 'function', path: 'src/tokens.ts', span: 'L1-L3' },
      path: 'src/tokens.ts',
      inDegree: 1,
      hits: [{ line: 2, text: 'return token.startsWith' }],
    },
  ],
}

const MAP_JSON = {
  totals: { files: 3, symbols: 5, edges: 10, languages: ['typescript'] },
  dirs: [
    { path: 'src/auth.ts', files: 1, symbols: 3, languages: ['typescript'], hubs: [{ name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6', inDegree: 1 }], isFile: true },
    { path: 'src/index.ts', files: 1, symbols: 1, languages: ['typescript'], isFile: true },
  ],
  hotspots: [{ name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6', inDegree: 1 }],
  dropped: 0,
  saved: { files: 3, baselineTokens: 135 },
}

const CHECK_FRESH_JSON = {
  context: { ok: false, missing: true, contentDrift: [], removed: [], coverage: [], indexDrift: [] },
  graph: { ok: true, missing: false, added: [], removed: [], changed: [], stale: [], pending: 8, pendingIds: ['src/auth.ts'], nodes: 8 },
}

const CHECK_STALE_JSON = {
  context: { ok: false, missing: true, contentDrift: [], removed: [], coverage: [], indexDrift: [] },
  graph: { ok: false, missing: false, added: ['src/new.ts'], removed: ['src/gone.ts'], changed: ['src/auth.ts'], stale: [], pending: 0, nodes: 9 },
}

// ---------------------------------------------------------------------------
// shared setup
// ---------------------------------------------------------------------------

const CONFIG = { graphPath: '', timeoutMs: 8000, maxInjectBytes: 4096 }

let REPO = ''
let REPO_SRC = ''

function makeTools(fake: ReturnType<typeof fakeRunner>) {
  return buildGraphTools(CONFIG, {
    runGraphJson: fake.runner,
    processCwd: () => REPO_SRC,
  })
}

/** The registry-facing execute returns the canonical JSON value; narrow it. */
function asValue<T>(value: unknown): T {
  return value as T
}

interface FindCodeValue { ok: boolean; error?: string; hint?: string; mode?: string; hits?: Array<{ path: string; line?: number; endLine?: number; symbol?: string; kind?: string; snippet?: string; score?: number }> }
interface FileApiValue { ok: boolean; file?: string; entries?: Array<{ name: string; kind?: string; span?: string; signature?: string }> }
interface TraceValue { ok: boolean; root?: string; direction?: string; hits?: Array<{ name: string; path?: string; relation?: string }> }
interface FindAllValue { ok: boolean; totalHits?: number; filesSearched?: number; matches?: Array<{ path?: string; symbol?: string; line?: number; text?: string }> }
interface RepoMapValue { ok: boolean; totals?: { files?: number }; dirs?: Array<{ path: string; hubs: string[] }>; hotspots?: Array<{ name: string }>; mapText?: string }
interface FreshnessValue { ok: boolean; fresh?: boolean; drift?: { added: string[]; removed: string[]; changed: string[]; stale: string[] }; note?: string }

function renderedText(tool: unknown, args: unknown, value: unknown): string {
  const render = (tool as { output: { render: (a: unknown, v: unknown) => Array<{ text?: string }> } }).output.render
  return render(args, value)[0]?.text ?? ''
}

beforeAll(() => {
  REPO = makeGitRepo(makeTmpRoot('dsh-cg-tools-'))
  makeGraphDir(REPO)
  REPO_SRC = join(REPO, 'src')
})
afterAll(() => removeTmpRoot(REPO))

// ---------------------------------------------------------------------------
// stable contract
// ---------------------------------------------------------------------------

describe('tools.ts — stable contract', () => {
  it('exposes exactly the eight graph_* names (snake_case, ≤ 64)', () => {
    // graph_enrich is the opt-in local-LLM deep tool (P2c #7): its name is
    // part of the vocabulary even when deep.tool is off (registration is
    // conditional, the name is not).
    expect(Object.values(TOOL_NAMES)).toEqual([
      'graph_find_code',
      'graph_file_api',
      'graph_trace_calls',
      'graph_find_all',
      'graph_repo_map',
      'graph_check_freshness',
      'graph_blast',
      'graph_enrich',
    ])
    for (const toolName of Object.values(TOOL_NAMES)) {
      expect(toolName).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
    }
  })

  it('buildGraphTools returns definitions with matching names (enrich opt-in)', () => {
    const fake = fakeRunner(() => ({ json: ASK_JSON }))
    const tools = buildGraphTools(CONFIG, { runGraphJson: fake.runner })
    const names = Object.values(tools).map((tool) => tool.name)
    expect([...names].sort()).toEqual(Object.values(TOOL_NAMES).filter((name) => name !== 'graph_enrich').sort())
  })
})

// ---------------------------------------------------------------------------
// behaviors
// ---------------------------------------------------------------------------

describe('tools.ts — graph_find_code', () => {
  it('success: normalized hits + exact CLI args', async () => {
    const fake = fakeRunner((args) => {
      expect(args[0]).toBe('ask')
      return { json: ASK_JSON }
    })
    const tools = makeTools(fake)
    const value = asValue<FindCodeValue>(await tools.findCode.execute({ query: 'issueToken', limit: 2 }, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.hits).toHaveLength(2)
    expect(value.hits?.[0]).toMatchObject({ path: 'src/auth.ts', line: 8, endLine: 10, symbol: 'issueToken', kind: 'function' })
    expect(fake.calls[0]!.args).toEqual(['ask', 'issueToken', '--json', '-n', '2', REPO])
    expect(fake.calls[0]!.options.cwd).toBe(REPO)
    expect(fake.calls[0]!.options.graphPath).toBe('')
  })

  it('source/scope pass through; limit clamps to 1..10', async () => {
    const fake = fakeRunner(() => ({ json: ASK_JSON }))
    const tools = makeTools(fake)
    await tools.findCode.execute({ query: 'q', source: true, limit: 99, scope: 'src/auth' }, fakeExec(REPO_SRC))
    expect(fake.calls[0]!.args).toEqual(['ask', 'q', '--json', '-n', '10', '--source', '--in', 'src/auth', REPO])
    await tools.findCode.execute({ query: 'q', limit: -5 }, fakeExec(REPO_SRC))
    expect(fake.calls[1]!.args).toContain('1')
  })

  it('GRAPH_MISSING when no graph exists (no CLI call)', async () => {
    const bareRepo = makeGitRepo(makeTmpRoot('dsh-cg-tools-nograph-'))
    const fake = fakeRunner(() => ({ json: ASK_JSON }))
    const tools = makeTools(fake)
    const value = asValue<ToolFailure>(await tools.findCode.execute({ query: 'q' }, fakeExec(join(bareRepo, 'src'))))
    expect(value).toMatchObject({ ok: false, error: 'GRAPH_MISSING' })
    expect(value.hint).toContain(bareRepo)
    expect(fake.calls).toHaveLength(0)
    removeTmpRoot(bareRepo)
  })

  it('GRAPH_CLI_MISSING surfaces the install hint', async () => {
    const fake = fakeRunner(() => new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft'))
    const tools = makeTools(fake)
    const value = asValue<ToolFailure>(await tools.findCode.execute({ query: 'q' }, fakeExec(REPO_SRC)))
    expect(value).toMatchObject({ ok: false, error: 'GRAPH_CLI_MISSING', hint: 'npm i -g @nanonets/graft' })
  })

  it('GRAPH_BAD_JSON surfaces as a structured error', async () => {
    const fake = fakeRunner(() => new GraphError('GRAPH_BAD_JSON', 'graft ask: no JSON object in graft output'))
    const tools = makeTools(fake)
    const value = asValue<ToolFailure>(await tools.findCode.execute({ query: 'q' }, fakeExec(REPO_SRC)))
    expect(value).toMatchObject({ ok: false, error: 'GRAPH_BAD_JSON' })
  })

  it('renders markdown with pointers and snippets; failures render the code', async () => {
    const fake = fakeRunner(() => ({ json: ASK_JSON }))
    const tools = makeTools(fake)
    const value = await tools.findCode.execute({ query: 'issueToken' }, fakeExec(REPO_SRC))
    const text = renderedText(tools.findCode, { query: 'issueToken' }, value)
    expect(text).toContain('issueToken (function) @ src/auth.ts:L8-L10')
    expect(text).toContain('function issueToken(user: string): string')
    const failureText = renderedText(tools.findCode, {}, { ok: false, error: 'GRAPH_MISSING', hint: 'run graft build' })
    expect(failureText).toContain('GRAPH_MISSING')
  })
})

describe('tools.ts — graph_file_api', () => {
  it('success: normalized entries + exact args', async () => {
    const fake = fakeRunner(() => ({ json: SKELETON_JSON }))
    const tools = makeTools(fake)
    const value = asValue<FileApiValue>(await tools.fileApi.execute({ path: 'src/auth.ts' }, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.file).toBe('src/auth.ts')
    expect(value.entries).toHaveLength(2)
    expect(fake.calls[0]!.args).toEqual(['skeleton', 'src/auth.ts', '--json', REPO])
  })

  it('render lists signatures', async () => {
    const fake = fakeRunner(() => ({ json: SKELETON_JSON }))
    const tools = makeTools(fake)
    const value = await tools.fileApi.execute({ path: 'src/auth.ts' }, fakeExec(REPO_SRC))
    expect(renderedText(tools.fileApi, { path: 'src/auth.ts' }, value)).toContain('authenticate (function) @L3-L6')
  })
})

describe('tools.ts — graph_trace_calls', () => {
  it('defaults to direction in, depth 1; out+depth pass through', async () => {
    const fake = fakeRunner(() => ({ json: CALLERS_JSON }))
    const tools = makeTools(fake)
    const value = asValue<TraceValue>(await tools.traceCalls.execute({ symbol: 'issueToken' }, fakeExec(REPO_SRC)))
    expect(fake.calls[0]!.args).toEqual(['callers', 'issueToken', '--direction', 'in', '-d', '1', '--json', REPO])
    expect(value.root).toBe('issueToken')
    expect(value.direction).toBe('in')
    expect(value.hits?.[0]?.name).toBe('authenticate')
    await tools.traceCalls.execute({ symbol: 'authenticate', direction: 'out', depth: 3 }, fakeExec(REPO_SRC))
    expect(fake.calls[1]!.args).toEqual(['callers', 'authenticate', '--direction', 'out', '-d', '3', '--json', REPO])
  })

  it('render lists caller edges', async () => {
    const fake = fakeRunner(() => ({ json: CALLERS_JSON }))
    const tools = makeTools(fake)
    const value = await tools.traceCalls.execute({ symbol: 'issueToken' }, fakeExec(REPO_SRC))
    const text = renderedText(tools.traceCalls, { symbol: 'issueToken' }, value)
    expect(text).toContain('issueToken (in):')
    expect(text).toContain('authenticate @ src/auth.ts:L3-L6')
  })
})

describe('tools.ts — graph_find_all', () => {
  it('flattens groups, caps at 30, passes --in', async () => {
    const manyGroups = {
      ...GREP_JSON,
      totalHits: 100,
      groups: Array.from({ length: 50 }, (_, i) => ({
        symbol: { name: `fn${i}` },
        path: `src/f${i}.ts`,
        hits: [{ line: i, text: `hit ${i}` }],
      })),
    }
    const fake = fakeRunner(() => ({ json: manyGroups }))
    const tools = makeTools(fake)
    const value = asValue<FindAllValue>(await tools.findAll.execute({ pattern: 'token', path: 'src' }, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.totalHits).toBe(100)
    expect(value.matches).toHaveLength(30)
    expect(fake.calls[0]!.args).toEqual(['grep', 'token', '--json', '--in', 'src', REPO])
  })

  it('small result keeps everything and renders grouped', async () => {
    const fake = fakeRunner(() => ({ json: GREP_JSON }))
    const tools = makeTools(fake)
    const value = asValue<FindAllValue>(await tools.findAll.execute({ pattern: 'token' }, fakeExec(REPO_SRC)))
    expect(value.matches).toHaveLength(3)
    const text = renderedText(tools.findAll, { pattern: 'token' }, value)
    expect(text).toContain('### src/auth.ts · authenticate')
    expect(text).toContain('- L4: const token = issueToken(user)')
  })
})

describe('tools.ts — graph_repo_map', () => {
  it('normalizes totals/dirs/hotspots and carries mapText', async () => {
    const fake = fakeRunner(() => ({ json: MAP_JSON }))
    const tools = makeTools(fake)
    const value = asValue<RepoMapValue>(await tools.repoMap.execute({ maxDirs: 8 }, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.totals?.files).toBe(3)
    expect(value.dirs?.[0]?.hubs).toEqual(['authenticate'])
    expect(value.hotspots?.[0]?.name).toBe('authenticate')
    expect(typeof value.mapText).toBe('string')
    expect(fake.calls[0]!.args).toEqual(['map', '--max-dirs', '8', '--json', REPO])
  })

  it('render returns the map text', async () => {
    const fake = fakeRunner(() => ({ json: MAP_JSON }))
    const tools = makeTools(fake)
    const value = await tools.repoMap.execute({ maxDirs: 8 }, fakeExec(REPO_SRC))
    expect(renderedText(tools.repoMap, {}, value)).toContain('repo map — 3 files · 5 symbols · 10 edges')
  })
})

describe('tools.ts — graph_check_freshness', () => {
  it('exit 1 with drift is DATA (fresh=false, not an error)', async () => {
    const fake = fakeRunner(() => ({ json: CHECK_STALE_JSON, code: 1 }))
    const tools = makeTools(fake)
    const value = asValue<FreshnessValue>(await tools.checkFreshness.execute({}, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.fresh).toBe(false)
    expect(value.drift?.added).toEqual(['src/new.ts'])
    expect(value.drift?.changed).toEqual(['src/auth.ts'])
    expect(fake.calls[0]!.args).toEqual(['check', '--json', REPO])
    const text = renderedText(tools.checkFreshness, {}, value)
    expect(text).toContain('Stale')
  })

  it('exit 0 + ok true is fresh', async () => {
    const fake = fakeRunner(() => ({ json: CHECK_FRESH_JSON, code: 0 }))
    const tools = makeTools(fake)
    const value = asValue<FreshnessValue>(await tools.checkFreshness.execute({}, fakeExec(REPO_SRC)))
    expect(value.fresh).toBe(true)
    expect(renderedText(tools.checkFreshness, {}, value)).toContain('Fresh')
  })
})

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

interface BlastValue {
  ok: boolean
  error?: string
  hint?: string
  basis?: string
  depth?: number
  changed?: Array<{ path: string; status?: string }>
  seeds?: Array<{ name: string; path: string; span?: string }>
  impacted?: Array<{ name: string; path: string; span?: string; relation?: string; depth?: number }>
  unindexed?: string[]
  blastText?: string
}

describe('tools.ts — graph_blast (P2c #3)', () => {
  it('passes --base/--depth to the CLI and normalizes seeds/impacted', async () => {
    const fake = fakeRunner(() => ({ json: BLAST_JSON }))
    const tools = makeTools(fake)
    const value = asValue<BlastValue>(await tools.blast.execute({ base: 'origin/main', depth: 3 }, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.basis).toBe('working tree vs HEAD')
    expect(value.depth).toBe(3)
    expect(value.changed?.[0]?.path).toBe('src/a.ts')
    expect(value.seeds?.[0]?.name).toBe('alpha')
    expect(value.impacted).toHaveLength(2)
    expect(fake.calls[0]!.args).toEqual(['blast', '--base', 'origin/main', '--depth', '3', '--format', 'json', REPO])
  })

  it('defaults: no --base flag, depth 2', async () => {
    const fake = fakeRunner(() => ({ json: BLAST_JSON }))
    const tools = makeTools(fake)
    await tools.blast.execute({}, fakeExec(REPO_SRC))
    expect(fake.calls[0]!.args).toEqual(['blast', '--depth', '2', '--format', 'json', REPO])
  })

  it('render returns the blast text with the impacted list', async () => {
    const fake = fakeRunner(() => ({ json: BLAST_JSON }))
    const tools = makeTools(fake)
    const value = await tools.blast.execute({}, fakeExec(REPO_SRC))
    const text = renderedText(tools.blast, {}, value)
    expect(text).toContain('Blast radius (working tree vs HEAD, depth 2)')
    expect(text).toContain('beta @ src/a.ts:L2-L2')
  })

  it('CLI exit 1 is a failure value (fail-open)', async () => {
    const fake = fakeRunner(() => ({ json: {}, code: 1 }))
    const tools = makeTools(fake)
    const value = asValue<ToolFailure>(await tools.blast.execute({}, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(false)
    expect(value.error).toBe('BLAST_FAILED')
  })

  it('GRAPH_MISSING when the repo has no graph', async () => {
    const bareRoot = makeTmpRoot('dsh-cg-tools-blast-bare-')
    const bareRepo = makeGitRepo(bareRoot)
    const fake = fakeRunner(() => ({ json: BLAST_JSON }))
    const tools = makeTools(fake)
    const value = asValue<ToolFailure>(await tools.blast.execute({}, fakeExec(join(bareRepo, 'src'))))
    expect(value).toMatchObject({ ok: false, error: 'GRAPH_MISSING' })
    expect(fake.calls).toHaveLength(0)
    removeTmpRoot(bareRepo)
  })
})

describe('tools.ts — PTC / Code Mode readiness (P2c #4)', () => {
  it('every tool carries a lossless-JSON output schema (host SDK projection requirement)', async () => {
    const fake = fakeRunner(() => ({ json: MAP_JSON }))
    const tools = makeTools(fake)
    for (const tool of Object.values(tools)) {
      expect(tool.output, tool.name).toBeTypeOf('object')
      const schema = (tool.output as { schema?: unknown }).schema
      expect(schema, `${tool.name}: output schema present`).toBeTypeOf('object')
      // The host's PTC SDK projection (sdkSchemas) THROWS when the schema is
      // not lossless JSON — pin that contract so a future tool cannot break
      // Code Mode silently.
      const roundTripped = JSON.parse(JSON.stringify(schema))
      expect(roundTripped, `${tool.name}: lossless JSON`).toEqual(schema)
      expect((roundTripped as { properties?: Record<string, unknown> }).properties?.ok, tool.name).toBeDefined()
    }
  })
})

describe('tools.ts — cwd resolution', () => {
  it('uses the session header cwd when present, process cwd as fallback', async () => {
    const fake = fakeRunner(() => ({ json: MAP_JSON }))
    const tools = makeTools(fake)
    // exec WITHOUT an agent: deps.processCwd supplies the repo
    await tools.repoMap.execute({}, fakeExec(undefined))
    expect(fake.calls[0]!.options.cwd).toBe(REPO)
    // exec WITH an agent pointing at another repo
    const otherRepo = makeGitRepo(makeTmpRoot('dsh-cg-tools-other-'))
    makeGraphDir(otherRepo)
    await tools.repoMap.execute({}, fakeExec(join(otherRepo, 'x')))
    expect(fake.calls[1]!.options.cwd).toBe(otherRepo)
    removeTmpRoot(otherRepo)
  })
})

// ---------------------------------------------------------------------------
// graph_enrich (P2c #7 — explicit local LLM deep pass)
// ---------------------------------------------------------------------------


interface TextCall {
  args: string[]
  options: GraphSpawnOptions
}

type TextHandler = (args: readonly string[], options: GraphSpawnOptions) => SpawnResult | Error

function fakeTextRunner(handler: TextHandler) {
  const calls: TextCall[] = []
  const runner = async (args: readonly string[], options: GraphSpawnOptions): Promise<SpawnResult> => {
    calls.push({ args: [...args], options })
    const outcome = handler(args, options)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { runner, calls }
}

const DEEP_CONFIG = {
  ...CONFIG,
  deep: { tool: true, model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1', provider: 'openai', apiKey: 'local-key', apiKeyEnv: '' },
}

function makeDeepTools(fake: ReturnType<typeof fakeRunner>, text: ReturnType<typeof fakeTextRunner>, config = DEEP_CONFIG) {
  return buildGraphTools(config, {
    runGraphJson: fake.runner,
    runGraphText: text.runner,
    processCwd: () => REPO_SRC,
  })
}

describe('tools.ts — graph_enrich (P2c #7)', () => {
  it('is not registered by default (deep.tool absent)', () => {
    // plain CONFIG has no deep → no enrich tool
    const plain = buildGraphTools(CONFIG, { runGraphJson: (async () => { throw new Error('unused') }) as never, processCwd: () => REPO_SRC })
    expect(plain.enrich).toBeUndefined()
  })

  it('is registered only when deep.tool is true', () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: '', stderr: '', code: 0, viaNpx: false }))
    const on = makeDeepTools(fake, text, { ...CONFIG, deep: { ...DEEP_CONFIG.deep!, tool: true } })
    expect(on.enrich).toBeDefined()
    const off = makeDeepTools(fake, text, { ...CONFIG, deep: { ...DEEP_CONFIG.deep!, tool: false } })
    expect(off.enrich).toBeUndefined()
  })

  it('fails DEEP_MODEL_MISSING without any CLI call when deep.model is empty', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: '', stderr: '', code: 0, viaNpx: false }))
    const tools = makeDeepTools(fake, text, { ...CONFIG, deep: { ...DEEP_CONFIG.deep!, model: '  ' } })
    const value = asValue<{ ok: boolean; error?: string; hint?: string }>(
      await tools.enrich!.execute({}, fakeExec(REPO_SRC)),
    )
    expect(value.ok).toBe(false)
    expect(value.error).toBe('DEEP_MODEL_MISSING')
    expect(text.calls).toHaveLength(0)
  })

  it('fails DEEP_KEY_MISSING without any CLI call when neither apiKey nor apiKeyEnv resolves', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: '', stderr: '', code: 0, viaNpx: false }))
    const tools = makeDeepTools(fake, text, { ...CONFIG, deep: { ...DEEP_CONFIG.deep!, apiKey: '', apiKeyEnv: 'SURELY_UNSET_ENV_1' } })
    const value = asValue<{ ok: boolean; error?: string; hint?: string }>(
      await tools.enrich!.execute({}, fakeExec(REPO_SRC)),
    )
    expect(value.ok).toBe(false)
    expect(value.error).toBe('DEEP_KEY_MISSING')
    expect(text.calls).toHaveLength(0)
  })

  it('resolves the key from the named env var (deep.apiKeyEnv) — ambient GRAFT_API_KEY is never read', async () => {
    process.env.DSH_TEST_DEEP_KEY = 'from-env'
    process.env.GRAFT_API_KEY = 'ambient-must-not-leak'
    try {
      const fake = fakeRunner(() => ({ json: {} }))
      const text = fakeTextRunner(() => ({ stdout: 'ok', stderr: '', code: 0, viaNpx: false }))
      const tools = makeDeepTools(fake, text, { ...CONFIG, deep: { ...DEEP_CONFIG.deep!, apiKey: '', apiKeyEnv: 'DSH_TEST_DEEP_KEY' } })
      const value = asValue<{ ok: boolean }>(await tools.enrich!.execute({}, fakeExec(REPO_SRC)))
      expect(value.ok).toBe(true)
      expect(text.calls).toHaveLength(1)
      expect(text.calls[0]!.options.extraEnv).toMatchObject({ GRAFT_API_KEY: 'from-env' })
    } finally {
      delete process.env.DSH_TEST_DEEP_KEY
      delete process.env.GRAFT_API_KEY
    }
  })

  it('spawns graft build --deep with ONLY the local LLM env and reports the summary', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: 'deep pass done: 3 files enriched', stderr: '', code: 0, viaNpx: false }))
    const tools = makeDeepTools(fake, text)
    const value = asValue<{ ok: boolean; summary?: string }>(await tools.enrich!.execute({}, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('deep pass done')
    expect(text.calls).toHaveLength(1)
    const call = text.calls[0]!
    expect(call.args).toEqual(['build', '--deep', REPO])
    expect(call.options.cwd).toBe(REPO)
    // Spec: ONLY these vars are forwarded — key from config, never ambient.
    expect(call.options.extraEnv).toEqual({
      GRAFT_PROVIDER: 'openai',
      GRAFT_BASE_URL: 'http://127.0.0.1:11434/v1',
      GRAFT_MODEL: 'qwen2.5:7b',
      GRAFT_API_KEY: 'local-key',
    })
    // A local deep pass over a whole repo is allowed to take a long time:
    // the timeout floor is 10 minutes regardless of the query timeout.
    expect(call.options.timeoutMs).toBeGreaterThanOrEqual(600_000)
  })

  it('reports DEEP_FAILED with a stderr tail when the pass exits non-zero', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: '', stderr: 'model rejected: Ollama is not running at 127.0.0.1:11434', code: 1, viaNpx: false }))
    const tools = makeDeepTools(fake, text)
    const value = asValue<{ ok: boolean; error?: string; hint?: string }>(await tools.enrich!.execute({}, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(false)
    expect(value.error).toBe('DEEP_FAILED')
    expect(value.hint).toContain('Ollama is not running')
  })

  it('fails open with NO_GIT_ROOT when the cwd is outside any git repository', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => ({ stdout: '', stderr: '', code: 0, viaNpx: false }))
    const tools = buildGraphTools(DEEP_CONFIG, {
      runGraphJson: fake.runner,
      runGraphText: text.runner,
      processCwd: () => '/no-such-directory-anywhere',
    })
    const value = asValue<{ ok: boolean; error?: string }>(await tools.enrich!.execute({}, fakeExec(undefined)))
    expect(value.ok).toBe(false)
    expect(value.error).toBe('NO_GIT_ROOT')
    expect(text.calls).toHaveLength(0)
  })

  it('fails open when the CLI is missing (seam throws GRAPH_CLI_MISSING)', async () => {
    const fake = fakeRunner(() => ({ json: {} }))
    const text = fakeTextRunner(() => {
      throw new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft')
    })
    const tools = makeDeepTools(fake, text)
    const value = asValue<{ ok: boolean; error?: string; hint?: string }>(await tools.enrich!.execute({}, fakeExec(REPO_SRC)))
    expect(value.ok).toBe(false)
    expect(value.error).toBe('GRAPH_CLI_MISSING')
    expect(value.hint).toContain('npm i -g')
  })
})
