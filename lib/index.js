// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/cli.ts
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
var GraphError = class extends Error {
  constructor(code, message, hint, exitCode) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
    this.name = "GraphError";
  }
};
function isExecutableFile(path) {
  try {
    return statSync(path).isFile() && accessSync(path, constants.X_OK) === void 0;
  } catch {
    return false;
  }
}
function findOnPath(name2, env = process.env) {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = isAbsolute(dir) ? join(dir, name2) : join(dir, name2);
    if (isExecutableFile(candidate)) return candidate;
  }
  return void 0;
}
function resolveGraphBin(configured, env = process.env) {
  const explicit = configured !== void 0 && configured !== "" ? configured : env.GRAPH_CLI;
  if (explicit !== void 0 && explicit !== "") {
    const found = explicit.includes("/") || explicit.includes("\\") ? isExecutableFile(explicit) ? explicit : void 0 : findOnPath(explicit, env);
    if (found !== void 0) return { file: found, args: [], viaNpx: false };
  }
  const onPath = findOnPath("graft", env);
  if (onPath !== void 0) return { file: onPath, args: [], viaNpx: false };
  const npx = findOnPath("npx", env);
  if (npx !== void 0) return { file: npx, args: ["-y", "@nanonets/graft"], viaNpx: true };
  return void 0;
}
function buildSpawnEnv(extra) {
  const env = {
    PATH: process.env.PATH ?? "",
    DO_NOT_TRACK: "1"
  };
  if (process.env.HOME !== void 0) env.HOME = process.env.HOME;
  if (process.env.USERPROFILE !== void 0) env.USERPROFILE = process.env.USERPROFILE;
  return { ...env, ...extra ?? {} };
}
function runGraph(args, options) {
  return new Promise((resolve3, reject) => {
    const resolved = resolveGraphBin(options.graphPath);
    if (resolved === void 0) {
      reject(new GraphError("GRAPH_CLI_MISSING", "graft CLI not found", "npm i -g @nanonets/graft"));
      return;
    }
    let child;
    try {
      child = spawn(resolved.file, [...resolved.args, ...args], {
        cwd: options.cwd,
        env: buildSpawnEnv(options.extraEnv),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
    } catch (error) {
      reject(new GraphError("GRAPH_FAILED", `graft spawn failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const killTree = (signal) => {
      const pid = child.pid;
      if (pid !== void 0 && pid > 0) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
        }
      }
      try {
        child.kill(signal);
      } catch {
      }
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree("SIGTERM");
    };
    if (options.signal !== void 0) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal !== void 0) options.signal.removeEventListener("abort", onAbort);
      action();
    };
    if (child.stdout !== null) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr !== null) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      finish(() => {
        if (error.code === "ENOENT") {
          reject(new GraphError("GRAPH_CLI_MISSING", "graft CLI not found", "npm i -g @nanonets/graft"));
        } else {
          reject(new GraphError("GRAPH_FAILED", `graft spawn error: ${error.message}`));
        }
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new GraphError(
            "GRAPH_TIMEOUT",
            `graft ${args[0] ?? ""} timed out after ${options.timeoutMs}ms`,
            void 0,
            code ?? void 0
          ));
          return;
        }
        if (cancelled) {
          reject(new GraphError("GRAPH_FAILED", "graft call cancelled by caller", void 0, code ?? void 0));
          return;
        }
        resolve3({ stdout, stderr, code: code ?? 1, viaNpx: resolved.viaNpx });
      });
    });
  });
}
function parseGraphJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new GraphError("GRAPH_BAD_JSON", "graft produced no output");
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const candidate = /^[{\[]/gm;
  let match;
  while ((match = candidate.exec(trimmed)) !== null) {
    const extracted = extractBalancedJson(trimmed, match.index);
    if (extracted !== void 0) return extracted;
  }
  throw new GraphError("GRAPH_BAD_JSON", "no JSON object in graft output");
}
function extractBalancedJson(text, start) {
  const open = text.charAt(start);
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return void 0;
        }
      }
    }
  }
  return void 0;
}
async function runGraphJson(args, options) {
  const result = await runGraph(args, options);
  let json;
  try {
    json = parseGraphJson(result.stdout);
  } catch (error) {
    if (error instanceof GraphError) {
      throw new GraphError(error.code, `graft ${args[0] ?? ""}: ${error.message}`, error.hint, result.code);
    }
    throw error;
  }
  return { json, code: result.code, result };
}
function spawnDetachedBuild(repoRoot, options) {
  const resolved = resolveGraphBin(options.graphPath);
  if (resolved === void 0) {
    return { error: "graft CLI not found (npm i -g @nanonets/graft)" };
  }
  try {
    const child = spawn(resolved.file, [...resolved.args, "build", repoRoot], {
      cwd: repoRoot,
      env: buildSpawnEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, options.buildTimeoutMs);
    const exited = new Promise((resolve3) => {
      child.on("close", () => {
        clearTimeout(timer);
        resolve3();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve3();
      });
    });
    child.unref();
    return { pid: child.pid, exited };
  } catch (error) {
    return { error: `graft build spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// src/hooks.ts
import { isAbsolute as isAbsolute2, join as join4, relative, resolve as resolve2 } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// src/format.ts
function parsePointer(pointer) {
  const match = /^(?<path>.+?)(?::L(?<start>\d+)(?:-L(?<end>\d+))?)?$/.exec(pointer);
  if (match === null || match.groups === void 0) return { path: pointer };
  const start = match.groups.start !== void 0 ? Number(match.groups.start) : void 0;
  const end = match.groups.end !== void 0 ? Number(match.groups.end) : void 0;
  return {
    path: match.groups.path ?? pointer,
    ...start !== void 0 ? { startLine: start } : {},
    ...end !== void 0 ? { endLine: end } : {}
  };
}
function formatPointer(parsed) {
  if (parsed.startLine === void 0) return parsed.path;
  if (parsed.endLine !== void 0 && parsed.endLine !== parsed.startLine) {
    return `${parsed.path}:L${parsed.startLine}-L${parsed.endLine}`;
  }
  return `${parsed.path}:L${parsed.startLine}`;
}
function truncateToBytes(text, maxBytes) {
  const encoded = Buffer.byteLength(text, "utf8");
  if (encoded <= maxBytes) return text;
  const marker = "\n\u2026 (truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes < markerBytes) {
    let byteCount2 = 0;
    let charCount2 = 0;
    for (let i = 0; i < text.length; i += 1) {
      const charBytes = Buffer.byteLength(text.charAt(i), "utf8");
      if (byteCount2 + charBytes > maxBytes) break;
      byteCount2 += charBytes;
      charCount2 += 1;
    }
    return text.slice(0, charCount2);
  }
  const budget = maxBytes - markerBytes;
  let byteCount = 0;
  let charCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const charBytes = Buffer.byteLength(text.charAt(i), "utf8");
    if (byteCount + charBytes > budget) break;
    byteCount += charBytes;
    charCount += 1;
  }
  let cut = text.slice(0, charCount);
  const newlineAt = cut.lastIndexOf("\n");
  if (newlineAt > Math.floor(cut.length / 2)) cut = cut.slice(0, newlineAt);
  return cut + marker;
}
function renderPromptHits(payload, maxBytes) {
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, 3) : [];
  const lines = [];
  for (const hit of hits) {
    if (typeof hit !== "object" || hit === null) continue;
    const pointer = typeof hit.pointer === "string" ? parsePointer(hit.pointer) : void 0;
    const rawTitle = typeof hit.title === "string" && hit.title !== "" ? hit.title : void 0;
    const [titleName, titleKind] = rawTitle?.split(" \xB7 ") ?? [];
    const title = titleName !== void 0 && titleName !== "" ? titleKind !== void 0 && titleKind !== "" ? `${titleName} (${titleKind})` : titleName : void 0;
    const score = typeof hit.score === "number" ? hit.score.toFixed(2) : void 0;
    const parts = [];
    if (pointer !== void 0) parts.push(formatPointer(pointer));
    if (title !== void 0) parts.push(title);
    if (score !== void 0) parts.push(`score ${score}`);
    if (parts.length === 0) continue;
    lines.push(`- ${parts.join(" \u2014 ")}`);
  }
  if (lines.length === 0) return "";
  const header = "Graph prompt hits for your question (pointers only \u2014 use the graph tools for source):";
  return truncateToBytes(`${header}
${lines.join("\n")}`, maxBytes);
}
function renderPromptHitsSourced(payload, maxBytes) {
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, 3) : [];
  const top = hits[0];
  if (top === void 0) return renderPromptHits(payload, maxBytes);
  const topCode = typeof top.code === "string" && top.code.trim() !== "" ? top.code.trim() : void 0;
  if (topCode === void 0) return renderPromptHits(payload, maxBytes);
  const lines = [];
  const pointer = typeof top.pointer === "string" ? parsePointer(top.pointer) : void 0;
  const header = pointer !== void 0 ? `Graph top hit for your question (with source \u2014 the crux is inlined; related pointers below):` : "Graph top hit for your question (with source):";
  lines.push(header);
  if (pointer !== void 0) lines.push(`- ${formatPointer(pointer)}`);
  if (typeof top.title === "string" && top.title !== "") lines.push(`  ${top.title}`);
  lines.push("  ```");
  for (const codeLine of topCode.split("\n")) lines.push(`  ${codeLine}`);
  lines.push("  ```");
  for (const hit of hits.slice(1)) {
    if (typeof hit !== "object" || hit === null) continue;
    const p = typeof hit.pointer === "string" ? parsePointer(hit.pointer) : void 0;
    const score = typeof hit.score === "number" ? hit.score.toFixed(2) : void 0;
    const parts = [];
    if (p !== void 0) parts.push(formatPointer(p));
    if (typeof hit.title === "string" && hit.title !== "") parts.push(hit.title);
    if (score !== void 0) parts.push(`score ${score}`);
    if (parts.length === 0) continue;
    lines.push(`- ${parts.join(" \u2014 ")}`);
  }
  return truncateToBytes(lines.join("\n"), maxBytes);
}
function renderNudge() {
  return "Tip: before a broad grep/glob over the whole repo, try the graph tools first \u2014 graph_find_code for a concrete question, graph_repo_map to orient. They return ranked file:line pointers (with source on request) and are cheaper than a blind scan.";
}
function renderBlastRadius(filePath, symbols, maxBytes, maxCallersPerSymbol = 5) {
  const lines = [];
  for (const symbol of symbols) {
    if (typeof symbol !== "object" || symbol === null) continue;
    const name2 = typeof symbol.name === "string" && symbol.name !== "" ? symbol.name : void 0;
    const callers = Array.isArray(symbol.callers) ? symbol.callers : [];
    const shown = callers.filter((caller) => typeof caller === "object" && caller !== null && typeof caller.name === "string").slice(0, maxCallersPerSymbol);
    if (name2 === void 0 || shown.length === 0) continue;
    const parts = shown.map((caller) => {
      const where = caller.path !== void 0 ? `${caller.path}${caller.span !== void 0 ? `:${caller.span}` : ""}` : void 0;
      return where !== void 0 ? `${caller.name} @ ${where}` : caller.name;
    });
    lines.push(`- ${name2} \u2190 ${parts.join(", ")}`);
  }
  if (lines.length === 0) return "";
  const header = `Graph blast radius after editing ${filePath} (who depends on it):`;
  return truncateToBytes(`${header}
${lines.join("\n")}`, maxBytes);
}
function renderMap(payload, maxBytes) {
  const totals = payload.totals;
  const head = totals !== void 0 && typeof totals === "object" ? `repo map \u2014 ${totals.files ?? "?"} files \xB7 ${totals.symbols ?? "?"} symbols \xB7 ${totals.edges ?? "?"} edges${Array.isArray(totals.languages) && totals.languages.length > 0 ? ` \xB7 ${totals.languages.join(", ")}` : ""}` : "repo map";
  const lines = [head];
  const dirs = Array.isArray(payload.dirs) ? payload.dirs : [];
  for (const dir of dirs) {
    if (typeof dir !== "object" || dir === null) continue;
    const path = typeof dir.path === "string" ? dir.path : "?";
    const hubs = Array.isArray(dir.hubs) ? dir.hubs.filter((hub) => typeof hub === "object" && hub !== null && typeof hub.name === "string").slice(0, 3).map((hub) => hub.name).join(", ") : "";
    const hubText = hubs !== "" ? `   hubs: ${hubs}` : "";
    lines.push(`${path}   ${dir.files ?? "?"} files \xB7 ${dir.symbols ?? "?"} symbols${hubText}`);
  }
  if (typeof payload.dropped === "number" && payload.dropped > 0) {
    lines.push(`(\u2026 ${payload.dropped} more entries dropped)`);
  }
  const hotspots = Array.isArray(payload.hotspots) ? payload.hotspots : [];
  if (hotspots.length > 0) {
    const top = hotspots.filter((hotspot) => typeof hotspot === "object" && hotspot !== null && typeof hotspot.name === "string").slice(0, 5).map((hotspot) => {
      const pointer = hotspot.path !== void 0 ? `${hotspot.path}${hotspot.span !== void 0 ? `:${hotspot.span}` : ""}` : void 0;
      return `${hotspot.name}${pointer !== void 0 ? ` @ ${pointer}` : ""}${typeof hotspot.inDegree === "number" ? ` (${hotspot.inDegree} callers)` : ""}`;
    }).join(" \xB7 ");
    lines.push(`hotspots: ${top}`);
  }
  return truncateToBytes(lines.join("\n"), maxBytes);
}
function renderCheck(payload, maxPaths) {
  const graph = typeof payload.graph === "object" && payload.graph !== null ? payload.graph : void 0;
  const context = typeof payload.context === "object" && payload.context !== null ? payload.context : void 0;
  if (graph === void 0) return "Freshness check returned no graph report (no graph/ directory?).";
  if (graph.missing === true) return "No graft/ index found \u2014 run `graft build` in the repo root first.";
  const lines = [];
  if (graph.ok === true) {
    lines.push(`Fresh: graph covers the working tree (${graph.nodes ?? "?"} nodes${typeof graph.pending === "number" && graph.pending > 0 ? `, ${graph.pending} pending rebuild` : ""}).`);
  } else {
    lines.push("Stale: the graph does not cover the current code.");
    const drift = (label, paths) => {
      if (!Array.isArray(paths) || paths.length === 0) return void 0;
      const shown = paths.slice(0, maxPaths).map((p) => String(p)).join(", ");
      const more = paths.length > maxPaths ? ` (+${paths.length - maxPaths} more)` : "";
      return `${label}: ${shown}${more}`;
    };
    const parts = [drift("added", graph.added), drift("removed", graph.removed), drift("changed", graph.changed), drift("stale", graph.stale)].filter((part) => part !== void 0);
    if (parts.length > 0) lines.push(parts.join("\n"));
    lines.push("Run `graft build` to refresh (structural, no LLM).");
  }
  if (context !== void 0 && context.missing === true) {
    lines.push("Note: LLM context layer absent (expected without `--deep`).");
  }
  return lines.join("\n");
}

// src/repo.ts
import { existsSync } from "node:fs";
import { dirname, join as join2, resolve, sep } from "node:path";
var existsOnDisk = (path) => existsSync(path);
function findGitRoot(cwd, exists = existsOnDisk) {
  if (cwd === void 0 || cwd === "") return void 0;
  let dir = resolve(cwd);
  for (; ; ) {
    if (exists(join2(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function findGraphDir(cwd, exists = existsOnDisk) {
  if (cwd === void 0 || cwd === "") return void 0;
  let dir = resolve(cwd);
  for (; ; ) {
    const candidate = join2(dir, "graft");
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function resolveRepoAnchor(cwd, processCwd = process.cwd(), exists = existsOnDisk) {
  const effectiveCwd = cwd !== void 0 && cwd !== "" ? cwd : processCwd;
  const gitRoot = findGitRoot(effectiveCwd, exists);
  const graphDir = findGraphDir(effectiveCwd, exists);
  const graphRepoRoot = graphDir !== void 0 && graphDir.endsWith(sep + "graft") ? dirname(graphDir) : graphDir;
  return {
    cwd: effectiveCwd,
    ...gitRoot !== void 0 ? { gitRoot } : {},
    ...graphDir !== void 0 ? { graphDir, graphRepoRoot } : {},
    outsideGit: gitRoot === void 0
  };
}

// src/session-state.ts
import { existsSync as existsSync2, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
var LOCK_FILE_NAME = ".dsh-context-graph-build.lock";
var LOCK_GRACE_MS = 3e4;
var PROMPT_MEMO_MAX = 32;
function hashPrompt(prompt) {
  const text = prompt.slice(0, 1024);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) + hash + text.charCodeAt(i) | 0;
  }
  return `p${hash >>> 0}`;
}
var SessionStateStore = class _SessionStateStore {
  states = /* @__PURE__ */ new Map();
  static key(sessionId, gitRoot) {
    return `${sessionId}\0${gitRoot ?? ""}`;
  }
  /** Get (or lazily create) the state for one (session, repo) pair. */
  get(sessionId, gitRoot) {
    const key = _SessionStateStore.key(sessionId, gitRoot);
    let state = this.states.get(key);
    if (state === void 0) {
      state = { dirty: false, injectedHits: /* @__PURE__ */ new Set(), promptMemo: /* @__PURE__ */ new Map(), graphToolCalls: 0, nudgeSent: false };
      this.states.set(key, state);
    }
    return state;
  }
  /** Remember the repo-relative path of the last edited file (P2 scope hint). */
  setLastFile(sessionId, gitRoot, relPath) {
    this.get(sessionId, gitRoot).lastFile = relPath;
  }
  /** The last edited file (relative), or undefined before the first edit. */
  getLastFile(sessionId, gitRoot) {
    return this.states.get(_SessionStateStore.key(sessionId, gitRoot))?.lastFile;
  }
  /** Count one accepted graph_* tool call (resets the nudge precondition). */
  bumpGraphCalls(sessionId, gitRoot) {
    this.get(sessionId, gitRoot).graphToolCalls += 1;
  }
  /** Whether any graph_* tool was called in this (session, repo). */
  hasGraphCalls(sessionId, gitRoot) {
    return (this.states.get(_SessionStateStore.key(sessionId, gitRoot))?.graphToolCalls ?? 0) > 0;
  }
  /**
   * True (and recorded) when the nudge had NOT been sent before. Sent once
   * per (session, repo), ever — the spec asks for a single reminder.
   */
  markNudgeSent(sessionId, gitRoot) {
    const state = this.get(sessionId, gitRoot);
    if (state.nudgeSent) return false;
    state.nudgeSent = true;
    return true;
  }
  /** Whether a hit key was already injected in this (session, repo). */
  isHitInjected(sessionId, gitRoot, hit) {
    return this.states.get(_SessionStateStore.key(sessionId, gitRoot))?.injectedHits.has(hit) === true;
  }
  /** Top-hit key memoized for a recent prompt (undefined when unseen). */
  lookupPromptHit(sessionId, gitRoot, promptHash) {
    return this.get(sessionId, gitRoot).promptMemo.get(promptHash);
  }
  /** Remember the top hit a prompt produced (bounded, oldest evicted). */
  recordPromptHit(sessionId, gitRoot, promptHash, hit) {
    const memo = this.get(sessionId, gitRoot).promptMemo;
    if (memo.has(promptHash)) memo.delete(promptHash);
    memo.set(promptHash, hit);
    while (memo.size > PROMPT_MEMO_MAX) {
      const oldest = memo.keys().next().value;
      if (oldest === void 0) break;
      memo.delete(oldest);
    }
  }
  /** Mark the (session, repo) graph dirty (a source edit happened). */
  markDirty(sessionId, gitRoot) {
    this.get(sessionId, gitRoot).dirty = true;
  }
  /** Clear the dirty flag (a rebuild is running or done). */
  clearDirty(sessionId, gitRoot) {
    this.get(sessionId, gitRoot).dirty = false;
  }
  /** Whether the (session, repo) graph needs a rebuild. */
  isDirty(sessionId, gitRoot) {
    return this.states.get(_SessionStateStore.key(sessionId, gitRoot))?.dirty === true;
  }
  /** True (and recorded) when the hit was not injected before in this session. */
  markHitInjected(sessionId, gitRoot, hit) {
    const state = this.get(sessionId, gitRoot);
    if (state.injectedHits.has(hit)) return false;
    state.injectedHits.add(hit);
    return true;
  }
  /** Drop all state for one session (agent disposal hook, if wired later). */
  forgetSession(sessionId) {
    for (const key of this.states.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.states.delete(key);
    }
  }
};
function readLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
  }
  return void 0;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function acquireBuildLock(repoRoot, buildTimeoutMs, now = Date.now()) {
  const lockPath = join3(repoRoot, LOCK_FILE_NAME);
  const existing = readLock(lockPath);
  if (existing !== void 0) {
    const fresh = now - existing.startedAt < buildTimeoutMs + LOCK_GRACE_MS;
    if (fresh && pidAlive(existing.pid)) {
      return { acquired: false, own: false, reason: `build in progress (pid ${existing.pid})` };
    }
  }
  try {
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: now }), "utf8");
    return { acquired: true, own: true };
  } catch (error) {
    return { acquired: false, own: false, reason: `lock write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function releaseBuildLock(repoRoot) {
  const lockPath = join3(repoRoot, LOCK_FILE_NAME);
  const existing = readLock(lockPath);
  if (existing !== void 0 && existing.pid === process.pid) {
    try {
      rmSync(lockPath);
    } catch {
    }
  }
}

// src/hooks.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function agentSessionCwd(agent) {
  try {
    return agent.session?.header?.cwd;
  } catch {
    return void 0;
  }
}
function agentId(agent) {
  try {
    return String(agent.id);
  } catch {
    return "unknown-agent";
  }
}
function injectSafe(agent, text, deps) {
  try {
    agent.inject(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: deps.pluginName }
    }));
  } catch (error) {
    deps.logger.warn(`dsh-context-graph: inject skipped (${errorMessage(error)})`);
  }
}
var MAP_INTRO = "Repo context graph (built by dsh-context-graph; refresh with graft build after large edits):";
async function handleSessionStart(agent, source, config, deps, runGraph2) {
  if (!config.injectSessionMap) return;
  const sessionCwd = agentSessionCwd(agent);
  if (sessionCwd === void 0) return;
  let anchor;
  try {
    anchor = resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd());
  } catch {
    return;
  }
  if (anchor.outsideGit) return;
  const root = anchor.gitRoot;
  if (root === void 0) return;
  const sessionKey = agentId(agent);
  deps.state.get(sessionKey, root);
  if (anchor.graphDir === void 0) {
    if (!config.autoBuild) return;
    const claim = acquireBuildLock(root, config.buildTimeoutMs);
    if (!claim.acquired) {
      injectSafe(
        agent,
        "The repo context graph is not built yet and a structural engine build is already running. If graph tools report GRAPH_MISSING, wait briefly and retry; until then prefer targeted reads over whole-repo grep.",
        deps
      );
      return;
    }
    const handle = deps.spawnBuild(root, { graphPath: config.graphPath, buildTimeoutMs: config.buildTimeoutMs });
    if (handle.error !== void 0) {
      deps.logger.warn(`dsh-context-graph: autoBuild failed: ${handle.error}`);
      injectSafe(
        agent,
        "The repo context graph is not built yet and the background build could not start. Fall back to ordinary read/grep; run `graft build` manually to enable the graph_* tools.",
        deps
      );
      return;
    }
    deps.logger.info(`dsh-context-graph: structural graft build started in ${root} (pid ${handle.pid ?? "unknown"}, source ${source})`);
    void handle.exited?.then(() => {
      if (deps.releaseLock !== void 0) deps.releaseLock(root);
      else releaseBuildLock(root);
    });
    injectSafe(
      agent,
      "The repo context graph is being built in the background (structural graft build, no LLM). If graph_repo_map or graph_find_code report GRAPH_MISSING, the build is still running \u2014 retry shortly. Until it is ready, prefer targeted reads over whole-repo grep.",
      deps
    );
    return;
  }
  const dir = anchor.graphRepoRoot ?? root;
  try {
    const { json, code } = await runGraph2(["map", "--json", dir], {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath
    });
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: graft map exited ${code}; skipping session map inject`);
      return;
    }
    injectSafe(agent, `${MAP_INTRO}
${renderMap(json, config.maxInjectBytes)}`, deps);
  } catch (error) {
    if (error instanceof GraphError && error.code === "GRAPH_CLI_MISSING") {
      return;
    }
    deps.logger.warn(`dsh-context-graph: session map inject failed (${errorMessage(error)})`);
  }
}
function sessionAnchor(agent, deps) {
  const sessionCwd = agentSessionCwd(agent);
  if (sessionCwd === void 0) return void 0;
  try {
    return resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd());
  } catch {
    return void 0;
  }
}
function promptText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (content === void 0 || !Array.isArray(content)) continue;
    const text = content.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
    if (text.length > 0) return text;
  }
  return "";
}
function editedFilePath(args) {
  if (typeof args !== "object" || args === null) return void 0;
  const record = args;
  for (const key of ["file_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return void 0;
}
async function handlePreStep(payload, next, config, deps, runGraph2) {
  const decision = await next();
  if (!config.injectPromptHits || config.injectMode === "map-only") return decision;
  if (decision.kind !== "enter") return decision;
  try {
    const prompt = promptText(decision.messages);
    if (prompt.length < config.promptMinChars) return decision;
    const agent = payload.agent;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return decision;
    const root = anchor.gitRoot;
    if (root === void 0 || anchor.graphDir === void 0) return decision;
    const sessionKey = agentId(agent);
    const dir = anchor.graphRepoRoot ?? root;
    const promptHash = hashPrompt(prompt);
    const memoized = deps.state.lookupPromptHit(sessionKey, root, promptHash);
    if (memoized !== void 0 && deps.state.isHitInjected(sessionKey, root, memoized)) {
      return decision;
    }
    const lastFile = config.scopeFromLastEdit ? deps.state.getLastFile(sessionKey, root) : void 0;
    const scope = lastFile !== void 0 && lastFile.includes("/") ? lastFile.slice(0, lastFile.indexOf("/")) : void 0;
    const args = ["ask", prompt.slice(0, 1024), "--json", "-n", "3"];
    if (config.injectMode === "sourced") args.push("--source");
    if (scope !== void 0) args.push("--in", scope);
    args.push(dir);
    const { json, code } = await runGraph2(args, {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath,
      signal: payload.signal
    });
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: pre-step ask exited ${code}; skipping`);
      return decision;
    }
    const hits = Array.isArray(json.hits) ? json.hits : [];
    const top = hits[0];
    if (top === void 0 || typeof top !== "object" || top === null) return decision;
    const hitKey = `${typeof top.pointer === "string" ? top.pointer : ""}\0${typeof top.title === "string" ? top.title : ""}`;
    deps.state.recordPromptHit(sessionKey, root, promptHash, hitKey);
    if (!deps.state.markHitInjected(sessionKey, root, hitKey)) return decision;
    const rendered = config.injectMode === "sourced" ? renderPromptHitsSourced(json, config.maxInjectBytes) : renderPromptHits(json, config.maxInjectBytes);
    if (rendered === "") return decision;
    const message = createUserMessage({
      content: [{ type: "text", text: rendered }],
      source: { kind: "plugin", plugin: deps.pluginName }
    });
    return { ...decision, messages: [...decision.messages, message] };
  } catch (error) {
    if (error instanceof GraphError && error.code === "GRAPH_CLI_MISSING") return decision;
    deps.logger.error(`dsh-context-graph: pre-step hook failed (${errorMessage(error)})`);
    return decision;
  }
}
async function blastRadiusForFile(relPath, dir, config, runGraph2) {
  const { json: skeleton, code } = await runGraph2(
    ["skeleton", relPath, "--json", dir],
    { cwd: dir, timeoutMs: config.timeoutMs, graphPath: config.graphPath }
  );
  if (code !== 0) return "";
  const entries = Array.isArray(skeleton.entries) ? skeleton.entries.slice(0, 3) : [];
  const symbols = [];
  for (const entry of entries) {
    const name2 = typeof entry?.name === "string" && entry.name !== "" ? entry.name : void 0;
    if (name2 === void 0) continue;
    let callers = [];
    try {
      const { json: calls } = await runGraph2(
        ["callers", name2, "--direction", "in", "-d", "1", "--json", dir],
        { cwd: dir, timeoutMs: config.timeoutMs, graphPath: config.graphPath }
      );
      const match = Array.isArray(calls.matches) ? calls.matches[0] : void 0;
      const hits = typeof match === "object" && match !== null && Array.isArray(match.hits) ? match.hits : [];
      callers = hits.map((hit) => ({
        name: typeof hit?.name === "string" ? hit.name : void 0,
        path: typeof hit?.path === "string" ? hit.path : void 0,
        span: typeof hit?.span === "string" ? hit.span : void 0,
        relation: typeof hit?.relation === "string" ? hit.relation : void 0
      }));
    } catch {
      continue;
    }
    symbols.push({ name: name2, callers });
  }
  return renderBlastRadius(relPath, symbols, config.maxInjectBytes);
}
function readTargetKind(exec, agent, anchor, deps) {
  if (anchor === void 0 || anchor.outsideGit || anchor.gitRoot === void 0) return "unknown";
  const root = anchor.gitRoot;
  const args = typeof exec.arguments === "object" && exec.arguments !== null ? exec.arguments : {};
  const readPath = typeof args.file_path === "string" && args.file_path !== "" ? args.file_path : typeof args.path === "string" && args.path !== "" ? args.path : void 0;
  if (readPath === void 0) return exec.name === "read" ? "unknown" : "source";
  const sessionCwd = agentSessionCwd(agent);
  if (sessionCwd === void 0) return "unknown";
  const resolved = isAbsolute2(readPath) ? readPath : resolve2(sessionCwd, readPath);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute2(rel)) return "nonSource";
  const graphDir = anchor.graphDir ?? join4(root, "graft");
  if (resolved === graphDir || resolved.startsWith(graphDir + "/")) return "nonSource";
  return "source";
}
async function handlePostExecute(exec, _result, next, config, deps, runGraph2) {
  const decision = await next();
  try {
    if (decision.kind !== "accept") return decision;
    const agent = exec.agent;
    if (agent === void 0) return decision;
    const sessionKey = agentId(agent);
    if (config.metrics && deps.recordMetric !== void 0) {
      if (exec.name.startsWith("graph_")) {
        deps.recordMetric(sessionKey, "graph");
      } else if (exec.name === "read" || exec.name === "grep" || exec.name === "glob") {
        const kind = readTargetKind(exec, agent, sessionAnchor(agent, deps), deps);
        if (kind === "source") deps.recordMetric(sessionKey, "source");
      }
    }
    if (!config.editToolNames.includes(exec.name)) return decision;
    const sessionCwd = agentSessionCwd(agent);
    if (sessionCwd === void 0) return decision;
    const filePath = editedFilePath(exec.arguments);
    if (filePath === void 0) return decision;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return decision;
    const root = anchor.gitRoot;
    if (root === void 0) return decision;
    const resolved = isAbsolute2(filePath) ? filePath : resolve2(sessionCwd, filePath);
    const rel = relative(root, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute2(rel)) return decision;
    const graphDir = anchor.graphDir ?? join4(root, "graft");
    if (resolved === graphDir || resolved.startsWith(graphDir + "/")) return decision;
    deps.state.markDirty(sessionKey, root);
    deps.state.setLastFile(sessionKey, root, rel);
    if (!config.injectBlastRadius || anchor.graphDir === void 0) return decision;
    const dir = anchor.graphRepoRoot ?? root;
    const blast = await blastRadiusForFile(rel, dir, config, runGraph2);
    if (blast === "") return decision;
    const message = createUserMessage({
      content: [{ type: "text", text: blast }],
      source: { kind: "plugin", plugin: deps.pluginName }
    });
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], message] };
  } catch (error) {
    if (error instanceof GraphError && error.code === "GRAPH_CLI_MISSING") return decision;
    deps.logger.error(`dsh-context-graph: post-execute hook failed (${errorMessage(error)})`);
    return decision;
  }
}
function isPathNarrowed(args) {
  if (typeof args !== "object" || args === null) return false;
  const path = args.path;
  return typeof path === "string" && path.trim() !== "";
}
async function handlePreExecute(exec, next, config, deps) {
  const decision = await next();
  try {
    if (decision.kind !== "allow") return decision;
    const agent = exec.agent;
    if (agent === void 0) return decision;
    const sessionCwd = agentSessionCwd(agent);
    if (sessionCwd === void 0) return decision;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return decision;
    const root = anchor.gitRoot;
    if (root === void 0) return decision;
    const sessionKey = agentId(agent);
    if (exec.name.startsWith("graph_")) deps.state.bumpGraphCalls(sessionKey, root);
    if (config.guardWiringReads && exec.name === "read") {
      const args = typeof exec.arguments === "object" && exec.arguments !== null ? exec.arguments : {};
      const readPath = typeof args.file_path === "string" && args.file_path !== "" ? args.file_path : void 0;
      if (readPath !== void 0) {
        const resolved = isAbsolute2(readPath) ? readPath : resolve2(sessionCwd, readPath);
        const graphInner = join4(anchor.graphDir ?? join4(root, "graft"), ".graph");
        if (resolved === graphInner || resolved.startsWith(graphInner + "/")) {
          return {
            kind: "deny",
            reason: "Do not read raw graft/.graph files (wiring.json and friends) \u2014 they are engine internals, not the interface. Use the graph_* tools instead: graph_find_code, graph_repo_map, graph_trace_calls, graph_file_api, graph_find_all."
          };
        }
      }
    }
    if (config.nudgeOnBlindSearch && (exec.name === "grep" || exec.name === "glob") && !isPathNarrowed(exec.arguments) && !deps.state.hasGraphCalls(sessionKey, root) && deps.state.markNudgeSent(sessionKey, root)) {
      injectSafe(agent, renderNudge(), deps);
    }
    return decision;
  } catch (error) {
    deps.logger.error(`dsh-context-graph: pre-execute hook failed (${errorMessage(error)})`);
    return decision;
  }
}
async function handleTurnStopping(agent, config, deps) {
  if (!config.autoSync) return;
  const anchor = sessionAnchor(agent, deps);
  if (anchor === void 0 || anchor.outsideGit) return;
  const root = anchor.gitRoot;
  if (root === void 0) return;
  const sessionKey = agentId(agent);
  if (!deps.state.isDirty(sessionKey, root)) return;
  const claim = acquireBuildLock(root, config.buildTimeoutMs);
  if (!claim.acquired) {
    deps.logger.info(`dsh-context-graph: turn-stop autoSync skipped (${claim.reason ?? "lock held"})`);
    return;
  }
  const handle = deps.spawnBuild(root, { graphPath: config.graphPath, buildTimeoutMs: config.buildTimeoutMs });
  deps.state.clearDirty(sessionKey, root);
  if (handle.error !== void 0) {
    deps.logger.warn(`dsh-context-graph: autoSync build failed: ${handle.error}`);
    if (deps.releaseLock !== void 0) deps.releaseLock(root);
    else releaseBuildLock(root);
    return;
  }
  deps.logger.info(`dsh-context-graph: structural graft build started on turn-stop in ${root} (pid ${handle.pid ?? "unknown"})`);
  void handle.exited?.then(() => {
    if (deps.releaseLock !== void 0) deps.releaseLock(root);
    else releaseBuildLock(root);
  });
}
function registerHooks(ctx, config, deps, runGraph2) {
  if (config.injectSessionMap) {
    ctx.on("agent/session-start", (payload) => {
      void handleSessionStart(payload.agent, payload.source, config, deps, runGraph2).catch((error) => {
        deps.logger.error(`dsh-context-graph: session-start hook failed (${errorMessage(error)})`);
      });
    });
  }
  ctx.on("agent/pre-step", (payload, next) => {
    return handlePreStep(payload, next, config, deps, runGraph2);
  });
  ctx.on("tools/pre-execute", (exec, next) => {
    return handlePreExecute(exec, next, config, deps);
  });
  ctx.on("tools/post-execute", (exec, result, next) => {
    return handlePostExecute(exec, result, next, config, deps, runGraph2);
  });
  ctx.on("agent/turn-stopping", (payload) => {
    void handleTurnStopping(payload.agent, config, deps).catch((error) => {
      deps.logger.error(`dsh-context-graph: turn-stopping hook failed (${errorMessage(error)})`);
    });
  });
}

// src/metrics.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join6 } from "node:path";

// src/skill.ts
import { homedir } from "node:os";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/skill-template.ts
var SKILL_FILE_RELATIVE_PATH = "skills/graph/SKILL.md";
var SKILL_TEMPLATE = `---
name: graph
description: Query the local repo context graph (symbols, call edges, blast radius) instead of blind grep/read.
whenToUse: Orienting in a repo, locating code by question/symbol/error, tracing callers/callees, checking graph freshness after edits.
---

# Repo context graph (native tools)

The repo has a local context graph (the \`graft/\` directory, built by the
\`@nanonets/graft\` CLI). Use the native graph tools instead of blind
exploration:

- \`graph_repo_map\` \u2014 first call in an unfamiliar repo: directory clusters,
  hub symbols, global hotspots.
- \`graph_find_code\` \u2014 question, symbol, or error message to ranked
  file:line pointers (set \`source: true\` to inline the crux at each hit).
- \`graph_file_api\` \u2014 signatures of one file without reading its body.
- \`graph_trace_calls\` \u2014 who calls a symbol (\`direction: in\`) or what it
  calls (\`direction: out\`); \`depth > 1\` walks transitively (blast radius).
- \`graph_find_all\` \u2014 regex search over indexed sources, ranked by coupling.
- \`graph_check_freshness\` \u2014 drift report; call after larger edits.

Rules:
1. Call a graph tool BEFORE a broad grep/read when the question maps to
   structure (who, where, what calls). Raw grep stays available for
   one-offs and non-indexed files.
2. Never read \`graft/.graph/wiring.json\` or the full \`graft/INDEX.md\` \u2014
   the tools are the interface.
3. On \`GRAPH_MISSING\` (no graph yet) the plugin builds it in the
   background; retry shortly, or run \`graft build\` manually.
4. On \`GRAPH_CLI_MISSING\`, install the engine once: \`npm i -g
   @nanonets/graft\`.
`;
function renderSkillTemplate() {
  return SKILL_TEMPLATE;
}

// src/skill.ts
function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (fromEnv !== void 0 && fromEnv.trim() !== "") return fromEnv;
  return join5(homedir(), ".dsh");
}
function installSkill(options = {}) {
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.warn(`dsh-context-graph: skill install skipped (${message})`);
    return { ok: false, error: message };
  };
  try {
    const home = resolveDshHome(options.env);
    const file = join5(home, SKILL_FILE_RELATIVE_PATH);
    if (existsSync3(file)) {
      return { ok: true, path: file };
    }
    mkdirSync2(join5(home, "skills", "graph"), { recursive: true });
    writeFileSync2(file, renderSkillTemplate(), "utf8");
    return { ok: true, path: file };
  } catch (error) {
    return fail(error);
  }
}

// src/metrics.ts
var STATS_FILE_NAME = "context-graph-stats.json";
var MAX_SESSIONS = 32;
function statsPath() {
  return join6(resolveDshHome(), STATS_FILE_NAME);
}
function recordToolCall(sessionId, kind) {
  try {
    const path = statsPath();
    let stats = {};
    try {
      const parsed = JSON.parse(readFileSync2(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        stats = parsed;
      }
    } catch {
      stats = {};
    }
    const row = stats[sessionId] ?? { graphReads: 0, sourceReads: 0, updatedAt: 0 };
    if (kind === "graph") row.graphReads += 1;
    else row.sourceReads += 1;
    row.updatedAt = Date.now();
    stats[sessionId] = row;
    const keys = Object.keys(stats);
    if (keys.length > MAX_SESSIONS) {
      keys.sort((a, b) => (stats[b]?.updatedAt ?? 0) - (stats[a]?.updatedAt ?? 0)).slice(MAX_SESSIONS).forEach((key) => {
        delete stats[key];
      });
    }
    writeFileSync3(path, JSON.stringify(stats, null, 1), "utf8");
  } catch {
  }
}

// src/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var TOOL_NAMES = {
  findCode: "graph_find_code",
  fileApi: "graph_file_api",
  traceCalls: "graph_trace_calls",
  findAll: "graph_find_all",
  repoMap: "graph_repo_map",
  checkFreshness: "graph_check_freshness"
};
async function withGraph(anchor, config, deps, signal, buildArgs, interpret) {
  const dir = anchor.graphRepoRoot ?? anchor.gitRoot ?? anchor.cwd;
  if (anchor.graphDir === void 0) {
    return {
      ok: false,
      error: "GRAPH_MISSING",
      hint: `no graft/ index found from ${anchor.cwd}; run: graft build${anchor.gitRoot !== void 0 ? ` (in ${anchor.gitRoot})` : ""}`
    };
  }
  try {
    const { json, code, result } = await deps.runGraphJson(buildArgs(dir), {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      ...signal !== void 0 ? { signal } : {},
      graphPath: config.graphPath
    });
    if (result.viaNpx) deps.onNpxFallback?.("graft CLI resolved via npx (cold start); install globally: npm i -g @nanonets/graft");
    return interpret(json, code, dir);
  } catch (error) {
    if (error instanceof GraphError) {
      return {
        ok: false,
        error: error.code,
        ...error.hint !== void 0 ? { hint: error.hint } : {}
      };
    }
    return {
      ok: false,
      error: "GRAPH_FAILED",
      ...error instanceof Error ? { hint: error.message } : {}
    };
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : void 0;
}
function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
function stringArray(value, cap) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "") out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}
function anchorFromExec(exec, deps) {
  const sessionCwd = exec.agent?.session?.header?.cwd;
  return resolveRepoAnchor(sessionCwd, deps.processCwd?.() ?? process.cwd());
}
var findCodeHitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    line: { type: "integer" },
    endLine: { type: "integer" },
    symbol: { type: "string" },
    kind: { type: "string" },
    snippet: { type: "string" },
    score: { type: "number" }
  }
};
function buildFindCodeTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.findCode,
    description: "Locate code by question, symbol, or error message using the repo context graph. Call this BEFORE broad grep/read when orienting in the repo; returns ranked pointers (file:line) with crux snippets. Set source=true to inline the defining source at each hit.",
    parameters: {
      query: { type: "string", required: true, description: "Question, symbol, or error message." },
      source: { type: "boolean", description: "Inline source crux at each hit (default false = pointers only)." },
      limit: { type: "integer", description: "Max hits, 1-10 (default 3)." },
      scope: { type: "string", description: "Path prefix to narrow the search (repo-relative)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          mode: { type: "string" },
          hits: { type: "array", items: findCodeHitSchema }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${record.error ?? ""} ${typeof record.hint === "string" ? `\u2014 ${record.hint}` : ""}`.trim() }];
        }
        const hits = Array.isArray(record.hits) ? record.hits : [];
        if (hits.length === 0) return [{ type: "text", text: "No graph hits for that query. Try graph_repo_map for orientation or graph_check_freshness." }];
        const lines = hits.map((hit) => {
          const where = formatPointer({
            path: hit.path,
            ...hit.line !== void 0 ? { startLine: hit.line } : {},
            ...hit.endLine !== void 0 ? { endLine: hit.endLine } : {}
          });
          const who = hit.symbol !== void 0 ? `${hit.symbol}${hit.kind !== void 0 ? ` (${hit.kind})` : ""}` : void 0;
          const score = hit.score !== void 0 ? ` [${hit.score.toFixed(2)}]` : "";
          const body = hit.snippet !== void 0 && hit.snippet !== "" ? `
  ${hit.snippet}` : "";
          return `- ${who !== void 0 ? `${who} @ ` : ""}${where}${score}${body}`;
        });
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const limit = clampInt(args.limit, 1, 10, 3);
      const query = args.query.trim();
      if (query === "") return { ok: false, error: "GRAPH_BAD_ARGS", hint: "query must be non-empty" };
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => {
          const parts = ["ask", query, "--json", "-n", String(limit)];
          if (args.source === true) parts.push("--source");
          if (args.scope !== void 0 && args.scope.trim() !== "") parts.push("--in", args.scope.trim());
          parts.push(dir);
          return parts;
        },
        (json) => {
          const payload = asRecord(json) ?? {};
          const rawHits = Array.isArray(payload.hits) ? payload.hits : [];
          const hits = [];
          for (const raw of rawHits) {
            const hit = asRecord(raw);
            if (hit === void 0) continue;
            const pointer = typeof hit.pointer === "string" ? parsePointer(hit.pointer) : void 0;
            if (pointer === void 0) continue;
            const title = typeof hit.title === "string" ? hit.title : "";
            const [symbolName, symbolKind] = title.split(" \xB7 ");
            hits.push({
              path: pointer.path,
              ...pointer.startLine !== void 0 ? { line: pointer.startLine } : {},
              ...pointer.endLine !== void 0 ? { endLine: pointer.endLine } : {},
              ...symbolName !== void 0 && symbolName !== "" ? { symbol: symbolName } : {},
              ...symbolKind !== void 0 && symbolKind !== "" ? { kind: symbolKind } : {},
              ...typeof hit.snippet === "string" && hit.snippet !== "" ? { snippet: hit.snippet } : {},
              ...typeof hit.score === "number" ? { score: hit.score } : {}
            });
            if (hits.length >= limit) break;
          }
          return {
            ok: true,
            ...typeof payload.mode === "string" ? { mode: payload.mode } : {},
            hits
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var fileApiEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    kind: { type: "string" },
    span: { type: "string" },
    signature: { type: "string" }
  }
};
function buildFileApiTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.fileApi,
    description: "Show a file's API surface \u2014 exported/local signatures with line spans, no bodies. Cheaper than read when you only need to know what a file declares before calling into it.",
    parameters: {
      path: { type: "string", required: true, description: "Repo-relative file path (or unique basename)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          file: { type: "string" },
          entries: { type: "array", items: fileApiEntrySchema }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const entries = Array.isArray(record.entries) ? record.entries : [];
        if (entries.length === 0) return [{ type: "text", text: typeof record.file === "string" ? `No indexed symbols for ${record.file}.` : "No indexed symbols." }];
        const lines = [`${record.file ?? "file"} API:`];
        for (const entry of entries) {
          const span = entry.span !== void 0 ? ` @${entry.span}` : "";
          const signature = entry.signature !== void 0 ? ` \u2014 ${entry.signature}` : "";
          lines.push(`- ${entry.name}${entry.kind !== void 0 ? ` (${entry.kind})` : ""}${span}${signature}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const path = args.path.trim();
      if (path === "") return { ok: false, error: "GRAPH_BAD_ARGS", hint: "path must be non-empty" };
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => ["skeleton", path, "--json", dir],
        (json) => {
          const payload = asRecord(json) ?? {};
          const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];
          const entries = [];
          for (const raw of rawEntries) {
            const entry = asRecord(raw);
            if (entry === void 0 || typeof entry.name !== "string") continue;
            entries.push({
              name: entry.name,
              ...typeof entry.kind === "string" ? { kind: entry.kind } : {},
              ...typeof entry.span === "string" ? { span: entry.span } : {},
              ...typeof entry.signature === "string" ? { signature: entry.signature } : {}
            });
            if (entries.length >= 40) break;
          }
          return {
            ok: true,
            ...typeof payload.file === "string" ? { file: payload.file } : {},
            entries
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var traceHitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    path: { type: "string" },
    span: { type: "string" },
    relation: { type: "string" },
    depth: { type: "integer" }
  }
};
function buildTraceCallsTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.traceCalls,
    description: 'Trace call edges of a symbol: direction=in returns its callers, direction=out its callees; depth>1 walks transitively for blast radius. Use instead of manual grep for "who uses X".',
    parameters: {
      symbol: { type: "string", required: true, description: "Bare name, qualified (Class.method), or package-qualified (pkg.Fn)." },
      direction: { type: "string", enum: ["in", "out"], description: "in = callers (default), out = callees." },
      depth: { type: "integer", description: "Transitive hops, 1-6 (default 1)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          root: { type: "string" },
          direction: { type: "string" },
          hits: { type: "array", items: traceHitSchema }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const hits = Array.isArray(record.hits) ? record.hits : [];
        if (hits.length === 0) return [{ type: "text", text: `No call edges found for ${typeof record.root === "string" ? record.root : "that symbol"}.` }];
        const lines = [`${record.root ?? "?"} (${record.direction ?? "in"}):`];
        for (const hit of hits) {
          const where = hit.path !== void 0 ? `${hit.path}${hit.span !== void 0 ? `:${hit.span}` : ""}` : "?";
          const depth = typeof hit.depth === "number" && hit.depth > 1 ? ` (depth ${hit.depth})` : "";
          lines.push(`- ${hit.name} @ ${where}[${hit.relation ?? "calls"}]${depth}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const symbol = args.symbol.trim();
      if (symbol === "") return { ok: false, error: "GRAPH_BAD_ARGS", hint: "symbol must be non-empty" };
      const direction = args.direction === "out" ? "out" : "in";
      const depth = clampInt(args.depth, 1, 6, 1);
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => ["callers", symbol, "--direction", direction, "-d", String(depth), "--json", dir],
        (json) => {
          const payload = asRecord(json) ?? {};
          const matches = Array.isArray(payload.matches) ? payload.matches : [];
          const hits = [];
          let root;
          for (const raw of matches) {
            const match = asRecord(raw);
            if (match === void 0) continue;
            const symbolRecord = asRecord(match.symbol);
            if (root === void 0 && symbolRecord !== void 0 && typeof symbolRecord.name === "string") {
              root = symbolRecord.name;
            }
            const rawHits = Array.isArray(match.hits) ? match.hits : [];
            for (const rawHit of rawHits) {
              const hit = asRecord(rawHit);
              if (hit === void 0 || typeof hit.name !== "string") continue;
              hits.push({
                name: hit.name,
                ...typeof hit.path === "string" ? { path: hit.path } : {},
                ...typeof hit.span === "string" ? { span: hit.span } : {},
                ...typeof hit.relation === "string" ? { relation: hit.relation } : {},
                ...typeof hit.depth === "number" ? { depth: hit.depth } : {}
              });
              if (hits.length >= 40) break;
            }
            if (hits.length >= 40) break;
          }
          return {
            ok: true,
            ...root !== void 0 ? { root } : { root: symbol },
            direction,
            hits
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var findAllMatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    symbol: { type: "string" },
    line: { type: "integer" },
    text: { type: "string" }
  }
};
var FIND_ALL_CAP = 30;
function buildFindAllTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.findAll,
    description: "Regex search across the graph-indexed source files, hits grouped by enclosing symbol and ranked by coupling. Prefer over raw grep for code that is already in the graph; it also reports which file/symbol owns each hit.",
    parameters: {
      pattern: { type: "string", required: true, description: "Regex pattern (or literal string)." },
      path: { type: "string", description: "Narrow to files under this repo-relative prefix." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          totalHits: { type: "integer" },
          filesSearched: { type: "integer" },
          matches: { type: "array", items: findAllMatchSchema }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const matches = Array.isArray(record.matches) ? record.matches : [];
        if (matches.length === 0) {
          return [{ type: "text", text: `No matches in ${typeof record.filesSearched === "number" ? record.filesSearched : "the"} indexed file(s).` }];
        }
        const lines = [];
        let currentPath;
        for (const match of matches) {
          if (match.path !== void 0 && match.path !== currentPath) {
            currentPath = match.path;
            lines.push(`### ${currentPath}${match.symbol !== void 0 ? ` \xB7 ${match.symbol}` : ""}`);
          }
          lines.push(`- L${match.line ?? "?"}: ${match.text ?? ""}`);
        }
        if (typeof record.totalHits === "number" && record.totalHits > matches.length) {
          lines.push(`\u2026 (showing ${matches.length} of ${record.totalHits} matches)`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const pattern = args.pattern;
      if (pattern.trim() === "") return { ok: false, error: "GRAPH_BAD_ARGS", hint: "pattern must be non-empty" };
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => {
          const parts = ["grep", pattern, "--json"];
          if (args.path !== void 0 && args.path.trim() !== "") parts.push("--in", args.path.trim());
          parts.push(dir);
          return parts;
        },
        (json) => {
          const payload = asRecord(json) ?? {};
          const groups = Array.isArray(payload.groups) ? payload.groups : [];
          const matches = [];
          for (const rawGroup of groups) {
            const group = asRecord(rawGroup);
            if (group === void 0) continue;
            const groupPath = typeof group.path === "string" ? group.path : void 0;
            const symbol = asRecord(group.symbol);
            const symbolName = symbol !== void 0 && typeof symbol.name === "string" ? symbol.name : void 0;
            const rawHits = Array.isArray(group.hits) ? group.hits : [];
            for (const rawHit of rawHits) {
              const hit = asRecord(rawHit);
              if (hit === void 0) continue;
              matches.push({
                ...groupPath !== void 0 ? { path: groupPath } : {},
                ...symbolName !== void 0 ? { symbol: symbolName } : {},
                ...typeof hit.line === "number" ? { line: hit.line } : {},
                ...typeof hit.text === "string" ? { text: hit.text } : {}
              });
              if (matches.length >= FIND_ALL_CAP) break;
            }
            if (matches.length >= FIND_ALL_CAP) break;
          }
          return {
            ok: true,
            ...typeof payload.totalHits === "number" ? { totalHits: payload.totalHits } : {},
            ...typeof payload.filesSearched === "number" ? { filesSearched: payload.filesSearched } : {},
            matches
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var repoMapDirSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    files: { type: "integer" },
    symbols: { type: "integer" },
    hubs: { type: "array", items: { type: "string" } }
  }
};
var repoMapHotspotSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    path: { type: "string" },
    inDegree: { type: "integer" }
  }
};
function buildRepoMapTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.repoMap,
    description: "Orient in the repo: directory clusters with their hub symbols and global hotspots, token-budgeted. Call this first when entering an unfamiliar repo, instead of listing/reading everything.",
    parameters: {
      maxDirs: { type: "integer", description: "Max directory entries, 4-64 (default 16)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          totals: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: { type: "integer" },
              symbols: { type: "integer" },
              edges: { type: "integer" },
              languages: { type: "array", items: { type: "string" } }
            }
          },
          dirs: { type: "array", items: repoMapDirSchema },
          hotspots: { type: "array", items: repoMapHotspotSchema },
          dropped: { type: "integer" },
          mapText: { type: "string" }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const mapText = typeof record.mapText === "string" && record.mapText !== "" ? record.mapText : "No map entries (empty graph?). Run graft build.";
        return [{ type: "text", text: mapText }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const maxDirs = clampInt(args.maxDirs, 4, 64, 16);
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => ["map", "--max-dirs", String(maxDirs), "--json", dir],
        (json) => {
          const payload = json;
          const totals = asRecord(payload.totals);
          const dirs = [];
          const rawDirs = Array.isArray(payload.dirs) ? payload.dirs : [];
          for (const rawDir of rawDirs) {
            const dir = rawDir;
            if (typeof dir !== "object" || dir === null || typeof dir.path !== "string") continue;
            const hubs = Array.isArray(dir.hubs) ? dir.hubs.filter((hub) => typeof hub === "object" && hub !== null && typeof hub.name === "string").map((hub) => hub.name) : [];
            dirs.push({
              path: dir.path,
              ...typeof dir.files === "number" ? { files: dir.files } : {},
              ...typeof dir.symbols === "number" ? { symbols: dir.symbols } : {},
              hubs
            });
          }
          const hotspots = [];
          const rawHotspots = Array.isArray(payload.hotspots) ? payload.hotspots : [];
          for (const hotspot of rawHotspots) {
            if (typeof hotspot !== "object" || hotspot === null || typeof hotspot.name !== "string") continue;
            hotspots.push({
              name: hotspot.name,
              ...typeof hotspot.path === "string" ? { path: hotspot.path } : {},
              ...typeof hotspot.inDegree === "number" ? { inDegree: hotspot.inDegree } : {}
            });
            if (hotspots.length >= 10) break;
          }
          const mapText = renderMap(payload, config.maxInjectBytes);
          return {
            ok: true,
            ...totals !== void 0 ? {
              totals: {
                ...typeof totals.files === "number" ? { files: totals.files } : {},
                ...typeof totals.symbols === "number" ? { symbols: totals.symbols } : {},
                ...typeof totals.edges === "number" ? { edges: totals.edges } : {},
                ...Array.isArray(totals.languages) ? { languages: stringArray(totals.languages, 8) } : {}
              }
            } : {},
            dirs,
            hotspots,
            ...typeof payload.dropped === "number" ? { dropped: payload.dropped } : {},
            mapText
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var driftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    added: { type: "array", items: { type: "string" } },
    removed: { type: "array", items: { type: "string" } },
    changed: { type: "array", items: { type: "string" } },
    stale: { type: "array", items: { type: "string" } }
  }
};
var DRIFT_CAP = 20;
function buildCheckFreshnessTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.checkFreshness,
    description: "Check whether the context graph is stale relative to the code (drift report). Call after larger edits, or when graph results look off; a stale graph needs `graft build`.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          fresh: { type: "boolean" },
          drift: driftSchema,
          pending: { type: "integer" },
          note: { type: "string" }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const drift = asRecord(record.drift);
        const payload = {
          context: {},
          graph: {
            ok: record.fresh === true,
            added: drift !== void 0 ? drift.added : [],
            removed: drift !== void 0 ? drift.removed : [],
            changed: drift !== void 0 ? drift.changed : [],
            stale: drift !== void 0 ? drift.stale : [],
            ...typeof record.pending === "number" ? { pending: record.pending } : {}
          }
        };
        const text = renderCheck(payload, DRIFT_CAP);
        return [{ type: "text", text: typeof record.note === "string" ? `${text}
${record.note}` : text }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => ["check", "--json", dir],
        (json, code) => {
          const payload = json;
          const graph = typeof payload.graph === "object" && payload.graph !== null ? payload.graph : void 0;
          if (graph === void 0) {
            return {
              ok: true,
              fresh: false,
              note: "Freshness check returned no graph report (no graph/ directory?)."
            };
          }
          const fresh = code === 0 && graph.ok === true;
          const drift = {
            added: stringArray(graph.added, DRIFT_CAP),
            removed: stringArray(graph.removed, DRIFT_CAP),
            changed: stringArray(graph.changed, DRIFT_CAP),
            stale: stringArray(graph.stale, DRIFT_CAP)
          };
          return {
            ok: true,
            fresh,
            drift,
            ...typeof graph.pending === "number" ? { pending: graph.pending } : {},
            ...typeof payload.context === "object" && payload.context !== null && payload.context.missing === true ? { note: "LLM context layer absent (expected without --deep)." } : {}
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
function buildGraphTools(config, deps) {
  return {
    findCode: buildFindCodeTool(config, deps),
    fileApi: buildFileApiTool(config, deps),
    traceCalls: buildTraceCallsTool(config, deps),
    findAll: buildFindAllTool(config, deps),
    repoMap: buildRepoMapTool(config, deps),
    checkFreshness: buildCheckFreshnessTool(config, deps)
  };
}

// src/index.ts
var SETTINGS_NAMESPACE = "context-graph";
var name = "dsh-context-graph";
var inject = ["tools", "systemPrompt"];
var Config = z.object({
  tools: z.boolean().default(true),
  injectSessionMap: z.boolean().default(true),
  injectPromptHits: z.boolean().default(true),
  injectBlastRadius: z.boolean().default(true),
  autoBuild: z.boolean().default(true),
  autoSync: z.boolean().default(true),
  maxInjectBytes: z.number().default(4096),
  promptMinChars: z.number().default(12),
  graphPath: z.string().default(""),
  timeoutMs: z.number().default(8e3),
  buildTimeoutMs: z.number().default(2e4),
  deep: z.boolean().default(false),
  editToolNames: z.array(z.string()).default(["write", "edit"]),
  // schemastery (v3.18.2) has no z.enum: a closed set of literals is a union of consts.
  injectMode: z.union([z.const("pointers"), z.const("sourced"), z.const("map-only")]).default("sourced"),
  nudgeOnBlindSearch: z.boolean().default(true),
  scopeFromLastEdit: z.boolean().default(false),
  metrics: z.boolean().default(true),
  guardWiringReads: z.boolean().default(false)
});
function normalizeConfig(raw) {
  const source = raw ?? {};
  const out = {
    tools: source.tools ?? true,
    injectSessionMap: source.injectSessionMap ?? true,
    injectPromptHits: source.injectPromptHits ?? true,
    injectBlastRadius: source.injectBlastRadius ?? true,
    autoBuild: source.autoBuild ?? true,
    autoSync: source.autoSync ?? true,
    maxInjectBytes: positiveInt(source.maxInjectBytes, 4096),
    promptMinChars: positiveInt(source.promptMinChars, 12),
    graphPath: typeof source.graphPath === "string" ? source.graphPath : "",
    timeoutMs: positiveInt(source.timeoutMs, 8e3),
    buildTimeoutMs: positiveInt(source.buildTimeoutMs, 2e4),
    deep: source.deep ?? false,
    editToolNames: Array.isArray(source.editToolNames) ? source.editToolNames.filter((entry) => typeof entry === "string" && entry !== "") : ["write", "edit"],
    injectMode: source.injectMode === "pointers" || source.injectMode === "sourced" || source.injectMode === "map-only" ? source.injectMode : "sourced",
    nudgeOnBlindSearch: source.nudgeOnBlindSearch ?? true,
    scopeFromLastEdit: source.scopeFromLastEdit ?? false,
    metrics: source.metrics ?? true,
    guardWiringReads: source.guardWiringReads ?? false
  };
  return out;
}
function positiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
function systemPromptSection(config) {
  return [
    "Repo context graph (dsh-context-graph) is available for this workspace.",
    `Native tools: ${TOOL_NAMES.repoMap} (orientation), ${TOOL_NAMES.findCode} (question/symbol/error to file:line), ${TOOL_NAMES.fileApi} (file signatures without bodies), ${TOOL_NAMES.traceCalls} (callers/callees, depth for blast radius), ${TOOL_NAMES.findAll} (ranked regex), ${TOOL_NAMES.checkFreshness} (drift).`,
    "Before broad grep/read, call graph_repo_map (unfamiliar repo) or graph_find_code (a concrete question).",
    "After larger edits, call graph_check_freshness; on drift run `graft build` (structural, no LLM).",
    "Never read graft/.graph/wiring.json or the full graft/INDEX.md \u2014 the tools are the interface.",
    `If a graph tool reports GRAPH_MISSING or GRAPH_CLI_MISSING, fall back to ordinary read/grep${config.tools ? "" : ""} and note the graph is unavailable.`
  ].join("\n");
}
function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  if (config.tools) {
    const toolsConfig = {
      graphPath: config.graphPath,
      timeoutMs: config.timeoutMs,
      maxInjectBytes: config.maxInjectBytes
    };
    const tools = buildGraphTools(toolsConfig, {
      runGraphJson,
      onNpxFallback: (note) => logger.warn(`dsh-context-graph: ${note}`)
    });
    ctx.tools.register(tools.findCode);
    ctx.tools.register(tools.fileApi);
    ctx.tools.register(tools.traceCalls);
    ctx.tools.register(tools.findAll);
    ctx.tools.register(tools.repoMap);
    ctx.tools.register(tools.checkFreshness);
  }
  ctx.systemPrompt.section({
    name: "plugin:dsh-context-graph",
    order: 1490,
    text: systemPromptSection(config)
  });
  const state = new SessionStateStore();
  const hooksConfig = {
    injectSessionMap: config.injectSessionMap,
    injectPromptHits: config.injectPromptHits,
    injectBlastRadius: config.injectBlastRadius,
    autoBuild: config.autoBuild,
    autoSync: config.autoSync,
    maxInjectBytes: config.maxInjectBytes,
    promptMinChars: config.promptMinChars,
    timeoutMs: config.timeoutMs,
    buildTimeoutMs: config.buildTimeoutMs,
    graphPath: config.graphPath,
    editToolNames: config.editToolNames,
    deep: config.deep,
    injectMode: config.injectMode,
    nudgeOnBlindSearch: config.nudgeOnBlindSearch,
    scopeFromLastEdit: config.scopeFromLastEdit,
    metrics: config.metrics,
    guardWiringReads: config.guardWiringReads
  };
  registerHooks(ctx, hooksConfig, {
    state,
    spawnBuild: spawnDetachedBuild,
    releaseLock: (repoRoot) => releaseBuildLock(repoRoot),
    pluginName: name,
    logger,
    recordMetric: config.metrics ? (sessionId, kind) => {
      recordToolCall(sessionId, kind);
    } : void 0
  }, runGraphJson);
  let settingsService;
  try {
    settingsService = ctx.settings;
  } catch {
    settingsService = void 0;
  }
  if (settingsService !== void 0 && typeof settingsService.installSection === "function") {
    try {
      settingsService.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: () => {
        },
        onChange: () => {
        }
      });
    } catch (error) {
      logger.warn(`dsh-context-graph: settings section skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const skill = installSkill({ logger });
  if (skill.ok && skill.path !== void 0) {
    logger.info(`dsh-context-graph: skill ready at ${skill.path}`);
  }
  logger.info(`dsh-context-graph: loaded (tools=${config.tools}, sessionMap=${config.injectSessionMap}, autoBuild=${config.autoBuild}, promptHits=${config.injectPromptHits}/${config.injectMode}, blast=${config.injectBlastRadius}, autoSync=${config.autoSync}, nudge=${config.nudgeOnBlindSearch}, scope=${config.scopeFromLastEdit}, metrics=${config.metrics}, guardWiring=${config.guardWiringReads})`);
}
export {
  Config,
  SessionStateStore,
  TOOL_NAMES,
  apply,
  buildGraphTools,
  inject,
  name,
  normalizeConfig
};
