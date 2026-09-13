/**
 * User-level skill installation (P1). The host resolves $DSH_HOME from the
 * DSH_HOME env (then `~/.dsh`); the skill lands at
 * `$DSH_HOME/skills/graph/SKILL.md` exactly once. Re-installs are a no-op:
 * the template is written only when the file is absent, and a user-customized
 * file is never overwritten (idempotent + non-destructive, per spec).
 *
 * Fail-open: any filesystem problem yields `{ ok: false, error }` + a warn
 * log, never an exception into the plugin load path.
 */
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderSkillTemplate, SKILL_FILE_RELATIVE_PATH } from './skill-template.ts'

/**
 * DSH home resolution, inlined on purpose: the host's `dsh-home-paths`
 * utility is a workspace-internal package that is NOT resolvable from a
 * plugin profile (module identity — the same class of breakage as a `link:`
 * checkout pulling foreign peers). Documented precedence, highest first:
 * the `DSH_HOME` env, then `~/.dsh`.
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

export interface SkillInstallResult {
  /** True when the skill file is in place after the call (fresh or existing). */
  ok: boolean
  /** Absolute path of the skill file (when resolvable). */
  path?: string
  /** Fail-open diagnostic (ok=false only). */
  error?: string
}

/**
 * Install (or verify) the graph skill in the DSH home.
 * @param options.env - environment mapping for DSH_HOME (tests inject a fake home).
 * @param options.logger - warn on failure (never throws).
 */
export function installSkill(options: {
  env?: Record<string, string | undefined>
  /** The host logger (info/warn/error); only `warn` is used on failure. */
  logger?: { info?(message: string): void; warn(message: string): void; error?(message: string): void }
} = {}): SkillInstallResult {
  const fail = (error: unknown): SkillInstallResult => {
    const message = error instanceof Error ? error.message : String(error)
    options.logger?.warn(`dsh-context-graph: skill install skipped (${message})`)
    return { ok: false, error: message }
  }
  try {
    const home = resolveDshHome(options.env)
    const file = join(home, SKILL_FILE_RELATIVE_PATH)
    if (existsSync(file)) {
      // Idempotent: present means done. A customized file stays untouched —
      // the template is only ever written when the file is missing.
      return { ok: true, path: file }
    }
    mkdirSync(join(home, 'skills', 'graph'), { recursive: true })
    writeFileSync(file, renderSkillTemplate(), 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return fail(error)
  }
}
