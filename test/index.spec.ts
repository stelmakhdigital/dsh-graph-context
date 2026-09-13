import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, inject, name, normalizeConfig, TOOL_NAMES } from '../src/index.ts'
import { SKILL_TEMPLATE } from '../src/skill-template.ts'
import type { Context } from '@deepseek-ai/cordis'

interface CapturedCtx {
  registered: unknown[]
  sections: Array<{ name: string; order: number; text: string }>
  onEvents: string[]
  settingsCalls: Array<{ ns: string; schema: unknown; entry: unknown }>
  ctx: Context
}

function captureApply(
  rawConfig: Record<string, unknown> | null,
  options: { withSettings?: boolean; settingsMode?: 'throwing' } = {},
): CapturedCtx {
  const registered: unknown[] = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const onEvents: string[] = []
  const settingsCalls: Array<{ ns: string; schema: unknown; entry: unknown }> = []
  const ctx = {
    tools: {
      register: vi.fn((tool: unknown) => {
        registered.push(tool)
      }),
    },
    systemPrompt: {
      section: vi.fn((opts: { name: string; order: number; text: string }) => {
        sections.push(opts)
      }),
    },
    on: vi.fn((event: string) => {
      onEvents.push(event)
      return () => undefined
    }),
    effect: () => undefined,
    // Present only in deployments that mount the settings provider.
    ...(options.withSettings === true
      ? {
          settings: {
            installSection: vi.fn((owner: unknown, ns: string, schema: unknown, entry: unknown) => {
              settingsCalls.push({ ns, schema, entry })
            }),
          },
        }
      : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context
  // The real host facade THROWS on accessing an undeclared service (a getter
  // cannot be spread into a literal — defineProperty keeps it lazy).
  if (options.settingsMode === 'throwing') {
    Object.defineProperty(ctx, 'settings', {
      enumerable: true,
      configurable: true,
      get(): unknown {
        throw new Error('cannot get property "settings" without inject')
      },
    })
  }
  apply(ctx, rawConfig as never)
  return { registered, sections, onEvents, settingsCalls, ctx }
}

describe('index.ts — plugin contract', () => {
  // apply() installs the skill into $DSH_HOME; pin it to a throwaway dir for
  // the whole file so no test ever touches the operator's real home.
  let home: string
  let previous: string | undefined
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-cg-index-home-'))
    previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  it('exports the Cordis identity (name + inject list)', () => {
    expect(name).toBe('dsh-context-graph')
    expect(inject).toEqual(['tools', 'systemPrompt'])
  })

  it('Config is a schemastery object with all 18 documented fields', () => {
    expect(typeof Config).toBe('object')
    const dict = (Config as unknown as { meta: { dict: Record<string, unknown> } }).meta.dict
    const keys = Object.keys(dict).sort()
    expect(keys).toEqual([
      'autoBuild', 'autoSync', 'buildTimeoutMs', 'deep', 'editToolNames', 'graphPath',
      'guardWiringReads', 'injectBlastRadius', 'injectMode', 'injectPromptHits',
      'injectSessionMap', 'maxInjectBytes', 'metrics', 'nudgeOnBlindSearch',
      'promptMinChars', 'scopeFromLastEdit', 'timeoutMs', 'tools',
    ].sort())
  })

  it('normalizeConfig fills the P2a defaults (spec: each extension behind its flag)', () => {
    const config = normalizeConfig({})
    expect(config.injectMode).toBe('sourced') // DSH default: crux in the pre-step pack
    expect(config.nudgeOnBlindSearch).toBe(true)
    expect(config.scopeFromLastEdit).toBe(false) // monorepo benefit, opt-in
    expect(config.metrics).toBe(true)
    expect(config.guardWiringReads).toBe(false) // hard guard is opt-in
  })

  it('normalizeConfig rejects an invalid injectMode and falls back to sourced', () => {
    expect(normalizeConfig({ injectMode: 'full' as never }).injectMode).toBe('sourced')
    expect(normalizeConfig({ injectMode: 'pointers' }).injectMode).toBe('pointers')
    expect(normalizeConfig({ injectMode: 'map-only' }).injectMode).toBe('map-only')
  })

  it('apply() registers the six tools with stable names', () => {
    const { registered } = captureApply({})
    expect(registered).toHaveLength(6)
    const names = registered.map((tool) => (tool as { name: string }).name)
    expect([...names].sort()).toEqual(Object.values(TOOL_NAMES).sort())
  })

  it('apply() registers a bounded system-prompt pointer section', () => {
    const { sections } = captureApply({})
    expect(sections).toHaveLength(1)
    const section = sections[0]!
    expect(section.name).toBe('plugin:dsh-context-graph')
    expect(Number.isFinite(section.order)).toBe(true)
    const lines = section.text.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines.length).toBeLessThanOrEqual(15)
    for (const toolName of Object.values(TOOL_NAMES)) {
      expect(section.text).toContain(toolName)
    }
    // the fallback guidance must be present
    expect(section.text).toContain('GRAPH_MISSING')
  })

  it('apply() registers the session-start hook and wires config flags', () => {
    const { onEvents } = captureApply({})
    expect(onEvents).toContain('agent/session-start')
  })

  it('apply() registers the P1 lifecycle hooks (pre-step, post-execute, turn-stopping)', () => {
    const { onEvents } = captureApply({})
    expect(onEvents).toContain('agent/pre-step')
    expect(onEvents).toContain('tools/post-execute')
    expect(onEvents).toContain('agent/turn-stopping')
  })

  it('apply() installs the graph skill into $DSH_HOME, idempotently', () => {
    // DSH_HOME is pinned to the file-level throwaway dir (see beforeAll).
    captureApply({})
    const skillFile = join(home, 'skills', 'graph', 'SKILL.md')
    expect(existsSync(skillFile)).toBe(true)
    expect(readFileSync(skillFile, 'utf8')).toBe(SKILL_TEMPLATE)
    // second apply: no error, file untouched (idempotent, non-destructive)
    captureApply({})
    expect(readFileSync(skillFile, 'utf8')).toBe(SKILL_TEMPLATE)
  })

  it('apply() installs the settings section when the service is present, fail-soft otherwise', () => {
    const withSettings = captureApply({}, { withSettings: true })
    expect(withSettings.settingsCalls).toHaveLength(1)
    expect(withSettings.settingsCalls[0]!.ns).toBe('context-graph')
    expect(withSettings.settingsCalls[0]!.schema).toBe(Config)

    // without the service: no call, no crash (all other captures already prove the latter)
    const without = captureApply({})
    expect(without.settingsCalls).toHaveLength(0)
  })

  it('apply() survives a host whose guarded context THROWS on settings access', () => {
    // The real host facade does not expose undeclared services as undefined —
    // it throws "cannot get property X without inject". The plugin must fail
    // soft there, exactly as on an absent service.
    const { settingsCalls } = captureApply({}, { settingsMode: 'throwing' })
    expect(settingsCalls).toHaveLength(0)
  })

  it('apply() honors tools=false (no tool registration)', () => {
    const { registered } = captureApply({ tools: false })
    expect(registered).toHaveLength(0)
  })

  it('normalizeConfig fills documented defaults and clamps bad numbers', () => {
    const full = normalizeConfig(null)
    expect(full).toMatchObject({
      tools: true,
      injectSessionMap: true,
      injectPromptHits: true,
      injectBlastRadius: true,
      autoBuild: true,
      autoSync: true,
      maxInjectBytes: 4096,
      promptMinChars: 12,
      graphPath: '',
      timeoutMs: 8000,
      buildTimeoutMs: 20_000,
      deep: false,
      editToolNames: ['write', 'edit'],
    })
    const clamped = normalizeConfig({ maxInjectBytes: -1, timeoutMs: Number.NaN, editToolNames: ['bash', '', null as never] })
    expect(clamped.maxInjectBytes).toBe(4096)
    expect(clamped.timeoutMs).toBe(8000)
    expect(clamped.editToolNames).toEqual(['bash'])
  })
})
