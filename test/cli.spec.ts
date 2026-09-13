import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  buildSpawnEnv,
  findOnPath,
  GraphError,
  parseGraphJson,
  resolveGraphBin,
  runGraph,
} from '../src/cli.ts'
import { makeFakeBin, makeTmpRoot, removeTmpRoot } from './fixtures.ts'

describe('cli.ts — parseGraphJson', () => {
  it('parses a clean JSON payload', () => {
    expect(parseGraphJson('{"a":1}\n')).toEqual({ a: 1 })
  })

  it('tolerates log lines before and after the JSON body', () => {
    const stdout = '[graft] warming up\n{"hits":[]}\nsome trailing noise\n'
    expect(parseGraphJson(stdout)).toEqual({ hits: [] })
  })

  it('parses a JSON array payload', () => {
    expect(parseGraphJson('log\n[1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('throws GRAPH_BAD_JSON for empty output', () => {
    expect(() => parseGraphJson('   ')).toThrowError(GraphError)
    try {
      parseGraphJson('')
    } catch (error) {
      expect((error as GraphError).code).toBe('GRAPH_BAD_JSON')
    }
  })

  it('throws GRAPH_BAD_JSON when no JSON object can be recovered', () => {
    expect(() => parseGraphJson('just text, no json at all')).toThrowError(GraphError)
  })
})

describe('cli.ts — buildSpawnEnv', () => {
  it('is explicit: PATH + telemetry off, ambient keys are not forwarded', () => {
    const env = buildSpawnEnv({ GRAPH_TEST_DIR: '/x' })
    expect(env.DO_NOT_TRACK).toBe('1')
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.GRAPH_TEST_DIR).toBe('/x')
    // Even if the harness had a key ambient, the child must not receive it.
    expect(env.GRAFT_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('cli.ts — resolveGraphBin', () => {
  let root: string
  let binDir: string

  afterAll(() => removeTmpRoot(root))

  const envFor = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: binDir,
    ...extra,
  })

  it('resolves an explicit absolute path first (config wins over PATH)', () => {
    root = makeTmpRoot('dsh-cg-bin-')
    binDir = join(root, 'bin')
    const custom = makeFakeBin(binDir, 'my-graph', 'echo custom')
    const onPath = makeFakeBin(binDir, 'graft', 'echo path')
    expect(resolveGraphBin(custom, envFor())).toEqual({ file: custom, args: [], viaNpx: false })
    // sanity: the PATH one would be different
    expect(findOnPath('graft', envFor())).toBe(onPath)
  })

  it('resolves a configured bare name through PATH', () => {
    root = makeTmpRoot('dsh-cg-bin2-')
    binDir = join(root, 'bin')
    const custom = makeFakeBin(binDir, 'my-graph', 'echo custom')
    expect(resolveGraphBin('my-graph', envFor())).toEqual({ file: custom, args: [], viaNpx: false })
  })

  it('falls through an unresolvable configured value to PATH graft', () => {
    root = makeTmpRoot('dsh-cg-bin3-')
    binDir = join(root, 'bin')
    const onPath = makeFakeBin(binDir, 'graft', 'echo path')
    expect(resolveGraphBin('/nonexistent/graft', envFor())).toEqual({ file: onPath, args: [], viaNpx: false })
  })

  it('uses the GRAPH_CLI env when no config value is set', () => {
    root = makeTmpRoot('dsh-cg-bin4-')
    binDir = join(root, 'bin')
    const custom = makeFakeBin(binDir, 'my-graph', 'echo custom')
    expect(resolveGraphBin('', { PATH: binDir, GRAPH_CLI: 'my-graph' })).toEqual({ file: custom, args: [], viaNpx: false })
  })

  it('falls back to npx when graft is absent (flagged), and to undefined when npx is absent too', () => {
    root = makeTmpRoot('dsh-cg-bin5-')
    binDir = join(root, 'bin')
    const npx = makeFakeBin(binDir, 'npx', 'exit 0')
    expect(resolveGraphBin('', { PATH: binDir })).toEqual({ file: npx, args: ['-y', '@nanonets/graft'], viaNpx: true })
    const emptyDir = join(root, 'empty')
    expect(resolveGraphBin('', { PATH: emptyDir })).toBeUndefined()
  })
})

describe('cli.ts — runGraph', () => {
  let root: string
  let binDir: string

  afterAll(() => removeTmpRoot(root))

  it('resolves with stdout and the exit code; non-zero exit is data', async () => {
    root = makeTmpRoot('dsh-cg-run-')
    binDir = join(root, 'bin')
    makeFakeBin(binDir, 'graft', "echo '{\"ok\":true}'; exit 0")
    const result = await runGraph(['ask', 'q'], {
      cwd: root,
      timeoutMs: 5000,
      graphPath: join(binDir, 'graft'),
    })
    expect(result.stdout.trim()).toBe('{"ok":true}')
    expect(result.code).toBe(0)
    expect(result.viaNpx).toBe(false)

    makeFakeBin(binDir, 'graph-stale', 'echo "stale drift"; exit 1')
    const stale = await runGraph(['check'], { cwd: root, timeoutMs: 5000, graphPath: join(binDir, 'graph-stale') })
    expect(stale.code).toBe(1)
  })

  it('rejects GRAPH_CLI_MISSING when no binary can be resolved', async () => {
    const emptyDir = join(makeTmpRoot('dsh-cg-empty-'), 'nowhere')
    await expect(
      runGraph(['ask'], { cwd: emptyDir, timeoutMs: 1000, graphPath: '/definitely/not/here' }),
    ).rejects.toMatchObject({ code: 'GRAPH_CLI_MISSING', hint: 'npm i -g @nanonets/graft' })
  })

  it('rejects GRAPH_TIMEOUT and kills the child', async () => {
    root = makeTmpRoot('dsh-cg-timeout-')
    binDir = join(root, 'bin')
    makeFakeBin(binDir, 'graft', 'sleep 30')
    const started = Date.now()
    await expect(
      runGraph(['ask'], { cwd: root, timeoutMs: 400, graphPath: join(binDir, 'graft') }),
    ).rejects.toMatchObject({ code: 'GRAPH_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('rejects when the caller signal is already aborted', async () => {
    root = makeTmpRoot('dsh-cg-abort-')
    binDir = join(root, 'bin')
    makeFakeBin(binDir, 'graft', 'sleep 30')
    const controller = new AbortController()
    controller.abort()
    await expect(
      runGraph(['ask'], { cwd: root, timeoutMs: 5000, graphPath: join(binDir, 'graft'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'GRAPH_FAILED' })
  })

  it('cancels on a live abort signal', async () => {
    root = makeTmpRoot('dsh-cg-abort2-')
    binDir = join(root, 'bin')
    makeFakeBin(binDir, 'graft', 'sleep 30')
    const controller = new AbortController()
    const promise = runGraph(['ask'], { cwd: root, timeoutMs: 30_000, graphPath: join(binDir, 'graft'), signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(promise).rejects.toMatchObject({ code: 'GRAPH_FAILED' })
  })
})
