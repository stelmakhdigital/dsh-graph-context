import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { GraphSpawnOptions, GraphSpawnResult } from '../src/cli.ts'
import { GraphError, type runGraphJson, type spawnDetachedBuild } from '../src/cli.ts'
import { registerHooks, reorderToolsForGraph, type HooksConfig } from '../src/hooks.ts'
import { LOCK_FILE_NAME, SessionStateStore } from '../src/session-state.ts'
import { makeGitRepo, makeTmpRoot, removeTmpRoot } from './fixtures.ts'

const BLAST_JSON_HOOKS = {
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
  modules: [], testModules: [], areas: [], reviewers: [],
}

const MAP_JSON = {
  totals: { files: 3, symbols: 5, edges: 10, languages: ['typescript'] },
  dirs: [{ path: 'src', files: 1, symbols: 3, hubs: [{ name: 'authenticate' }] }],
  hotspots: [],
  dropped: 0,
}

const CONFIG: HooksConfig = {
  injectSessionMap: true,
  injectPromptHits: true,
  injectBlastRadius: true,
  autoBuild: true,
  autoSync: true,
  maxInjectBytes: 4096,
  promptMinChars: 12,
  timeoutMs: 8000,
  buildTimeoutMs: 20_000,
  graphPath: '',
  editToolNames: ['write', 'edit'],
  injectMode: 'sourced',
  nudgeOnBlindSearch: true,
  scopeFromLastEdit: false,
  metrics: true,
  guardWiringReads: false,
  injectSubagentMap: true,
  reinjectAfterCompaction: true,
  toolOrder: true,
  blastOnResume: true,
}

interface Injected {
  content: Array<{ type: string; text: string }>
  source: { kind: string; plugin: string }
}

function makeAgent(cwd: string | undefined, failInject = false): Agent {
  return {
    id: 'session-x',
    status: 'idle',
    session: { header: { id: 'session-x', createdAt: 0, ...(cwd !== undefined ? { cwd } : {}) } },
    inject: vi.fn((message: { content: unknown; source: unknown }) => {
      if (failInject) throw new Error('agent disposed')
    }),
    steer: vi.fn(),
    followup: vi.fn(),
  } as unknown as Agent
}

function injectedText(agent: Agent): string {
  const calls = (agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls
  const last = calls[calls.length - 1]?.[0] as { content: Array<{ text?: string }> }
  return last.content[0]?.text ?? ''
}

function makeCtx() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context & { on: (event: string, listener: (...args: unknown[]) => unknown) => () => void }
  return { ctx, listeners }
}

function makeMapRunner() {
  const fake: { runner: typeof runGraphJson; calls: Array<{ args: string[]; options: GraphSpawnOptions }> } = {
    runner: (async (args, options) => {
      fake.calls.push({ args: [...args], options })
      const result: GraphSpawnResult = { stdout: '', stderr: '', code: 0, viaNpx: false }
      return { json: MAP_JSON, code: 0, result }
    }) as typeof runGraphJson,
    calls: [],
  }
  return fake
}

function makeBuildFake() {
  let resolveExited: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  const calls: Array<{ root: string; options: { graphPath?: string; buildTimeoutMs: number } }> = []
  const spawnBuild: typeof spawnDetachedBuild = (root, options) => {
    calls.push({ root, options })
    return { pid: 4242, exited }
  }
  return { spawnBuild, calls, resolveExited: () => resolveExited?.() }
}

