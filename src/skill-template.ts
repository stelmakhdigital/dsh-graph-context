/**
 * Skill template for the graph tools. P1 activates installation of this
 * file into `$DSH_HOME/skills/graph/SKILL.md` (user-level, idempotent);
 * P0 ships the template so the layout is ready. Frontmatter follows the
 * DSH skill convention: `name` (kebab-case), `description`, `whenToUse`.
 *
 * The body uses the SAME tool names as the native tools so the model, the
 * skill, and any AGENTS.md prose agree.
 */

export const SKILL_NAME = 'graph'

export const SKILL_FILE_RELATIVE_PATH = 'skills/graph/SKILL.md'

/** One stable template; no interpolation (tool names are constants). */
export const SKILL_TEMPLATE = `---
name: graph
description: Query the local repo context graph (symbols, call edges, blast radius) instead of blind grep/read.
whenToUse: Orienting in a repo, locating code by question/symbol/error, tracing callers/callees, checking graph freshness after edits.
---

# Repo context graph (native tools)

The repo has a local context graph (the \`graft/\` directory, built by the
\`@nanonets/graft\` CLI). Use the native graph tools instead of blind
exploration:

- \`graph_repo_map\` — first call in an unfamiliar repo: directory clusters,
  hub symbols, global hotspots.
- \`graph_find_code\` — question, symbol, or error message to ranked
  file:line pointers (set \`source: true\` to inline the crux at each hit).
- \`graph_file_api\` — signatures of one file without reading its body.
- \`graph_trace_calls\` — who calls a symbol (\`direction: in\`) or what it
  calls (\`direction: out\`); \`depth > 1\` walks transitively (blast radius).
- \`graph_find_all\` — regex search over indexed sources, ranked by coupling.
- \`graph_check_freshness\` — drift report; call after larger edits.
Code Mode (PTC): all graph tools are callable inside \`run_code\` programs
  as \`await tools.graph_<name>(args)\` — the host SDK includes them automatically.
- \`graph_blast\` — diff blast radius: the symbols the changed lines touch and the
  downstream dependents that may break (\`base\` to diff against a ref like
  \`origin/main\`). Use before refactoring / for "what breaks if I change X".
- \`graph_enrich\` — ONLY if enabled in config (\`deep.tool: true\`): on-demand LOCAL LLM deep pass (\`graft build --deep\` against the configured endpoint, e.g. Ollama); expensive — call only when richer symbol summaries are needed.

Rules:
1. Call a graph tool BEFORE a broad grep/read when the question maps to
   structure (who, where, what calls). Raw grep stays available for
   one-offs and non-indexed files.
2. Never read \`graft/.graph/wiring.json\` or the full \`graft/INDEX.md\` —
   the tools are the interface.
3. On \`GRAPH_MISSING\` (no graph yet) the plugin builds it in the
   background; retry shortly, or run \`graft build\` manually.
4. On \`GRAPH_CLI_MISSING\`, install the engine once: \`npm i -g
   @nanonets/graft\`.
`

/** Render the skill body (currently static; kept a function for P1 interpolation). */
export function renderSkillTemplate(): string {
  return SKILL_TEMPLATE
}
