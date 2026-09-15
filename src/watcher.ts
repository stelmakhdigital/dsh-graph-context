/**
 * Production repo file watcher (P2c #17, spec: «Chokidar на исходники →
 * dirty flag без ожидания edit-tool»). The hooks layer only knows the seam
 * (`HooksDeps.startRepoWatcher`); this module is the chokidar binding.
 *
 * Deliberately conservative:
 * - one watcher per repo root (the hooks dedup via their own map);
 * - ignores the graph's own output (`graft/`), VCS metadata, dependency
 *   trees, and dotfiles — none of them is "source" for the index;
 * - `ignoreInitial: true` — a fresh watcher must not flood dirty marks for
 *   files that are simply being watched, only for NEW changes;
 * - never throws out of the factory: a fs-layer problem becomes a
 *   no-op handle so session-start stays fail-open (the hooks still log).
 */
import { watch, type FSWatcher } from 'chokidar'
import { sep } from 'node:path'
import type { RepoWatcherHandle } from './hooks.ts'

/** Directory/file patterns that are never "source" for the graph index. */
const IGNORED: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)graft(\/|$)/,
  /(^|\/)\.[^/]+(\/|$)/, // dotfiles and dot-directories (.DS_Store, .env, .github, …)
]

function isIgnored(relPath: string): boolean {
  return IGNORED.some((pattern) => pattern.test(relPath))
}

/**
 * Start watching one repo root. Resolves once chokidar is constructed
 * (events start flowing after its internal `ready`; `ignoreInitial` keeps
 * the initial scan quiet). The returned handle closes the watcher.
 */
export function startChokidarWatcher(
  repoRoot: string,
  onChange: (relPath: string) => void,
): Promise<RepoWatcherHandle> {
  return new Promise((resolve) => {
    let watcher: FSWatcher
    try {
      watcher = watch(repoRoot, {
        ignoreInitial: true,
        ignored: (path: string) => {
          const rel = path.startsWith(`${repoRoot}${sep}`) ? path.slice(repoRoot.length + 1) : path
          return isIgnored(rel)
        },
      })
    } catch {
      resolve({ close: () => undefined })
      return
    }
    watcher.on('all', (event, path) => {
      if (event !== 'change' && event !== 'add' && event !== 'unlink') return
      const rel = path.startsWith(`${repoRoot}${sep}`) ? path.slice(repoRoot.length + 1) : path
      try {
        onChange(rel)
      } catch {
        // The consumer (dirty-mark + log) must never take the watcher down.
      }
    })
    resolve({ close: async () => { await watcher.close() } })
  })
}