async function fireSessionStart(
  listeners: Map<string, (...args: unknown[]) => unknown>,
  agent: Agent,
  source: SessionStartSource = 'startup',
): Promise<void> {
  const listener = listeners.get('agent/session-start')
  expect(listener).toBeDefined()
  // emit-mode: the listener must settle synchronously (no await in the loop)
  const returned = listener?.({ agent, source })
  if (returned instanceof Promise) await returned // our impl returns void; keep the guard
  // let the detached work run
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('hooks.ts — session-start (P0)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  it('with a graph: injects the rendered repo map for the next request', async () => {
    root = makeTmpRoot('dsh-cg-hooks-map-')
    repo = makeGitRepo(join(root, 'repo'))
    const graphDir = join(repo, 'graft')
    // create the graph dir on disk
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(graphDir, '.graph'), { recursive: true })
    writeFileSync(join(graphDir, 'INDEX.md'), '# i\n')

    const { ctx, listeners } = makeCtx()
    const mapRunner = makeMapRunner()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: ctx.logger as { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
      processCwd: () => repo,
    }, mapRunner.runner)

    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)

    expect(mapRunner.calls).toHaveLength(1)
    expect(mapRunner.calls[0]!.args).toEqual(['map', '--json', repo])
    expect(agent.inject).toHaveBeenCalled()
    const text = injectedText(agent)
    expect(text).toContain('Repo context graph')
    expect(text).toContain('repo map — 3 files · 5 symbols · 10 edges')
    // the injected message carries the plugin source
    const msg = (agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { source: { kind: string; plugin: string } }
    expect(msg.source).toEqual({ kind: 'plugin', plugin: 'dsh-context-graph' })
    expect(buildFake.calls).toHaveLength(0)
  })

  it('without a graph: starts one detached build under the lock, injects a pointer', async () => {
    root = makeTmpRoot('dsh-cg-hooks-build-')
    repo = makeGitRepo(join(root, 'repo'))
    const { ctx, listeners } = makeCtx()
    const mapRunner = makeMapRunner()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger: ctx.logger as { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
      processCwd: () => repo,
    }, mapRunner.runner)

    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)

    expect(buildFake.calls).toHaveLength(1)
    expect(buildFake.calls[0]!.root).toBe(repo)
    // the lock file exists while the build is "running"
    const lock = JSON.parse(readFileSync(join(repo, LOCK_FILE_NAME), 'utf8')) as { pid: number }
    expect(lock.pid).toBe(process.pid)
    const text = injectedText(agent)
    expect(text).toContain('being built')
    // map was not called (no graph yet)
    expect(mapRunner.calls).toHaveLength(0)

    // the build finishes → the lock frees
    buildFake.resolveExited()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(() => readFileSync(join(repo, LOCK_FILE_NAME), 'utf8')).toThrow()
  })

  it('two sessions: the second one sees the lock and does NOT start a second build', async () => {
    root = makeTmpRoot('dsh-cg-hooks-twice-')
    repo = makeGitRepo(join(root, 'repo'))
    const { ctx, listeners } = makeCtx()
    const mapRunner = makeMapRunner()
    const buildFake = makeBuildFake()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, mapRunner.runner)

    await fireSessionStart(listeners, makeAgent(join(repo, 'a')))
    await fireSessionStart(listeners, makeAgent(join(repo, 'b')))

    expect(buildFake.calls).toHaveLength(1)
    // both sessions got a pointer (one "started", one "already running")
    buildFake.resolveExited()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('outside a git repo: total silence (no inject, no build, no log error)', async () => {
    root = makeTmpRoot('dsh-cg-hooks-nogit-')
    const plain = join(root, 'plain')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(plain, { recursive: true })
    const { ctx, listeners } = makeCtx()
    const buildFake = makeBuildFake()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => plain,
    }, makeMapRunner().runner)

    const agent = makeAgent(plain)
    await fireSessionStart(listeners, agent)
    expect((agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0)
    expect(buildFake.calls).toHaveLength(0)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('session header has no cwd: total silence (no fallback to process cwd)', async () => {
    // Observed-in-the-wild regression: a server process whose launch dir is a
    // (huge) git repo. The session header may not carry a cwd yet at the
    // session-start event. Falling back to process.cwd() there started a
    // background graft build of the WRONG repo. The hook must stay silent.
    root = makeTmpRoot('dsh-cg-hooks-nocwd-')
    const repoNoGraph = makeGitRepo(join(root, 'server-launch-dir'))
    const { ctx, listeners } = makeCtx()
    const mapRunner = makeMapRunner()
    const buildFake = makeBuildFake()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repoNoGraph,
    }, mapRunner.runner)

    // header cwd is absent (makeAgent(undefined) omits it)
    const agent = makeAgent(undefined)
    await fireSessionStart(listeners, agent)

    expect((agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0)
    expect(buildFake.calls).toHaveLength(0)
    expect(mapRunner.calls).toHaveLength(0)
    // no lock left in the (wrong) repo
    expect(() => readFileSync(join(repoNoGraph, LOCK_FILE_NAME), 'utf8')).toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('CLI missing: the hook stays silent and never throws (fail-open)', async () => {
    root = makeTmpRoot('dsh-cg-hooks-nocli-')
    repo = makeGitRepo(join(root, 'repo'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(repo, 'graft', '.graph'), { recursive: true })
    writeFileSync(join(repo, 'graft', 'INDEX.md'), '# i\n')
    const { ctx, listeners } = makeCtx()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const runner = ((async () => {
      throw new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft')
    }) as unknown) as typeof runGraphJson
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, runner)

    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)
    // no inject (documented) and no log noise either: the system-prompt
    // section already tells the model what to do without the CLI
    expect((agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a slow/failed CLI never throws into the loop (timeout)', async () => {
    root = makeTmpRoot('dsh-cg-hooks-timeout-')
    repo = makeGitRepo(join(root, 'repo'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(repo, 'graft', '.graph'), { recursive: true })
    writeFileSync(join(repo, 'graft', 'INDEX.md'), '# i\n')
    const { ctx, listeners } = makeCtx()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const runner = ((async () => {
      throw new GraphError('GRAPH_TIMEOUT', 'graft map timed out after 8000ms')
    }) as unknown) as typeof runGraphJson
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, runner)

    const agent = makeAgent(join(repo, 'src'))
    // must not throw
    await fireSessionStart(listeners, agent)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('a disposed agent (inject throws) does not break the hook', async () => {
    root = makeTmpRoot('dsh-cg-hooks-disposed-')
    repo = makeGitRepo(join(root, 'repo'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(repo, 'graft', '.graph'), { recursive: true })
    writeFileSync(join(repo, 'graft', 'INDEX.md'), '# i\n')
    const { ctx, listeners } = makeCtx()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, makeMapRunner().runner)

    const agent = makeAgent(join(repo, 'src'), true)
    await fireSessionStart(listeners, agent)
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('injectSessionMap=false registers nothing', async () => {
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, { ...CONFIG, injectSessionMap: false }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }, makeMapRunner().runner)
    expect(listeners.has('agent/session-start')).toBe(false)
  })

  it('autoBuild=false with no graph: no build, no inject, no crash', async () => {
    root = makeTmpRoot('dsh-cg-hooks-nobuild-')
    repo = makeGitRepo(join(root, 'repo'))
    const { ctx, listeners } = makeCtx()
    const buildFake = makeBuildFake()
    registerHooks(ctx, { ...CONFIG, autoBuild: false }, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)
    expect(buildFake.calls).toHaveLength(0)
    expect((agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// P1 fixtures + helpers
// ---------------------------------------------------------------------------

const ASK_JSON = {
  query: 'where is auth',
  hits: [
    { title: 'authenticate · function', pointer: 'src/auth.ts:L3-L6', score: 0.9 },
    { title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', score: 0.7 },
  ],
}

const ASK_OTHER_JSON = {
  query: 'login flow',
  hits: [
    { title: 'login · function', pointer: 'src/web.ts:L20-L25', score: 0.8 },
  ],
}

const SKELETON_JSON = {
  file: 'src/auth.ts',
  entries: [
    { name: 'authenticate', kind: 'function', span: 'L3-L6', signature: 'function authenticate(user: string, password: string): boolean' },
    { name: 'issueToken', kind: 'function', span: 'L8-L10', signature: 'function issueToken(user: string): string' },
  ],
}

const CALLERS_AUTHENTICATE_JSON = {
  query: 'authenticate',
  matches: [
    {
      symbol: { name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6' },
      hits: [{ name: 'login', kind: 'function', path: 'src/web.ts', span: 'L20-L25', relation: 'calls', depth: 1 }],
    },
  ],
}

const CALLERS_ISSUETOKEN_JSON = {
  query: 'issueToken',
  matches: [
    {
      symbol: { name: 'issueToken', kind: 'function', path: 'src/auth.ts', span: 'L8-L10' },
      hits: [{ name: 'authenticate', kind: 'function', path: 'src/auth.ts', span: 'L3-L6', relation: 'calls', depth: 1 }],
    },
  ],
}

/** A runGraph fake routed by subcommand/argument predicates. */
function makeRoutedRunner(routes: Array<{
  match: (args: string[]) => boolean
  json?: unknown
  code?: number
  error?: GraphError
}>) {
  const calls: Array<{ args: string[]; options: GraphSpawnOptions }> = []
  const runner = (async (args: readonly string[], options: GraphSpawnOptions) => {
    const argCopy = [...args]
    calls.push({ args: argCopy, options })
    const route = routes.find((r) => r.match(argCopy))
    if (route === undefined) throw new GraphError('GRAPH_FAILED', `no route for: ${argCopy.join(' ')}`)
    if (route.error !== undefined) throw route.error
    const result: GraphSpawnResult = { stdout: '', stderr: '', code: 0, viaNpx: false }
    return { json: route.json, code: route.code ?? 0, result }
  }) as typeof runGraphJson
  return { runner, calls }
}

function makeGraphRepo(root: string, repoName = 'repo'): string {
  const repo = makeGitRepo(join(root, repoName))
  mkdirSync(join(repo, 'graft', '.graph'), { recursive: true })
  writeFileSync(join(repo, 'graft', 'INDEX.md'), '# i\n')
  return repo
}

function userMessages(texts: string[]): unknown[] {
  return texts.map((text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

async function firePreStep(
  listeners: Map<string, (...args: unknown[]) => unknown>,
  agent: Agent,
  texts: string[],
): Promise<{ kind: string; messages?: unknown[] }> {
  const listener = listeners.get('agent/pre-step')
  expect(listener).toBeDefined()
  const messages = userMessages(texts)
  const next = async () => ({ kind: 'enter', messages: [...messages] })
  const decision = await listener?.({
    agent,
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, next)
  return decision as { kind: string; messages?: unknown[] }
}

async function firePostExecute(
  listeners: Map<string, (...args: unknown[]) => unknown>,
  exec: { name: string; arguments: unknown; agent?: Agent },
  block = false,
): Promise<Record<string, unknown>> {
  const listener = listeners.get('tools/post-execute')
  expect(listener).toBeDefined()
  const next = async () => (block
    ? { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    : { kind: 'accept', value: { ok: true } })
  const decision = await listener?.(exec, { content: [] }, next)
  return decision as Record<string, unknown>
}

async function fireTurnStop(
  listeners: Map<string, (...args: unknown[]) => unknown>,
  agent: Agent,
): Promise<void> {
  const listener = listeners.get('agent/turn-stopping')
  expect(listener).toBeDefined()
  const returned = listener?.({ agent, turn: 1, signal: new AbortController().signal })
  if (returned instanceof Promise) await returned
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// P1: pre-step retrieval
// ---------------------------------------------------------------------------

describe('hooks.ts — pre-step retrieval (P1)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  it('short prompt (< promptMinChars): no CLI call, decision passes through', async () => {
    root = makeTmpRoot('dsh-cg-prestep-short-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1) // no context appended
    expect(routed.calls).toHaveLength(0)
  })

  it('prompt >= min with hits (injectMode pointers): appends a plugin context message with pointers only', async () => {
    root = makeTmpRoot('dsh-cg-prestep-hits-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, injectMode: 'pointers' }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const prompt = 'where is authentication in this repo'
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    expect(routed.calls).toHaveLength(1)
    // spec: ask --json -n 3, NO --source in pointers mode, prompt as-is, repo dir last
    expect(routed.calls[0]!.args).toEqual(['ask', prompt, '--json', '-n', '3', repo])
    const added = decision.messages![1] as { content: Array<{ text?: string }>; source: { kind: string; plugin: string } }
    const text = added.content.map((block) => block.text ?? '').join('')
    expect(added.source).toEqual({ kind: 'plugin', plugin: 'dsh-context-graph' })
    expect(text).toContain('src/auth.ts:L3-L6')
    expect(text).toContain('authenticate')
    expect(text).not.toContain('function authenticate(')
  })

  it('the same top hit again: no re-injection, no second CLI call', async () => {
    root = makeTmpRoot('dsh-cg-prestep-dup-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    const store = new SessionStateStore()
    registerHooks(ctx, CONFIG, {
      state: store,
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const prompt = 'where is authentication in this repo'
    const first = await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(first.messages).toHaveLength(2)
    const second = await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(second.messages).toHaveLength(1) // deduped by (session, repo)
    expect(routed.calls).toHaveLength(1)
  })

  it('a different top hit: injected again', async () => {
    root = makeTmpRoot('dsh-cg-prestep-diff-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask' && a[1] === 'prompt A is long enough', json: ASK_JSON },
      { match: (a) => a[0] === 'ask' && a[1] === 'prompt B is long enough', json: ASK_OTHER_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const a = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['prompt A is long enough'])
    expect(a.messages).toHaveLength(2)
    const b = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['prompt B is long enough'])
    expect(b.messages).toHaveLength(2)
    expect(routed.calls).toHaveLength(2)
  })

  it('no session cwd: silent pass-through (no guess at the server launch dir)', async () => {
    root = makeTmpRoot('dsh-cg-prestep-nocwd-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const decision = await firePreStep(listeners, makeAgent(undefined), ['a long enough prompt'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('no graph: silent (no retrieval against a missing index)', async () => {
    root = makeTmpRoot('dsh-cg-prestep-nograph-')
    repo = makeGitRepo(join(root, 'repo')) // no graft/
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['a long enough prompt'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('CLI failure: decision passes through, never throws', async () => {
    root = makeTmpRoot('dsh-cg-prestep-fail-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', error: new GraphError('GRAPH_TIMEOUT', 'ask timed out') },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, routed.runner)

    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['a long enough prompt'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
    expect(logger.error).toHaveBeenCalled()
  })

  it('injectPromptHits=false: the listener passes straight through', async () => {
    root = makeTmpRoot('dsh-cg-prestep-off-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, injectPromptHits: false }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)

    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['a long enough prompt'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// P1: post-execute blast radius + dirty
// ---------------------------------------------------------------------------

describe('hooks.ts — post-execute blast + dirty (P1)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function blastRoutes() {
    return makeRoutedRunner([
      { match: (a) => a[0] === 'skeleton' && a[1] === 'src/auth.ts', json: SKELETON_JSON },
      { match: (a) => a[0] === 'callers' && a[1] === 'authenticate', json: CALLERS_AUTHENTICATE_JSON },
      { match: (a) => a[0] === 'callers' && a[1] === 'issueToken', json: CALLERS_ISSUETOKEN_JSON },
    ])
  }

  function registerWith(config: HooksConfig = CONFIG, runner = blastRoutes().runner, store = new SessionStateStore()) {
    const { ctx, listeners } = makeCtx()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, config, {
      state: store,
      spawnBuild: makeBuildFake().spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
    }, runner)
    return { ctx, listeners, logger, store }
  }

  it('non-edit tool: pass-through, no dirty, no CLI', async () => {
    root = makeTmpRoot('dsh-cg-postex-read-')
    repo = makeGraphRepo(root)
    const { listeners, store } = registerWith()
    const decision = await firePostExecute(listeners, {
      name: 'read',
      arguments: { file_path: 'src/auth.ts' },
      agent: makeAgent(repo),
    })
    expect(decision.additionalContexts).toBeUndefined()
    expect(store.isDirty('session-x', repo)).toBe(false)
  })

  it('block decision: untouched, no dirty, no CLI', async () => {
    root = makeTmpRoot('dsh-cg-postex-block-')
    repo = makeGraphRepo(root)
    const { listeners, store } = registerWith()
    const decision = await firePostExecute(listeners, {
      name: 'write',
      arguments: { file_path: 'src/auth.ts', content: 'x' },
      agent: makeAgent(repo),
    }, true)
    expect(decision.kind).toBe('block')
    expect(decision.additionalContexts).toBeUndefined()
    expect(store.isDirty('session-x', repo)).toBe(false)
  })

  it('edit under graft/: ignored (no dirty, no CLI, no context)', async () => {
    root = makeTmpRoot('dsh-cg-postex-gra-')
    repo = makeGraphRepo(root)
    const { listeners, store } = registerWith()
    const decision = await firePostExecute(listeners, {
      name: 'edit',
      arguments: { file_path: 'graft/INDEX.md', old_string: 'a', new_string: 'b' },
      agent: makeAgent(repo),
    })
    expect(decision.additionalContexts).toBeUndefined()
    expect(store.isDirty('session-x', repo)).toBe(false)
  })

  it('source edit: marks dirty and appends a short blast-radius context', async () => {
    root = makeTmpRoot('dsh-cg-postex-blast-')
    repo = makeGraphRepo(root)
    const routed = blastRoutes()
    const { listeners, store } = registerWith(CONFIG, routed.runner)

    const decision = await firePostExecute(listeners, {
      name: 'edit',
      arguments: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' },
      agent: makeAgent(repo),
    })

    expect(store.isDirty('session-x', repo)).toBe(true)
    const additions = decision.additionalContexts as Array<{ content: Array<{ text?: string }>; source: { kind: string; plugin: string } }>
    expect(additions).toHaveLength(1)
    expect(additions[0]!.source).toEqual({ kind: 'plugin', plugin: 'dsh-context-graph' })
    const text = additions[0]!.content.map((block) => block.text ?? '').join('')
    expect(text).toContain('src/auth.ts')
    expect(text).toContain('issueToken')
    expect(text).toContain('authenticate @ src/auth.ts:L3-L6')
    expect(text).toContain('login @ src/web.ts:L20-L25')
    // CLI shape: skeleton of the edited file, then per-symbol callers (depth 1, no --deep anywhere)
    const subcommands = routed.calls.map((call) => call.args[0])
    expect(subcommands).toEqual(['skeleton', 'callers', 'callers'])
    expect(routed.calls[0]!.args).toEqual(['skeleton', 'src/auth.ts', '--json', repo])
    expect(routed.calls[1]!.args).toEqual(['callers', 'authenticate', '--direction', 'in', '-d', '1', '--json', repo])
    expect(JSON.stringify(routed.calls)).not.toContain('--deep')
  })

  it('file outside the repo: no dirty, no CLI', async () => {
    root = makeTmpRoot('dsh-cg-postex-out-')
    repo = makeGraphRepo(root)
    const routed = blastRoutes()
    const { listeners, store } = registerWith(CONFIG, routed.runner)
    await firePostExecute(listeners, {
      name: 'write',
      arguments: { file_path: '/etc/hosts', content: 'x' },
      agent: makeAgent(repo),
    })
    expect(store.isDirty('session-x', repo)).toBe(false)
    expect(routed.calls).toHaveLength(0)
  })

  it('no graph: dirty is still marked, but no CLI and no context', async () => {
    root = makeTmpRoot('dsh-cg-postex-nograph-')
    repo = makeGitRepo(join(root, 'repo')) // no graft/
    const routed = blastRoutes()
    const { listeners, store } = registerWith(CONFIG, routed.runner)
    const decision = await firePostExecute(listeners, {
      name: 'edit',
      arguments: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' },
      agent: makeAgent(repo),
    })
    expect(store.isDirty('session-x', repo)).toBe(true)
    expect(decision.additionalContexts).toBeUndefined()
    expect(routed.calls).toHaveLength(0)
  })

  it('skeleton CLI failure: dirty marked, no crash, no context', async () => {
    root = makeTmpRoot('dsh-cg-postex-fail-')
    repo = makeGraphRepo(root)
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'skeleton', error: new GraphError('GRAPH_BAD_JSON', 'bad skeleton') },
    ])
    const { listeners, store } = registerWith(CONFIG, routed.runner)
    const decision = await firePostExecute(listeners, {
      name: 'edit',
      arguments: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' },
      agent: makeAgent(repo),
    })
    expect(decision.kind).toBe('accept')
    expect(decision.additionalContexts).toBeUndefined()
    expect(store.isDirty('session-x', repo)).toBe(true)
  })

  it('injectBlastRadius=false: dirty still marked, no CLI, no context', async () => {
    root = makeTmpRoot('dsh-cg-postex-off-')
    repo = makeGraphRepo(root)
    const routed = blastRoutes()
    const { listeners, store } = registerWith({ ...CONFIG, injectBlastRadius: false }, routed.runner)
    const decision = await firePostExecute(listeners, {
      name: 'edit',
      arguments: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' },
      agent: makeAgent(repo),
    })
    expect(store.isDirty('session-x', repo)).toBe(true)
    expect(decision.additionalContexts).toBeUndefined()
    expect(routed.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// P1: turn-stop auto-sync
// ---------------------------------------------------------------------------

describe('hooks.ts — turn-stop autoSync (P1)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  it('not dirty: no build', async () => {
    root = makeTmpRoot('dsh-cg-turn-clean-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)

    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))
    expect(buildFake.calls).toHaveLength(0)
  })

  it('dirty: one detached build under the lock, dirty cleared', async () => {
    root = makeTmpRoot('dsh-cg-turn-dirty-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const store = new SessionStateStore()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: store,
      spawnBuild: buildFake.spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)

    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))

    expect(buildFake.calls).toHaveLength(1)
    expect(buildFake.calls[0]!.root).toBe(repo)
    expect(readFileSync(join(repo, LOCK_FILE_NAME), 'utf8')).toContain(String(process.pid))
    expect(store.isDirty('session-x', repo)).toBe(false)
  })

  it('second dirty stop while the build runs: no second build; after exit: allowed', async () => {
    root = makeTmpRoot('dsh-cg-turn-twice-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const store = new SessionStateStore()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: store,
      spawnBuild: buildFake.spawnBuild,
      releaseLock: (dir) => rmSync(join(dir, LOCK_FILE_NAME), { force: true }),
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)

    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))
    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))
    expect(buildFake.calls).toHaveLength(1) // lock held by the running build

    buildFake.resolveExited()
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))
    expect(buildFake.calls).toHaveLength(2)
  })

  it('no session cwd: silent (no build in the server launch dir)', async () => {
    root = makeTmpRoot('dsh-cg-turn-nocwd-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const store = new SessionStateStore()
    const buildFake = makeBuildFake()
    registerHooks(ctx, CONFIG, {
      state: store,
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)

    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(undefined))
    expect(buildFake.calls).toHaveLength(0)
  })

  it('autoSync=false: no build even when dirty', async () => {
    root = makeTmpRoot('dsh-cg-turn-off-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const store = new SessionStateStore()
    const buildFake = makeBuildFake()
    registerHooks(ctx, { ...CONFIG, autoSync: false }, {
      state: store,
      spawnBuild: buildFake.spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeMapRunner().runner)

    store.markDirty('session-x', repo)
    await fireTurnStop(listeners, makeAgent(join(repo, 'src')))
    expect(buildFake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// P2a: pre-execute (nudge + wiring guard), pre-step modes, metrics
// ---------------------------------------------------------------------------

async function firePreExecute(
  listeners: Map<string, (...args: unknown[]) => unknown>,
  exec: { name: string; arguments: unknown; agent?: Agent },
  downstream: { kind: string; reason?: string } = { kind: 'allow' },
): Promise<Record<string, unknown>> {
  const listener = listeners.get('tools/pre-execute')
  expect(listener).toBeDefined()
  const next = async () => downstream
  const decision = await listener?.(exec, next)
  return decision as Record<string, unknown>
}

const ASK_SOURCED_JSON = {
  query: 'where is auth',
  hits: [
    {
      title: 'authenticate · function',
      pointer: 'src/auth.ts:L3-L6',
      score: 0.9,
      code: 'function authenticate(user: string, password: string): boolean {\n  return issueToken(user) === verify(password)\n}',
    },
    { title: 'issueToken · function', pointer: 'src/auth.ts:L8-L10', score: 0.7 },
  ],
}

describe('hooks.ts — pre-step retrieval modes (P2a)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  it('map-only: no CLI call, decision passes through untouched', async () => {
    root = makeTmpRoot('dsh-cg-p2a-maponly-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([{ match: () => true, json: ASK_JSON }])
    registerHooks(ctx, { ...CONFIG, injectMode: 'map-only' }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['where is authentication in this repo'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1) // only the original prompt
    expect(routed.calls).toHaveLength(0) // no CLI at all in map-only
  })

  it('sourced (default): ask carries --source and the pack inlines the top crux', async () => {
    root = makeTmpRoot('dsh-cg-p2a-sourced-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask' && a.includes('--source'), json: ASK_SOURCED_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const prompt = 'where is authentication in this repo'
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(decision.messages).toHaveLength(2)
    expect(routed.calls).toHaveLength(1)
    expect(routed.calls[0]!.args).toEqual(['ask', prompt, '--json', '-n', '3', '--source', repo])
    const added = decision.messages![1] as { content: Array<{ text?: string }> }
    const text = added.content[0]?.text ?? ''
    expect(text).toContain('with source')
    expect(text).toContain('function authenticate') // the inlined crux
    expect(text).toContain('src/auth.ts:L8-L10') // the related pointer stays
  })

  it('scopeFromLastEdit: a previous edit scopes the ask to the file top-level dir', async () => {
    root = makeTmpRoot('dsh-cg-p2a-scope-')
    repo = makeGraphRepo(root)
    const store = new SessionStateStore()
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask' && a.includes('--in'), json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, injectMode: 'pointers', scopeFromLastEdit: true }, {
      state: store,
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    // Simulate a prior edit recorded by post-execute.
    store.setLastFile('session-x', repo, 'packages/api/src/auth.ts')
    const prompt = 'where is authentication in this repo'
    await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(routed.calls).toHaveLength(1)
    // --in <top-level dir> inserted before the repo dir
    expect(routed.calls[0]!.args).toEqual(['ask', prompt, '--json', '-n', '3', '--in', 'packages', repo])
  })

  it('scopeFromLastEdit: a lastFile with no directory yields no --in', async () => {
    root = makeTmpRoot('dsh-cg-p2a-scopeflat-')
    repo = makeGraphRepo(root)
    const store = new SessionStateStore()
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, injectMode: 'pointers', scopeFromLastEdit: true }, {
      state: store,
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    store.setLastFile('session-x', repo, 'auth.ts') // no directory component
    const prompt = 'where is authentication in this repo'
    await firePreStep(listeners, makeAgent(join(repo, 'src')), [prompt])
    expect(routed.calls).toHaveLength(1)
    expect(routed.calls[0]!.args).toEqual(['ask', prompt, '--json', '-n', '3', repo])
  })
})

describe('hooks.ts — pre-execute nudge (P2a, spec #2)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function setup(config: Partial<HooksConfig> = {}, store?: SessionStateStore) {
    const state = store ?? new SessionStateStore()
    const { ctx, listeners } = makeCtx()
    const deps = {
      state,
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }
    registerHooks(ctx, { ...CONFIG, ...config }, deps, makeRoutedRunner([]).runner)
    return { listeners, state, agent: makeAgent(join(repo, 'src')) }
  }

  it('a wide grep with no prior graph call nudges exactly once', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-')
    repo = makeGraphRepo(root)
    const { listeners, agent } = setup()
    const first = await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'foo' }, agent })
    expect(first).toEqual({ kind: 'allow' })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(injectedText(agent)).toContain('graph_find_code')
    // Second wide grep: the nudge is already sent — no repeat.
    await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'bar' }, agent })
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })

  it('a path-narrowed grep does not nudge (it is not a blind scan)', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-narrow-')
    repo = makeGraphRepo(root)
    const { listeners, agent } = setup()
    await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'foo', path: 'src' }, agent })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('after any graph_* call, wide grep no longer nudges', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-aftergraph-')
    repo = makeGraphRepo(root)
    const { listeners, state, agent } = setup()
    state.bumpGraphCalls('session-x', repo) // the model already found the graph
    await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'foo' }, agent })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('nudgeOnBlindSearch=false disables the reminder', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-off-')
    repo = makeGraphRepo(root)
    const { listeners, agent } = setup({ nudgeOnBlindSearch: false })
    await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'foo' }, agent })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('a downstream deny is passed through untouched (no nudge, no mutation)', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-deny-')
    repo = makeGraphRepo(root)
    const { listeners, agent } = setup()
    const decision = await firePreExecute(
      listeners,
      { name: 'grep', arguments: { pattern: 'foo' }, agent },
      { kind: 'deny', reason: 'forbidden' },
    )
    expect(decision).toEqual({ kind: 'deny', reason: 'forbidden' })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('no agent: silent (no nudge, decision passes through)', async () => {
    root = makeTmpRoot('dsh-cg-p2a-nudge-noagent-')
    repo = makeGraphRepo(root)
    const { listeners } = setup()
    const decision = await firePreExecute(listeners, { name: 'grep', arguments: { pattern: 'foo' } })
    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('hooks.ts — pre-execute wiring read guard (P2a, spec #12)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  it('guardWiringReads: a read under graft/.graph is denied with a tool hint', async () => {
    root = makeTmpRoot('dsh-cg-p2a-guard-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, { ...CONFIG, guardWiringReads: true }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeRoutedRunner([]).runner)
    const decision = await firePreExecute(listeners, {
      name: 'read',
      arguments: { file_path: 'graft/.graph/wiring.json' },
      agent: makeAgent(repo), // session cwd = workspace root, as in a real GUI session
    })
    expect(decision.kind).toBe('deny')
    expect(String(decision.reason)).toContain('graph_find_code')
  })

  it('guardWiringReads: a normal source read is allowed', async () => {
    root = makeTmpRoot('dsh-cg-p2a-guard-src-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, { ...CONFIG, guardWiringReads: true }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeRoutedRunner([]).runner)
    const decision = await firePreExecute(listeners, {
      name: 'read',
      arguments: { file_path: 'src/auth.ts' },
      agent: makeAgent(join(repo, 'src')),
    })
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('guardWiringReads=false: the wiring read is allowed (guard is opt-in)', async () => {
    root = makeTmpRoot('dsh-cg-p2a-guard-off-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, makeRoutedRunner([]).runner)
    const decision = await firePreExecute(listeners, {
      name: 'read',
      arguments: { file_path: 'graft/.graph/wiring.json' },
      agent: makeAgent(join(repo, 'src')),
    })
    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('hooks.ts — post-execute local metrics (P2a, spec #16)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function setup(config: Partial<HooksConfig>, recordMetric: ReturnType<typeof vi.fn>) {
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, { ...CONFIG, ...config }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
      recordMetric,
    }, makeRoutedRunner([]).runner)
    return { listeners, agent: makeAgent(join(repo, 'src')) }
  }

  it('an accepted graph_* call counts as a graph read', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-graph-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners, agent } = setup({ metrics: true }, recordMetric)
    await firePostExecute(listeners, { name: 'graph_find_code', arguments: { query: 'x' }, agent })
    expect(recordMetric).toHaveBeenCalledWith('session-x', 'graph')
  })

  it('an accepted read of a repo source file counts as a source read', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-src-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners, agent } = setup({ metrics: true }, recordMetric)
    await firePostExecute(listeners, { name: 'read', arguments: { file_path: 'src/auth.ts' }, agent })
    expect(recordMetric).toHaveBeenCalledWith('session-x', 'source')
  })

  it('a read under graft/ is NOT counted as a source read', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-graph-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners } = setup({ metrics: true }, recordMetric)
    // The relative path resolves against the session cwd (workspace root).
    await firePostExecute(listeners, { name: 'read', arguments: { file_path: 'graft/INDEX.md' }, agent: makeAgent(repo) })
    expect(recordMetric).not.toHaveBeenCalled()
  })

  it('a read outside the repo is not counted', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-outside-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners, agent } = setup({ metrics: true }, recordMetric)
    await firePostExecute(listeners, { name: 'read', arguments: { file_path: '/etc/hosts' }, agent })
    expect(recordMetric).not.toHaveBeenCalled()
  })

  it('a blocked result is not counted', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-block-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners, agent } = setup({ metrics: true }, recordMetric)
    await firePostExecute(listeners, { name: 'read', arguments: { file_path: 'src/auth.ts' }, agent }, true)
    expect(recordMetric).not.toHaveBeenCalled()
  })

  it('metrics=false (no sink): nothing is recorded', async () => {
    root = makeTmpRoot('dsh-cg-p2a-metrics-off-')
    repo = makeGraphRepo(root)
    const recordMetric = vi.fn()
    const { listeners, agent } = setup({ metrics: false }, recordMetric)
    await firePostExecute(listeners, { name: 'graph_find_code', arguments: { query: 'x' }, agent })
    expect(recordMetric).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// P2b: subagent map, compaction re-inject, toolOrder
// ---------------------------------------------------------------------------

describe('hooks.ts — subagent map (P2b, spec #5)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function makeSubagent(cwd: string | undefined, noMarker = false) {
    const agent = makeAgent(cwd) as unknown as Record<string, unknown>
    if (!noMarker) {
      // The durable subagent marker (host runtime: childSessionMeta), NOT the
      // phantom `agent.parentAgent` property (never set by ReactLoopAgent).
      const header = (agent.session as { header: Record<string, unknown> }).header
      header.origin = 'subagent'
      header.parentSession = 'parent-session-x'
    }
    return agent as unknown as Agent
  }

  function setup(config: Partial<HooksConfig> = {}) {
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'map', json: MAP_JSON },
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, ...config }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    return { listeners, routed }
  }

  function fireAgentCreated(
    listeners: Map<string, (...args: unknown[]) => unknown>,
    agent: Agent,
  ): void {
    const listener = listeners.get('agent/created')
    expect(listener).toBeDefined()
    listener?.({ agent })
  }

  it('a subagent in a graphed repo gets the short map at its FIRST pre-step', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const agent = makeSubagent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    // The map is delivered through the pre-step decision (claimed
    // synchronously) — not via agent.inject, which races the subagent's
    // immediately-submitted prompt.
    const decision = await firePreStep(listeners, agent, ['hi'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    const reinjected = decision.messages?.[1]
    expect(reinjected).toBeDefined()
    const text = (reinjected as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
    expect(text).toContain('short map for this subagent')
    expect(text).toContain('repo map — 3 files')
    expect(agent.inject).not.toHaveBeenCalled()
    expect(routed.calls.filter((c) => c.args[0] === 'map')).toHaveLength(1)
  })

  it('the root agent (no subagent header marker) is never armed', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-root-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const agent = makeSubagent(join(repo, 'src'), true)
    fireAgentCreated(listeners, agent)
    const decision = await firePreStep(listeners, agent, ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('the phantom agent.parentAgent property (no header marker) does NOT arm — regression guard', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-phantom-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const agent = makeSubagent(join(repo, 'src'), true)
    // ReactLoopAgent never sets this property; detection via it is a bug.
    ;(agent as unknown as Record<string, unknown>).parentAgent = makeAgent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    const decision = await firePreStep(listeners, agent, ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('session-start of a subagent session skips the FULL map (channel #5 delivers the short one)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-sessionstart-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([{ match: (a) => a[0] === 'map', json: MAP_JSON }])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const agent = makeSubagent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)
    expect(agent.inject).not.toHaveBeenCalled()
    expect(routed.calls).toHaveLength(0)
  })

  it('with injectSubagentMap=false a subagent session keeps the FULL session-start map (fallback)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-fallback-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([{ match: (a) => a[0] === 'map', json: MAP_JSON }])
    registerHooks(ctx, { ...CONFIG, injectSubagentMap: false }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const agent = makeSubagent(join(repo, 'src'))
    await fireSessionStart(listeners, agent)
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(injectedText(agent)).toContain('repo map — 3 files')
  })

  it('injectSubagentMap=false: no agent/created listener at all', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-off-')
    repo = makeGraphRepo(root)
    const { listeners } = setup({ injectSubagentMap: false })
    expect(listeners.get('agent/created')).toBeUndefined()
  })

  it('a subagent in a repo without a graph: never armed, no CLI', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-nograph-')
    repo = makeGitRepo(join(root, 'repo')) // no graft/ dir
    const { listeners, routed } = setup()
    const agent = makeSubagent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    const decision = await firePreStep(listeners, agent, ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('the map is delivered exactly once (one-shot)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-once-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const agent = makeSubagent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    await firePreStep(listeners, agent, ['hi'])
    const second = await firePreStep(listeners, agent, ['hi'])
    expect(second.messages).toHaveLength(1)
    expect(routed.calls.filter((c) => c.args[0] === 'map')).toHaveLength(1)
  })

  it('CLI failure at pre-step: fail-open, the arming is consumed (no retry)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-fail-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([{ match: (a) => a[0] === 'map', code: 1 }])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const agent = makeSubagent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    const decision = await firePreStep(listeners, agent, ['hi'])
    expect(decision.messages).toHaveLength(1)
    const second = await firePreStep(listeners, agent, ['hi'])
    expect(second.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(1) // one attempt, then consumed
  })

  it('works with injectPromptHits off (independent channel)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-submap-independent-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup({ injectPromptHits: false })
    const agent = makeSubagent(join(repo, 'src'))
    fireAgentCreated(listeners, agent)
    const decision = await firePreStep(listeners, agent, ['a longer delegated task that passes the minimum'])
    expect(decision.messages).toHaveLength(2)
    expect(routed.calls.filter((c) => c.args[0] === 'ask')).toHaveLength(0)
  })
})

describe('hooks.ts — compaction re-inject (P2b, spec #6)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function setup(config: Partial<HooksConfig> = {}) {
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a) => a[0] === 'map', json: MAP_JSON },
      { match: (a) => a[0] === 'ask', json: ASK_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, ...config }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    return { listeners, routed }
  }

  function fireCompaction(
    listeners: Map<string, (...args: unknown[]) => unknown>,
    compactionId: string,
    type: string = 'compaction/summary',
    cwd?: string,
  ): void {
    const listener = listeners.get('session/event')
    expect(listener).toBeDefined()
    listener?.(
      { header: { id: 'session-x', createdAt: 0, cwd: cwd ?? repo } },
      { type, data: { compactionId } },
    )
  }

  it('a compaction arms a one-shot short-map re-inject at the next pre-step', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    fireCompaction(listeners, 'c1')
    // 'hi' is below promptMinChars: only the compaction channel may fire.
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    const reinjected = decision.messages?.[1]
    expect(reinjected).toBeDefined()
    const text = (reinjected as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
    expect(text).toContain('compacted — repo orientation restored')
    expect(text).toContain('repo map — 3 files')
    const mapCalls = routed.calls.filter((c) => c.args[0] === 'map')
    expect(mapCalls).toHaveLength(1)
  })

  it('the re-inject happens exactly once per compaction', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-once-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    fireCompaction(listeners, 'c1')
    await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    const second = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(second.messages).toHaveLength(1) // consumed — no second map
    expect(routed.calls.filter((c) => c.args[0] === 'map')).toHaveLength(1)
  })

  it('re-observing the same compaction id does not re-arm', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-sameid-')
    repo = makeGraphRepo(root)
    const { listeners } = setup()
    fireCompaction(listeners, 'c1')
    await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    fireCompaction(listeners, 'c1') // event replay across listeners
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(1)
  })

  it('a NEW compaction id re-arms the re-inject', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-newid-')
    repo = makeGraphRepo(root)
    const { listeners } = setup()
    fireCompaction(listeners, 'c1')
    await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    fireCompaction(listeners, 'c2')
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(2)
  })

  it('works with injectPromptHits off (independent channel)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-independent-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup({ injectPromptHits: false })
    fireCompaction(listeners, 'c1')
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['a longer user prompt that passes the minimum'])
    expect(decision.messages).toHaveLength(2)
    expect(routed.calls.filter((c) => c.args[0] === 'ask')).toHaveLength(0)
  })

  it('reinjectAfterCompaction=false: no session/event listener, no re-inject', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-off-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup({ reinjectAfterCompaction: false })
    expect(listeners.get('session/event')).toBeUndefined()
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('a compaction in a non-graphed repo arms nothing', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-nograph-')
    repo = makeGitRepo(join(root, 'repo')) // no graft/ dir
    const { listeners, routed } = setup()
    fireCompaction(listeners, 'c1')
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('non-compaction session events are ignored', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-others-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const listener = listeners.get('session/event')
    listener?.(
      { header: { id: 'session-x', createdAt: 0, cwd: repo } },
      { type: 'user/message', data: {} },
    )
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('a compaction event without compactionId is ignored (fail-open)', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-noid-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setup()
    const listener = listeners.get('session/event')
    listener?.(
      { header: { id: 'session-x', createdAt: 0, cwd: repo } },
      { type: 'compaction/summary', data: {} },
    )
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(1)
    expect(routed.calls).toHaveLength(0)
  })

  it('prune compactions are handled like summary compactions', async () => {
    root = makeTmpRoot('dsh-cg-p2b-compact-prune-')
    repo = makeGraphRepo(root)
    const { listeners } = setup()
    fireCompaction(listeners, 'p1', 'compaction/prune')
    const decision = await firePreStep(listeners, makeAgent(join(repo, 'src')), ['hi'])
    expect(decision.messages).toHaveLength(2)
  })
})

describe('hooks.ts — toolOrder (P2b, spec #11)', () => {

  const GREP = { name: 'grep', description: '' }
  const READ = { name: 'read', description: '' }
  const BASH = { name: 'bash', description: '' }
  const G1 = { name: 'graph_find_code', description: '' }
  const G2 = { name: 'graph_repo_map', description: '' }
  const NAMES = ['graph_find_code', 'graph_file_api', 'graph_trace_calls', 'graph_find_all', 'graph_repo_map', 'graph_check_freshness']

  it('moves the graph tools first, stably, rest untouched', () => {
    const out = reorderToolsForGraph([GREP, G1, READ, BASH, G2], NAMES)
    expect(out.map((t) => t.name)).toEqual(['graph_find_code', 'graph_repo_map', 'grep', 'read', 'bash'])
  })

  it('returns the same array when there is nothing to reorder', () => {
    const input = [GREP, READ, BASH]
    expect(reorderToolsForGraph(input, NAMES)).toBe(input)
  })

  it('undefined tools yield an empty array (never throws)', () => {
    expect(reorderToolsForGraph(undefined, NAMES)).toEqual([])
  })

  it('keeps graph-tool relative order (stable partition)', () => {
    const out = reorderToolsForGraph([G2, GREP, G1], NAMES)
    expect(out.map((t) => t.name)).toEqual(['graph_repo_map', 'graph_find_code', 'grep'])
  })

  it('the assemble waterfall reorders; toolOrder=false leaves the order', async () => {
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => '/tmp',
    }, makeRoutedRunner([]).runner)
    const listener = listeners.get('system-prompt/assemble')
    expect(listener).toBeDefined()
    const assembly = { sections: [], contexts: [], tools: [GREP, G1, READ], variables: {} }
    const next = async () => assembly
    const result = (await listener?.(assembly, {}, next)) as typeof assembly
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['graph_find_code', 'grep', 'read'])
  })

  it('toolOrder=false: the assembled tools come back untouched', async () => {
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, { ...CONFIG, toolOrder: false }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => '/tmp',
    }, makeRoutedRunner([]).runner)
    const listener = listeners.get('system-prompt/assemble')
    const assembly = { sections: [], contexts: [], tools: [GREP, G1], variables: {} }
    const result = (await listener?.(assembly, {}, async () => assembly)) as typeof assembly
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['grep', 'graph_find_code'])
  })

  it('a downstream assembly without a tools array passes through unchanged', async () => {
    const { ctx, listeners } = makeCtx()
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => '/tmp',
    }, makeRoutedRunner([]).runner)
    const listener = listeners.get('system-prompt/assemble')
    const bare = { sections: [], contexts: [], variables: {} }
    const result = await listener?.(bare as never, {}, async () => bare)
    expect(result).toBe(bare)
  })
})

