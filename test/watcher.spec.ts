import { describe, expect, it } from 'vitest'
import { makeGitRepo, makeTmpRoot, removeTmpRoot } from './fixtures.ts'
import { startChokidarWatcher } from '../src/watcher.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Real chokidar (the production binding). The hooks layer is tested with a
// fake seam; this file pins the fs behavior: what counts as "source".
describe('watcher.ts — chokidar binding (P2c #17)', () => {
  it('emits add/change for sources and ignores graft/, .git/, dotfiles', async () => {
    const repo = makeGitRepo(makeTmpRoot('dsh-cg-watch-'))
    mkdirSync(join(repo, 'graft'), { recursive: true })
    const seen: string[] = []
    const handle = await startChokidarWatcher(repo, (rel) => { seen.push(rel) })
    await new Promise((resolve) => setTimeout(resolve, 500))
    writeFileSync(join(repo, 'src-x.ts'), 'export {}\n')
    writeFileSync(join(repo, 'graft', 'index.md'), 'x')
    writeFileSync(join(repo, '.env'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    writeFileSync(join(repo, 'src-x.ts'), 'export const y = 1\n')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await handle.close()
    removeTmpRoot(repo)
    // at least the initial add and a subsequent change of the source file
    expect(seen.filter((s) => s === 'src-x.ts').length).toBeGreaterThanOrEqual(2)
    expect(seen.some((s) => s.includes('graft'))).toBe(false)
    expect(seen).not.toContain('.env')
  }, 20000)

  it('a failing constructor resolves a no-op handle (fail-open)', async () => {
    // A path the fs layer refuses: watching through a regular FILE.
    const root = makeTmpRoot('dsh-cg-watch-nofail-')
    const file = join(root, 'file.txt')
    writeFileSync(file, 'x')
    const handle = await startChokidarWatcher(file, () => undefined)
    expect(handle.close).toBeTypeOf('function')
    await handle.close()
    removeTmpRoot(root)
  })
})
