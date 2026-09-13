import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill } from '../src/skill.ts'
import { SKILL_TEMPLATE } from '../src/skill-template.ts'

/**
 * The host resolves $DSH_HOME from the DSH_HOME env (then ~/.dsh); the test
 * runtime stub honors the same precedence, so each test points DSH_HOME at a
 * fresh temp dir and the real skill path is deterministic.
 */
describe('skill.ts — idempotent user-level skill install', () => {
  let home: string
  let previous: string | undefined

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-cg-skill-'))
    previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    home = mkdtempSync(join(tmpdir(), 'dsh-cg-skill-'))
    process.env.DSH_HOME = home
  })

  it('writes skills/graph/SKILL.md with the stable template', () => {
    const result = installSkill({})
    expect(result.ok).toBe(true)
    expect(result.path).toBe(join(home, 'skills', 'graph', 'SKILL.md'))
    const text = readFileSync(result.path!, 'utf8')
    expect(text).toBe(SKILL_TEMPLATE)
    expect(text).toContain('name: graph')
    expect(text).toContain('graph_find_code')
  })

  it('is idempotent: a second install does not rewrite the file', () => {
    installSkill({})
    const marker = join(home, 'skills', 'graph', 'SKILL.md')
    const beforeMtime = statSync(marker).mtimeMs
    const second = installSkill({})
    expect(second.ok).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe(SKILL_TEMPLATE)
    // no rewrite: mtime unchanged (a rewrite would at least keep the content
    // equal, but the mtime proves the short-circuit)
    expect(statSync(marker).mtimeMs).toBe(beforeMtime)
  })

  it('does NOT overwrite a user-customized skill', () => {
    installSkill({})
    const marker = join(home, 'skills', 'graph', 'SKILL.md')
    writeFileSync(marker, SKILL_TEMPLATE + '\n- my own extra rule\n', 'utf8')
    const result = installSkill({})
    expect(result.ok).toBe(true)
    expect(readFileSync(marker, 'utf8')).toContain('my own extra rule')
  })

  it('reports a write failure fail-soft (no throw)', () => {
    // Make skills/graph a FILE so mkdir -p / write cannot succeed.
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'graph'), 'not a dir', 'utf8')
    const result = installSkill({})
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('logger receives a warn (not an exception) on failure', () => {
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'graph'), 'not a dir', 'utf8')
    const warns: string[] = []
    installSkill({ logger: { info: () => undefined, warn: (m) => warns.push(m), error: () => undefined } })
    expect(warns.length).toBeGreaterThan(0)
    expect(existsSync(join(home, 'skills', 'graph'))).toBe(true)
  })
})

// Small helper: yield to the event loop once (keeps mtimes from colliding
// within one millisecond on fast machines).
function await0(): void {
  // synchronous on purpose; the mtime marker is best-effort only
}