describe('hooks.ts — session-start resume blast (P2c #3)', () => {
  let root: string
  let repo: string

  afterAll(() => removeTmpRoot(root))

  function setupBlast(gitDirty: boolean, blastOutcome?: { code?: number }) {
    const { ctx, listeners } = makeCtx()
    const routes: Array<{ match: (a: string[]) => boolean; json?: unknown; code?: number }> = [
      { match: (a) => a[0] === 'blast', json: BLAST_JSON_HOOKS, code: blastOutcome?.code },
      { match: (a) => a[0] === 'map', json: MAP_JSON },
    ]
    const routed = makeRoutedRunner(routes)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger,
      processCwd: () => repo,
      gitDirty: async () => gitDirty,
    }, routed.runner)
    return { listeners, routed, logger }
  }

  it('resume + dirty git: injects the short blast (before the map)', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-dirty-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setupBlast(true)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'resume')
    const blastCalls = routed.calls.filter((c) => c.args[0] === 'blast')
    expect(blastCalls).toHaveLength(1)
    expect(blastCalls[0]!.args).toEqual(['blast', '--depth', '2', '--format', 'json', repo])
    const injected = (agent.inject as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const firstText = injected[0]?.[0] as { content: Array<{ text?: string }> }
    expect(firstText.content[0]?.text ?? '').toContain('Blast radius (working tree vs HEAD, depth 2)')
  })

  it('resume + clean git: no blast call, map still injected', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-clean-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setupBlast(false)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'resume')
    expect(routed.calls.filter((c) => c.args[0] === 'blast')).toHaveLength(0)
    expect(injectedText(agent)).toContain('repo map — 3 files')
  })

  it('startup + dirty: no blast (resume-only)', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-startup-')
    repo = makeGraphRepo(root)
    const { listeners, routed } = setupBlast(true)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'startup')
    expect(routed.calls.filter((c) => c.args[0] === 'blast')).toHaveLength(0)
  })

  it('blastOnResume=false: no blast even on resume+dirty', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-off-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a: string[]) => a[0] === 'blast', json: BLAST_JSON_HOOKS },
      { match: (a: string[]) => a[0] === 'map', json: MAP_JSON },
    ])
    registerHooks(ctx, { ...CONFIG, blastOnResume: false }, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
      gitDirty: async () => true,
    }, routed.runner)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'resume')
    expect(routed.calls.filter((c) => c.args[0] === 'blast')).toHaveLength(0)
  })

  it('blast CLI failure: fail-open, map still injected, warn logged', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-fail-')
    repo = makeGraphRepo(root)
    const { listeners, routed, logger } = setupBlast(true, { code: 1 })
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'resume')
    expect(routed.calls.filter((c) => c.args[0] === 'blast')).toHaveLength(1)
    expect(injectedText(agent)).toContain('repo map — 3 files')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('no gitDirty seam: skip silently (undefined dep)', async () => {
    root = makeTmpRoot('dsh-cg-p2c-resumeblast-noseam-')
    repo = makeGraphRepo(root)
    const { ctx, listeners } = makeCtx()
    const routed = makeRoutedRunner([
      { match: (a: string[]) => a[0] === 'blast', json: BLAST_JSON_HOOKS },
      { match: (a: string[]) => a[0] === 'map', json: MAP_JSON },
    ])
    registerHooks(ctx, CONFIG, {
      state: new SessionStateStore(),
      spawnBuild: makeBuildFake().spawnBuild,
      pluginName: 'dsh-context-graph',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processCwd: () => repo,
    }, routed.runner)
    const agent = makeAgent(join(repo, 'src'))
    await fireSessionStart(listeners, agent, 'resume')
    expect(routed.calls.filter((c) => c.args[0] === 'blast')).toHaveLength(0)
  })
})
