import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const PATCH_PATH = join(__dirname, '..', 'cordis.patch.yml')
const EXAMPLE_PATH = join(__dirname, '..', 'cordis.yml.example')

/** The row shape the Cordis bundle patch expects: a config row for our plugin id. */
interface BundleRow {
  id: string
  name: string
  inject: string[]
  config: Record<string, unknown>
}

function loadPatchRow(): { patch: unknown; row: BundleRow } {
  const patch = parse(readFileSync(PATCH_PATH, 'utf8'))
  expect(Array.isArray(patch)).toBe(true)
  const first = (patch as unknown[])[0]! as { insert?: unknown[] }
  expect(first.insert).toBeDefined()
  const row = (first.insert as BundleRow[])[0]!
  return { patch, row }
}

describe('cordis.patch.yml — bundle overlay validity', () => {
  it('is a YAML document with a single insert action carrying one row', () => {
    const { patch, row } = loadPatchRow()
    expect((patch as unknown[]).length).toBe(1)
    expect(row).toBeDefined()
  })

  it('the row targets our plugin id/name and requests tools + systemPrompt', () => {
    const { row } = loadPatchRow()
    expect(row.id).toBe('context-graph')
    expect(row.name).toBe('dsh-context-graph')
    expect(row.inject).toEqual(['tools', 'systemPrompt'])
  })

  it('the row config documents every P0 setting with sane values', () => {
    const { row } = loadPatchRow()
    expect(row.config).toMatchObject({
      tools: true,
      injectSessionMap: true,
      autoBuild: true,
      maxInjectBytes: 4096,
      promptMinChars: 12,
      graphPath: '',
      timeoutMs: 8000,
      buildTimeoutMs: 20_000,
      deep: false,
      editToolNames: ['write', 'edit'],
    })
  })
})

describe('cordis.yml.example — user overlay', () => {
  it('is a valid patch row restating the full config with a concrete graphPath', () => {
    const patch = parse(readFileSync(EXAMPLE_PATH, 'utf8')) as unknown
    expect(Array.isArray(patch)).toBe(true)
    const first = (patch as unknown[])[0]! as { insert?: BundleRow[] }
    const row = first.insert?.[0]
    expect(row?.id).toBe('context-graph')
    expect(row?.name).toBe('dsh-context-graph')
    // A patch replaces the ENTIRE config, so the example restates every key.
    expect(Object.keys(row?.config ?? {}).sort()).toEqual([
      'autoBuild', 'autoSync', 'buildTimeoutMs', 'deep', 'editToolNames', 'graphPath',
      'guardWiringReads', 'injectBlastRadius', 'injectMode', 'injectPromptHits',
      'injectSessionMap', 'injectSubagentMap', 'maxInjectBytes', 'metrics',
      'nudgeOnBlindSearch', 'promptMinChars', 'reinjectAfterCompaction',
      'scopeFromLastEdit', 'timeoutMs', 'toolOrder', 'tools',
    ].sort())
    expect(typeof row?.config.graphPath).toBe('string')
    expect(row?.config.graphPath).not.toBe('')
  })
})
