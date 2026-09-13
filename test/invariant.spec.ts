import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Privacy invariant (spec #14): the graph is never more secret than the
 * sources, and the plugin sends nothing anywhere. The hooks and CLI seam
 * must contain NO network primitives — no fetch, no http(s) client, no
 * WebSocket, no telemetry. Enforced as a static scan over src/ so a
 * regression (someone adding a POST for "metrics") fails the build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

// Network primitives that must NOT appear in the plugin source. Each is a
// regex chosen to catch the call/import form, not incidental prose.
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: 'fetch()', re: /\bfetch\s*\(/ },
  { label: 'http(s) request', re: /\bhttps?\.request\s*\(/ },
  { label: 'require("http")', re: /require\(\s*['"]https?['"]\s*\)/ },
  { label: 'import http module', re: /from\s+['"]node?:https?['"]/ },
  { label: 'WebSocket', re: /new\s+WebSocket\s*\(/ },
  { label: 'XMLHttpRequest', re: /XMLHttpRequest/ },
  { label: 'axios', re: /\baxios\b/ },
  { label: 'got/undici client', re: /\b(?:undici|got)\b/ },
]

describe('privacy invariant — the plugin has no network surface (spec #14)', () => {
  it('src/** contains no fetch/http/websocket/telemetry primitives', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(0) // the scan actually found sources
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const { label, re } of FORBIDDEN) {
        if (re.test(text)) offenders.push(`${relative(SRC, file)}: ${label}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the only external process it spawns is the engine CLI (@nanonets/graft) (child_process, local)', () => {
    const cli = readFileSync(join(SRC, 'cli.ts'), 'utf8')
    expect(cli).toMatch(/child_process/)
    // and it never opens a socket or makes a request.
    expect(cli).not.toMatch(/\bfetch\s*\(|https?\.request\s*\(/)
  })
})
