import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { findGitRoot, findGraphDir, resolveRepoAnchor } from '../src/repo.ts'
import { makeGraphDir, makeGitRepo, makeTmpRoot, removeTmpRoot } from './fixtures.ts'

describe('repo.ts — git root / graph dir resolution', () => {
  let root: string

  afterAll(() => removeTmpRoot(root))

  it('findGitRoot returns undefined for an empty filesystem walk', () => {
    const dir = makeTmpRoot('dsh-cg-nogit-')
    expect(findGitRoot(join(dir, 'a', 'b'))).toBeUndefined()
    removeTmpRoot(dir)
  })

  it('findGitRoot returns the nearest ancestor with a .git entry', () => {
    root = makeTmpRoot('dsh-cg-gitroot-')
    const repo = makeGitRepo(join(root, 'repo'))
    const deep = join(repo, 'src', 'deep')
    expect(findGitRoot(deep)).toBe(repo)
    // the repo root itself
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('findGitRoot stops at the nearest repo, not an outer one', () => {
    root = makeTmpRoot('dsh-cg-nested-')
    const outer = makeGitRepo(join(root, 'outer'))
    const inner = makeGitRepo(join(outer, 'inner'))
    expect(findGitRoot(join(inner, 'x'))).toBe(inner)
    expect(findGitRoot(join(outer, 'y'))).toBe(outer)
  })

  it('findGraphDir returns the nearest graft/ walking up from cwd', () => {
    root = makeTmpRoot('dsh-cg-graph-')
    const outer = makeGitRepo(join(root, 'outer'))
    makeGraphDir(outer)
    const inner = makeGitRepo(join(outer, 'inner'))
    makeGraphDir(inner)
    const deep = join(inner, 'src', 'deep')
    // inner's graph wins (nearest)
    expect(findGraphDir(deep)).toBe(join(inner, 'graft'))
    expect(findGraphDir(join(outer, 'plain'))).toBe(join(outer, 'graft'))
  })

  it('findGraphDir returns undefined when no graft/ exists above cwd', () => {
    root = makeTmpRoot('dsh-cg-nograph-')
    const repo = makeGitRepo(join(root, 'repo'))
    expect(findGraphDir(join(repo, 'src'))).toBeUndefined()
  })

  it('resolveRepoAnchor pairs the graph with its own repo root', () => {
    root = makeTmpRoot('dsh-cg-anchor-')
    const repo = makeGitRepo(join(root, 'repo'))
    makeGraphDir(repo)
    const anchor = resolveRepoAnchor(join(repo, 'src'), process.cwd())
    expect(anchor.cwd).toBe(join(repo, 'src'))
    expect(anchor.gitRoot).toBe(repo)
    expect(anchor.graphDir).toBe(join(repo, 'graft'))
    expect(anchor.graphRepoRoot).toBe(repo)
    expect(anchor.outsideGit).toBe(false)
  })

  it('resolveRepoAnchor flags outsideGit and keeps the cwd fallback', () => {
    root = makeTmpRoot('dsh-cg-outside-')
    const plain = join(root, 'no-git-here')
    const anchor = resolveRepoAnchor(plain, root)
    expect(anchor.outsideGit).toBe(true)
    expect(anchor.gitRoot).toBeUndefined()
    expect(anchor.graphDir).toBeUndefined()
    expect(anchor.cwd).toBe(plain)
  })

  it('resolveRepoAnchor falls back to the process cwd when the session cwd is empty', () => {
    const repo = makeGitRepo(makeTmpRoot('dsh-cg-fallback-'))
    makeGraphDir(repo)
    const anchor = resolveRepoAnchor(undefined, repo)
    expect(anchor.cwd).toBe(repo)
    expect(anchor.gitRoot).toBe(repo)
    removeTmpRoot(repo)
  })

  it('resolveRepoAnchor tolerates a graph at an ancestor of the session cwd repo', () => {
    root = makeTmpRoot('dsh-cg-ancestor-')
    const outer = makeGitRepo(join(root, 'outer'))
    makeGraphDir(outer)
    const inner = makeGitRepo(join(outer, 'inner'))
    const anchor = resolveRepoAnchor(join(inner, 'x'), process.cwd())
    expect(anchor.gitRoot).toBe(inner)
    // nearest graft/ above cwd is the outer repo's graph
    expect(anchor.graphDir).toBe(join(outer, 'graft'))
    expect(anchor.graphRepoRoot).toBe(outer)
  })
})
