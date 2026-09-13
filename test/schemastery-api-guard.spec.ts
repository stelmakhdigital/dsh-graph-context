/**
 * API-surface guard for `@deepseek-ai/schemastery` (regression: 2026-09-13
 * boot-crash incident).
 *
 * The plugin ships a `lib/` bundle whose schemastery import stays EXTERNAL:
 * the DSH host resolves the REAL package at runtime, while typecheck sees
 * `stubs/schemastery.d.ts` and vitest resolves the mock
 * `test/stubs/schemastery.mjs` (alias in vitest.config.ts). An invented
 * member therefore passes typecheck and unit tests and crashes only at
 * plugin load — `z.enum` did exactly that (`z.enum is not a function`
 * killed the whole plugin tree and `dsh web` boot).
 *
 * This test pins two surfaces to the REAL package's static API:
 *  1. every `z.<static>(` call site in `src/` must exist in the real API;
 *  2. the test mock's static members must be a subset of the real API
 *     (so the mock can never paper over a call site that would crash).
 *
 * Instance methods used by `src/` (only `.default()` at construction time)
 * are verified against the real d.ts manually when this file is touched.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
// Resolves to test/stubs/schemastery.mjs via the vitest alias — i.e. the
// exact module the other tests run against.
import z from '@deepseek-ai/schemastery'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Static API of the REAL `@deepseek-ai/schemastery` v3.18.2, verified
 * 2026-09-13 against deepseek-harness
 * `vendor/schemastery/lib/types/index.d.ts` (interface `Static`). No
 * `enum` member exists in the real package — a closed literal set is
 * `union([const(...), ...])`.
 *
 * When the host's schemastery changes, re-verify this list against the REAL
 * d.ts (never against the local stub — that is how this incident happened).
 */
const REAL_STATIC_API: ReadonlySet<string> = new Set([
  'any', 'never', 'const', 'string', 'number', 'natural', 'percent',
  'boolean', 'date', 'regExp', 'arrayBuffer', 'bitset', 'function', 'is',
  'array', 'dict', 'tuple', 'object', 'union', 'intersect', 'transform',
  'lazy', 'from', 'extend', 'resolve', 'ValidationError',
])

/** Strip block and line comments so prose (e.g. "no z.enum") cannot fake a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Map of `<staticName>` -> files calling `z.<staticName>(` in `src/`. */
function usedStaticCalls(srcDir: string): Map<string, string[]> {
  const used = new Map<string, string[]>()
  const files = readdirSync(srcDir, { encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .sort()
  for (const file of files) {
    const source = stripComments(readFileSync(join(srcDir, file), 'utf8'))
    for (const match of source.matchAll(/[^A-Za-z0-9_$]z\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const name = match[1]
      if (name === undefined) continue
      used.set(name, [...(used.get(name) ?? []), file])
    }
  }
  return used
}

describe('schemastery API-surface guard (anti stub-drift)', () => {
  it('src/ only calls static members that exist in the real schemastery', () => {
    const used = usedStaticCalls(join(here, '..', 'src'))
    const offenders = [...used.entries()]
      .filter(([name]) => !REAL_STATIC_API.has(name))
      .map(([name, files]) => `z.${name} (in ${files.join(', ')})`)
    expect(
      offenders,
      `src/ uses schemastery static members absent from the real package v3.18.2 — `
        + `they would crash at plugin load on the host. Express them with real `
        + `members (a closed literal set is z.union([z.const(...), ...])) or update `
        + `REAL_STATIC_API after verifying the real vendor d.ts.\n`
        + offenders.join('\n'),
    ).toEqual([])
  })

  it('the test mock only implements static members that exist in the real schemastery', () => {
    const mockStatics = Object.keys(z as unknown as Record<string, unknown>)
    const offenders = mockStatics.filter((name) => !REAL_STATIC_API.has(name))
    expect(
      offenders,
      `test/stubs/schemastery.mjs implements ${offenders.join(', ')} which the real `
        + `schemastery does not have — remove it so a call site crashing on the host `
        + `also fails in vitest instead of being papered over.`,
    ).toEqual([])
  })

  it('the real API allowlist is non-trivial (guards against a corrupted list)', () => {
    expect(REAL_STATIC_API.size).toBeGreaterThanOrEqual(20)
    // The statics the plugin actually uses must stay in the allowlist even
    // if someone rewrites the set by hand. (`.default` is an INSTANCE method,
    // verified against the real d.ts separately.)
    for (const expected of ['object', 'boolean', 'number', 'string', 'array', 'const', 'union']) {
      expect(REAL_STATIC_API.has(expected)).toBe(true)
    }
    expect(REAL_STATIC_API.has('enum')).toBe(false)
  })
})
