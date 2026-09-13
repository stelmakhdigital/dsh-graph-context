/**
 * Engine CLI spawn wrapper.
 *
 * The engine is invoked as the `@nanonets/graft` CLI; the plugin never
 * imports it. Binary resolution order (spec): explicit config/env, then
 * `graft` on PATH, then the slow `npx -y @nanonets/graft` fallback. Every
 * spawn gets a minimal EXPLICIT env (PATH, telemetry off) — ambient harness
 * env is not relied on, and no API key is ever forwarded.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Structured error codes returned to the model or logged fail-open. */
export type GraphErrorCode =
  | 'GRAPH_CLI_MISSING'
  | 'GRAPH_TIMEOUT'
  | 'GRAPH_BAD_JSON'
  | 'GRAPH_FAILED'

/** A failure with a stable code the tool layer maps into its canonical value. */
export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    message: string,
    readonly hint?: string,
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'GraphError'
  }
}

export interface GraphSpawnOptions {
  /** Working directory for the child (the session repo). */
  cwd: string
  /** Hard deadline in milliseconds; the child is killed on expiry. */
  timeoutMs: number
  /** External cancellation (the tool call's exec.signal, when present). */
  signal?: AbortSignal
  /** Explicit engine binary (config.graphPath); empty/undefined = PATH order. */
  graphPath?: string
  /** Extra env merged after the explicit base env (never used for keys). */
  extraEnv?: Record<string, string>
}

export interface GraphSpawnResult {
  stdout: string
  stderr: string
  code: number
  /** True when the run went through the npx fallback (cold start logged). */
  viaNpx: boolean
}

interface ResolvedBinary {
  file: string
  args: readonly string[]
  viaNpx: boolean
}

/** True when `path` is an executable regular file. */
export function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && accessSync(path, constants.X_OK) === undefined
  } catch {
    return false
  }
}

/** Find an executable on PATH (env.PATH). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = isAbsolute(dir) ? join(dir, name) : join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the engine binary:
 * 1. `config.graphPath` / `GRAPH_CLI` (path or bare name via PATH);
 * 2. `graft` on PATH;
 * 3. `npx -y @nanonets/graft` (slow cold start, flagged for logging).
 * A configured value that does not resolve falls through to the next
 * candidate rather than failing the whole tool.
 */
export function resolveGraphBin(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBinary | undefined {
  const explicit = configured !== undefined && configured !== '' ? configured : env.GRAPH_CLI
  if (explicit !== undefined && explicit !== '') {
    const found = explicit.includes('/') || explicit.includes('\\')
      ? (isExecutableFile(explicit) ? explicit : undefined)
      : findOnPath(explicit, env)
    if (found !== undefined) return { file: found, args: [], viaNpx: false }
  }
  const onPath = findOnPath('graft', env)
  if (onPath !== undefined) return { file: onPath, args: [], viaNpx: false }
  const npx = findOnPath('npx', env)
  if (npx !== undefined) return { file: npx, args: ['-y', '@nanonets/graft'], viaNpx: true }
  return undefined
}

/**
 * The explicit env every engine child receives. Deliberately minimal: PATH to
 * reach interpreters, telemetry convention off, and nothing that could carry
 * an API key from the ambient harness.
 */
export function buildSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    DO_NOT_TRACK: '1',
  }
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  if (process.env.USERPROFILE !== undefined) env.USERPROFILE = process.env.USERPROFILE
  return { ...env, ...(extra ?? {}) }
}

/**
 * Spawn one engine command and collect stdout/stderr.
 *
 * Resolves with the raw exit code (a non-zero code is DATA, not a failure:
 * `graft check` exits 1 for a stale graph). Rejects only on infrastructure
 * problems: missing binary, spawn error, or timeout.
 */
