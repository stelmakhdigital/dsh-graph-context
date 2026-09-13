/**
 * Repository and graph-directory resolution.
 *
 * Every call resolves the repo from the SESSION cwd (not the harness process
 * cwd): the host stores the session's absolute working directory in the
 * session header. The engine pairs a graph directory with its repo root as
 * `<root>/graft`, so queries pass the explicit repo root as the CLI's
 * positional `dir` argument.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** Exists-check seam so tests can use fixtures without touching disk. */
export type ExistsFn = (path: string) => boolean

const existsOnDisk: ExistsFn = (path) => existsSync(path)

/**
 * Walk up from `cwd` to the nearest ancestor containing a `.git` entry
 * (directory or file, covering submodules/worktrees).
 * @returns the git root, or `undefined` when no git repo encloses `cwd`.
 */
export function findGitRoot(cwd: string | undefined, exists: ExistsFn = existsOnDisk): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  let dir = resolve(cwd)
  for (;;) {
    if (exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * The engine's default: the nearest `graft/` index walking up from `cwd`.
 * Returns the GRAPH directory itself (e.g. `/repo/graft`), so the paired
 * repo root is its parent.
 */
export function findGraphDir(cwd: string | undefined, exists: ExistsFn = existsOnDisk): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, 'graft')
    if (exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * One session's repo anchor: cwd (session header or process cwd), the git
 * root enclosing it, and the graph directory paired with that repo.
 *
 * `graphDir` may point at a repo different from `gitRoot` only when the user
 * built a graph at an ancestor; queries then use the graph's own repo root so
 * The engine resolves against the index that exists.
 */
export interface RepoAnchor {
  /** Session working directory used for the call. */
  readonly cwd: string
  /** Nearest git root, when the cwd is inside a repository. */
  readonly gitRoot?: string
  /** Nearest `graft/` directory, when a graph index exists at/above cwd. */
  readonly graphDir?: string
  /** Repo root paired with `graphDir` (the CLI positional `dir`). */
  readonly graphRepoRoot?: string
  /** True when cwd is not inside a git repository at all. */
  readonly outsideGit: boolean
}

/**
 * Resolve the anchor for one call from the session cwd.
 * @param cwd - the session cwd (falls back to `process.cwd()` by the caller).
 * @param processCwd - fallback cwd when the session header has none.
 */
export function resolveRepoAnchor(
  cwd: string | undefined,
  processCwd: string = process.cwd(),
  exists: ExistsFn = existsOnDisk,
): RepoAnchor {
  const effectiveCwd = cwd !== undefined && cwd !== '' ? cwd : processCwd
  const gitRoot = findGitRoot(effectiveCwd, exists)
  const graphDir = findGraphDir(effectiveCwd, exists)
  const graphRepoRoot = graphDir !== undefined && graphDir.endsWith(sep + 'graft')
    ? dirname(graphDir)
    : graphDir
  return {
    cwd: effectiveCwd,
    ...(gitRoot !== undefined ? { gitRoot } : {}),
    ...(graphDir !== undefined ? { graphDir, graphRepoRoot } : {}),
    outsideGit: gitRoot === undefined,
  }
}
