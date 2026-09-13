/**
 * Shared test fixtures: tmp directory trees with fake git repos, graph
 * directories, and executable fake engine CLIs. Everything is created on disk
 * (no in-process FS mocking) so the resolution logic runs against real paths.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a fresh tmp root; the caller removes it in an afterAll hook. */
export function makeTmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Recursively remove a tmp root (best effort). */
export function removeTmpRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort in teardown
  }
}

/** Mark `dir` as a git repository (a `.git` directory is enough for resolution). */
export function makeGitRepo(root: string): string {
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

/** Create a graft/ graph directory (content is irrelevant to resolution). */
export function makeGraphDir(root: string): string {
  const graphDir = join(root, 'graft')
  mkdirSync(join(graphDir, '.graph'), { recursive: true })
  writeFileSync(join(graphDir, 'INDEX.md'), '# index\n')
  return graphDir
}

/**
 * Write an executable shell script named `name` into `binDir`. The body is
 * the full shell source (shebang included).
 */
export function makeFakeBin(binDir: string, name: string, body: string): string {
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A pid that is definitely not alive: the pid of an already-exited child. */
export function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (result.pid === undefined) throw new Error('fixture: probe spawn returned no pid')
  return result.pid
}