export function runGraph(args: readonly string[], options: GraphSpawnOptions): Promise<GraphSpawnResult> {
  return new Promise((resolve, reject) => {
    const resolved = resolveGraphBin(options.graphPath)
    if (resolved === undefined) {
      reject(new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      // Detached => the child leads its own process group, so the timeout and
      // abort paths can kill the whole tree (a CLI may spawn helpers that
      // would otherwise hold the stdio pipes open and defer `close`).
      child = spawn(resolved.file, [...resolved.args, ...args], {
        cwd: options.cwd,
        env: buildSpawnEnv(options.extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      reject(new GraphError('GRAPH_FAILED', `graft spawn failed: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const killTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid !== undefined && pid > 0) {
        try {
          process.kill(-pid, signal)
          return
        } catch {
          // group kill unavailable (non-POSIX / already gone): fall through
        }
      }
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
    }, options.timeoutMs)

    const onAbort = (): void => {
      cancelled = true
      killTree('SIGTERM')
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      action()
    }

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new GraphError('GRAPH_CLI_MISSING', 'graft CLI not found', 'npm i -g @nanonets/graft'))
        } else {
          reject(new GraphError('GRAPH_FAILED', `graft spawn error: ${error.message}`))
        }
      })
    })
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(new GraphError(
            'GRAPH_TIMEOUT',
            `graft ${args[0] ?? ''} timed out after ${options.timeoutMs}ms`,
            undefined,
            code ?? undefined,
          ))
          return
        }
        if (cancelled) {
          reject(new GraphError('GRAPH_FAILED', 'graft call cancelled by caller', undefined, code ?? undefined))
          return
        }
        resolve({ stdout, stderr, code: code ?? 1, viaNpx: resolved.viaNpx })
      })
    })
  })
}

/**
 * Parse one engine `--json` payload from stdout. Tolerates log lines around
 * the JSON body; throws `GraphError('GRAPH_BAD_JSON')` when no object can be
 * recovered.
 */
export function parseGraphJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed === '') throw new GraphError('GRAPH_BAD_JSON', 'graft produced no output')
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to the log-tolerant extraction
  }
  // Log-tolerant extraction: graft may print progress lines around the JSON.
  // Try every line that opens with { or [, scanning brackets with a
  // string-aware depth count so a log line like "[graft] done" is skipped.
  const candidate = /^[{\[]/gm
  let match: RegExpExecArray | null
  while ((match = candidate.exec(trimmed)) !== null) {
    const extracted = extractBalancedJson(trimmed, match.index)
    if (extracted !== undefined) return extracted
  }
  throw new GraphError('GRAPH_BAD_JSON', 'no JSON object in graft output')
}

/** From `start` (a `{` or `[`), return the parsed JSON value ending at the
 * matching close bracket, or undefined when no balanced value parses. */
function extractBalancedJson(text: string, start: number): unknown {
  const open = text.charAt(start)
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

export interface GraphJsonResult<T> {
  json: T
  code: number
  result: GraphSpawnResult
}

/** Run one engine command expecting a `--json` payload; preserves the exit code. */
export async function runGraphJson<T = unknown>(
  args: readonly string[],
  options: GraphSpawnOptions,
): Promise<GraphJsonResult<T>> {
  const result = await runGraph(args, options)
  let json: unknown
  try {
    json = parseGraphJson(result.stdout)
  } catch (error) {
    if (error instanceof GraphError) {
      throw new GraphError(error.code, `graft ${args[0] ?? ''}: ${error.message}`, error.hint, result.code)
    }
    throw error
  }
  return { json: json as T, code: result.code, result }
}

export interface DetachedBuildHandle {
  pid?: number
  error?: string
  /** Settles when the detached build process exits (used to release the lock). */
  exited?: Promise<void>
}

/**
 * Start a structural `graft build` (no `--deep`, no network) without blocking
 * the caller. The child is detached and unref'd so the harness process can
 * exit and the session loop is never held; the caller is responsible for the
 * lock file. Returns a handle for logging, never throws.
 */
export function spawnDetachedBuild(
  repoRoot: string,
  options: { graphPath?: string; buildTimeoutMs: number },
): DetachedBuildHandle {
  const resolved = resolveGraphBin(options.graphPath)
  if (resolved === undefined) {
    return { error: 'graft CLI not found (npm i -g @nanonets/graft)' }
  }
  try {
    const child = spawn(resolved.file, [...resolved.args, 'build', repoRoot], {
      cwd: repoRoot,
      env: buildSpawnEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    // The harness process outlives the build, so a plain timer can enforce
    // the deadline; the child itself is unref'd so it never blocks process
    // exit.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, options.buildTimeoutMs)
    const exited = new Promise<void>((resolve) => {
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.on('error', () => {
        // spawn failure: the exit promise must still settle so the lock frees
        clearTimeout(timer)
        resolve()
      })
    })
    child.unref()
    return { pid: child.pid, exited }
  } catch (error) {
    return { error: `graft build spawn failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
