// src/index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  return new Promise((resolve5, reject) => {
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
        resolve5({ stdout, stderr, code: code ?? 1, viaNpx: resolved.viaNpx });
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
  const open2 = text.charAt(start);
  const close = open2 === "{" ? "}" : "]";
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
    else if (ch === open2) depth += 1;
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
    const exited = new Promise((resolve5) => {
      child.on("close", () => {
        clearTimeout(timer);
        resolve5();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve5();
      });
    });
    child.unref();
    return { pid: child.pid, exited };
  } catch (error) {
    return { error: `graft build spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/index.js
import { stat as statcb } from "fs";
import { stat as stat3, readdir as readdir2 } from "fs/promises";
import { EventEmitter } from "events";
import * as sysPath2 from "path";

// node_modules/.pnpm/readdirp@4.1.2/node_modules/readdirp/esm/index.js
import { stat, lstat, readdir, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve as presolve, relative as prelative, join as pjoin, sep as psep } from "node:path";
var EntryTypes = {
  FILE_TYPE: "files",
  DIR_TYPE: "directories",
  FILE_DIR_TYPE: "files_directories",
  EVERYTHING_TYPE: "all"
};
var defaultOptions = {
  root: ".",
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false,
  highWaterMark: 4096
};
Object.freeze(defaultOptions);
var RECURSIVE_ERROR_CODE = "READDIRP_RECURSIVE_ERROR";
var NORMAL_FLOW_ERRORS = /* @__PURE__ */ new Set(["ENOENT", "EPERM", "EACCES", "ELOOP", RECURSIVE_ERROR_CODE]);
var ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
];
var DIR_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
]);
var FILE_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]);
var isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code);
var wantBigintFsStats = process.platform === "win32";
var emptyFn = (_entryInfo) => true;
var normalizeFilter = (filter) => {
  if (filter === void 0)
    return emptyFn;
  if (typeof filter === "function")
    return filter;
  if (typeof filter === "string") {
    const fl = filter.trim();
    return (entry) => entry.basename === fl;
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim());
    return (entry) => trItems.some((f) => entry.basename === f);
  }
  return emptyFn;
};
var ReaddirpStream = class extends Readable {
  constructor(options = {}) {
    super({
      objectMode: true,
      autoDestroy: true,
      highWaterMark: options.highWaterMark
    });
    const opts = { ...defaultOptions, ...options };
    const { root, type } = opts;
    this._fileFilter = normalizeFilter(opts.fileFilter);
    this._directoryFilter = normalizeFilter(opts.directoryFilter);
    const statMethod = opts.lstat ? lstat : stat;
    if (wantBigintFsStats) {
      this._stat = (path) => statMethod(path, { bigint: true });
    } else {
      this._stat = statMethod;
    }
    this._maxDepth = opts.depth ?? defaultOptions.depth;
    this._wantsDir = type ? DIR_TYPES.has(type) : false;
    this._wantsFile = type ? FILE_TYPES.has(type) : false;
    this._wantsEverything = type === EntryTypes.EVERYTHING_TYPE;
    this._root = presolve(root);
    this._isDirent = !opts.alwaysStat;
    this._statsProp = this._isDirent ? "dirent" : "stats";
    this._rdOptions = { encoding: "utf8", withFileTypes: this._isDirent };
    this.parents = [this._exploreDir(root, 1)];
    this.reading = false;
    this.parent = void 0;
  }
  async _read(batch) {
    if (this.reading)
      return;
    this.reading = true;
    try {
      while (!this.destroyed && batch > 0) {
        const par = this.parent;
        const fil = par && par.files;
        if (fil && fil.length > 0) {
          const { path, depth } = par;
          const slice = fil.splice(0, batch).map((dirent) => this._formatEntry(dirent, path));
          const awaited = await Promise.all(slice);
          for (const entry of awaited) {
            if (!entry)
              continue;
            if (this.destroyed)
              return;
            const entryType = await this._getEntryType(entry);
            if (entryType === "directory" && this._directoryFilter(entry)) {
              if (depth <= this._maxDepth) {
                this.parents.push(this._exploreDir(entry.fullPath, depth + 1));
              }
              if (this._wantsDir) {
                this.push(entry);
                batch--;
              }
            } else if ((entryType === "file" || this._includeAsFile(entry)) && this._fileFilter(entry)) {
              if (this._wantsFile) {
                this.push(entry);
                batch--;
              }
            }
          }
        } else {
          const parent = this.parents.pop();
          if (!parent) {
            this.push(null);
            break;
          }
          this.parent = await parent;
          if (this.destroyed)
            return;
        }
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this.reading = false;
    }
  }
  async _exploreDir(path, depth) {
    let files;
    try {
      files = await readdir(path, this._rdOptions);
    } catch (error) {
      this._onError(error);
    }
    return { files, depth, path };
  }
  async _formatEntry(dirent, path) {
    let entry;
    const basename3 = this._isDirent ? dirent.name : dirent;
    try {
      const fullPath = presolve(pjoin(path, basename3));
      entry = { path: prelative(this._root, fullPath), fullPath, basename: basename3 };
      entry[this._statsProp] = this._isDirent ? dirent : await this._stat(fullPath);
    } catch (err) {
      this._onError(err);
      return;
    }
    return entry;
  }
  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit("warn", err);
    } else {
      this.destroy(err);
    }
  }
  async _getEntryType(entry) {
    if (!entry && this._statsProp in entry) {
      return "";
    }
    const stats = entry[this._statsProp];
    if (stats.isFile())
      return "file";
    if (stats.isDirectory())
      return "directory";
    if (stats && stats.isSymbolicLink()) {
      const full = entry.fullPath;
      try {
        const entryRealPath = await realpath(full);
        const entryRealPathStats = await lstat(entryRealPath);
        if (entryRealPathStats.isFile()) {
          return "file";
        }
        if (entryRealPathStats.isDirectory()) {
          const len = entryRealPath.length;
          if (full.startsWith(entryRealPath) && full.substr(len, 1) === psep) {
            const recursiveError = new Error(`Circular symlink detected: "${full}" points to "${entryRealPath}"`);
            recursiveError.code = RECURSIVE_ERROR_CODE;
            return this._onError(recursiveError);
          }
          return "directory";
        }
      } catch (error) {
        this._onError(error);
        return "";
      }
    }
  }
  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp];
    return stats && this._wantsEverything && !stats.isDirectory();
  }
};
function readdirp(root, options = {}) {
  let type = options.entryType || options.type;
  if (type === "both")
    type = EntryTypes.FILE_DIR_TYPE;
  if (type)
    options.type = type;
  if (!root) {
    throw new Error("readdirp: root argument is required. Usage: readdirp(root, options)");
  } else if (typeof root !== "string") {
    throw new TypeError("readdirp: root argument must be a string. Usage: readdirp(root, options)");
  } else if (type && !ALL_TYPES.includes(type)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(", ")}`);
  }
  options.root = root;
  return new ReaddirpStream(options);
}

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/handler.js
import { watchFile, unwatchFile, watch as fs_watch } from "fs";
import { open, stat as stat2, lstat as lstat2, realpath as fsrealpath } from "fs/promises";
import * as sysPath from "path";
import { type as osType } from "os";
var STR_DATA = "data";
var STR_END = "end";
var STR_CLOSE = "close";
var EMPTY_FN = () => {
};
var pl = process.platform;
var isWindows = pl === "win32";
var isMacos = pl === "darwin";
var isLinux = pl === "linux";
var isFreeBSD = pl === "freebsd";
var isIBMi = osType() === "OS400";
var EVENTS = {
  ALL: "all",
  READY: "ready",
  ADD: "add",
  CHANGE: "change",
  ADD_DIR: "addDir",
  UNLINK: "unlink",
  UNLINK_DIR: "unlinkDir",
  RAW: "raw",
  ERROR: "error"
};
var EV = EVENTS;
var THROTTLE_MODE_WATCH = "watch";
var statMethods = { lstat: lstat2, stat: stat2 };
var KEY_LISTENERS = "listeners";
var KEY_ERR = "errHandlers";
var KEY_RAW = "rawEmitters";
var HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];
var binaryExtensions = /* @__PURE__ */ new Set([
  "3dm",
  "3ds",
  "3g2",
  "3gp",
  "7z",
  "a",
  "aac",
  "adp",
  "afdesign",
  "afphoto",
  "afpub",
  "ai",
  "aif",
  "aiff",
  "alz",
  "ape",
  "apk",
  "appimage",
  "ar",
  "arj",
  "asf",
  "au",
  "avi",
  "bak",
  "baml",
  "bh",
  "bin",
  "bk",
  "bmp",
  "btif",
  "bz2",
  "bzip2",
  "cab",
  "caf",
  "cgm",
  "class",
  "cmx",
  "cpio",
  "cr2",
  "cur",
  "dat",
  "dcm",
  "deb",
  "dex",
  "djvu",
  "dll",
  "dmg",
  "dng",
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dra",
  "DS_Store",
  "dsk",
  "dts",
  "dtshd",
  "dvb",
  "dwg",
  "dxf",
  "ecelp4800",
  "ecelp7470",
  "ecelp9600",
  "egg",
  "eol",
  "eot",
  "epub",
  "exe",
  "f4v",
  "fbs",
  "fh",
  "fla",
  "flac",
  "flatpak",
  "fli",
  "flv",
  "fpx",
  "fst",
  "fvt",
  "g3",
  "gh",
  "gif",
  "graffle",
  "gz",
  "gzip",
  "h261",
  "h263",
  "h264",
  "icns",
  "ico",
  "ief",
  "img",
  "ipa",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "jpgv",
  "jpm",
  "jxr",
  "key",
  "ktx",
  "lha",
  "lib",
  "lvp",
  "lz",
  "lzh",
  "lzma",
  "lzo",
  "m3u",
  "m4a",
  "m4v",
  "mar",
  "mdi",
  "mht",
  "mid",
  "midi",
  "mj2",
  "mka",
  "mkv",
  "mmr",
  "mng",
  "mobi",
  "mov",
  "movie",
  "mp3",
  "mp4",
  "mp4a",
  "mpeg",
  "mpg",
  "mpga",
  "mxu",
  "nef",
  "npx",
  "numbers",
  "nupkg",
  "o",
  "odp",
  "ods",
  "odt",
  "oga",
  "ogg",
  "ogv",
  "otf",
  "ott",
  "pages",
  "pbm",
  "pcx",
  "pdb",
  "pdf",
  "pea",
  "pgm",
  "pic",
  "png",
  "pnm",
  "pot",
  "potm",
  "potx",
  "ppa",
  "ppam",
  "ppm",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
  "psd",
  "pya",
  "pyc",
  "pyo",
  "pyv",
  "qt",
  "rar",
  "ras",
  "raw",
  "resources",
  "rgb",
  "rip",
  "rlc",
  "rmf",
  "rmvb",
  "rpm",
  "rtf",
  "rz",
  "s3m",
  "s7z",
  "scpt",
  "sgi",
  "shar",
  "snap",
  "sil",
  "sketch",
  "slk",
  "smv",
  "snk",
  "so",
  "stl",
  "suo",
  "sub",
  "swf",
  "tar",
  "tbz",
  "tbz2",
  "tga",
  "tgz",
  "thmx",
  "tif",
  "tiff",
  "tlz",
  "ttc",
  "ttf",
  "txz",
  "udf",
  "uvh",
  "uvi",
  "uvm",
  "uvp",
  "uvs",
  "uvu",
  "viv",
  "vob",
  "war",
  "wav",
  "wax",
  "wbmp",
  "wdp",
  "weba",
  "webm",
  "webp",
  "whl",
  "wim",
  "wm",
  "wma",
  "wmv",
  "wmx",
  "woff",
  "woff2",
  "wrm",
  "wvx",
  "xbm",
  "xif",
  "xla",
  "xlam",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "xm",
  "xmind",
  "xpi",
  "xpm",
  "xwd",
  "xz",
  "z",
  "zip",
  "zipx"
]);
var isBinaryPath = (filePath) => binaryExtensions.has(sysPath.extname(filePath).slice(1).toLowerCase());
var foreach = (val, fn) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};
var addAndConvert = (main, prop, item) => {
  let container = main[prop];
  if (!(container instanceof Set)) {
    main[prop] = container = /* @__PURE__ */ new Set([container]);
  }
  container.add(item);
};
var clearItem = (cont) => (key) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};
var delFromSet = (main, prop, item) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};
var isEmptySet = (val) => val instanceof Set ? val.size === 0 : !val;
var FsWatchInstances = /* @__PURE__ */ new Map();
function createFsWatchInstance(path, options, listener, errHandler, emitRaw) {
  const handleEvent = (rawEvent, evPath) => {
    listener(path);
    emitRaw(rawEvent, evPath, { watchedPath: path });
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sysPath.resolve(path, evPath), KEY_LISTENERS, sysPath.join(path, evPath));
    }
  };
  try {
    return fs_watch(path, {
      persistent: options.persistent
    }, handleEvent);
  } catch (error) {
    errHandler(error);
    return void 0;
  }
}
var fsWatchBroadcast = (fullPath, listenerType, val1, val2, val3) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont)
    return;
  foreach(cont[listenerType], (listener) => {
    listener(val1, val2, val3);
  });
};
var setFsWatchListener = (path, fullPath, options, handlers) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);
  let watcher;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
    if (!watcher)
      return;
    return watcher.close.bind(watcher);
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_ERR, errHandler);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    watcher = createFsWatchInstance(
      path,
      options,
      fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS),
      errHandler,
      // no need to use broadcast here
      fsWatchBroadcast.bind(null, fullPath, KEY_RAW)
    );
    if (!watcher)
      return;
    watcher.on(EV.ERROR, async (error) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont)
        cont.watcherUnusable = true;
      if (isWindows && error.code === "EPERM") {
        try {
          const fd = await open(path, "r");
          await fd.close();
          broadcastErr(error);
        } catch (err) {
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      rawEmitters: rawEmitter,
      watcher
    };
    FsWatchInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_ERR, errHandler);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      cont.watcher.close();
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont));
      cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
var FsWatchFileInstances = /* @__PURE__ */ new Map();
var setFsWatchFileListener = (path, fullPath, options, handlers) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);
  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent || copts.interval > options.interval)) {
    unwatchFile(fullPath);
    cont = void 0;
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    cont = {
      listeners: listener,
      rawEmitters: rawEmitter,
      options,
      watcher: watchFile(fullPath, options, (curr, prev) => {
        foreach(cont.rawEmitters, (rawEmitter2) => {
          rawEmitter2(EV.CHANGE, fullPath, { curr, prev });
        });
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener2) => listener2(path, curr));
        }
      })
    };
    FsWatchFileInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      unwatchFile(fullPath);
      cont.options = cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
var NodeFsHandler = class {
  constructor(fsW) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error);
  }
  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  _watchWithNodeFs(path, listener) {
    const opts = this.fsw.options;
    const directory = sysPath.dirname(path);
    const basename3 = sysPath.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename3);
    const absolutePath = sysPath.resolve(path);
    const options = {
      persistent: opts.persistent
    };
    if (!listener)
      listener = EMPTY_FN;
    let closer;
    if (opts.usePolling) {
      const enableBin = opts.interval !== opts.binaryInterval;
      options.interval = enableBin && isBinaryPath(basename3) ? opts.binaryInterval : opts.interval;
      closer = setFsWatchFileListener(path, absolutePath, options, {
        listener,
        rawEmitter: this.fsw._emitRaw
      });
    } else {
      closer = setFsWatchListener(path, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
        rawEmitter: this.fsw._emitRaw
      });
    }
    return closer;
  }
  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  _handleFile(file, stats, initialAdd) {
    if (this.fsw.closed) {
      return;
    }
    const dirname4 = sysPath.dirname(file);
    const basename3 = sysPath.basename(file);
    const parent = this.fsw._getWatchedDir(dirname4);
    let prevStats = stats;
    if (parent.has(basename3))
      return;
    const listener = async (path, newStats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5))
        return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats2 = await stat2(file);
          if (this.fsw.closed)
            return;
          const at = newStats2.atimeMs;
          const mt = newStats2.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats2);
          }
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats2.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats2;
            const closer2 = this._watchWithNodeFs(file, listener);
            if (closer2)
              this.fsw._addPathCloser(path, closer2);
          } else {
            prevStats = newStats2;
          }
        } catch (error) {
          this.fsw._remove(dirname4, basename3);
        }
      } else if (parent.has(basename3)) {
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    const closer = this._watchWithNodeFs(file, listener);
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0))
        return;
      this.fsw._emit(EV.ADD, file, stats);
    }
    return closer;
  }
  /**
   * Handle symlinks encountered while reading a dir.
   * @param entry returned by readdirp
   * @param directory path of dir being read
   * @param path of this item
   * @param item basename of this item
   * @returns true if no more processing is needed for this entry.
   */
  async _handleSymlink(entry, directory, path, item) {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);
    if (!this.fsw.options.followSymlinks) {
      this.fsw._incrReadyCount();
      let linkPath;
      try {
        linkPath = await fsrealpath(path);
      } catch (e) {
        this.fsw._emitReady();
        return true;
      }
      if (this.fsw.closed)
        return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }
    this.fsw._symlinkPaths.set(full, true);
  }
  _handleRead(directory, initialAdd, wh, target, dir, depth, throttler) {
    directory = sysPath.join(directory, "");
    throttler = this.fsw._throttle("readdir", directory, 1e3);
    if (!throttler)
      return;
    const previous = this.fsw._getWatchedDir(wh.path);
    const current = /* @__PURE__ */ new Set();
    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => wh.filterDir(entry)
    });
    if (!stream)
      return;
    stream.on(STR_DATA, async (entry) => {
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      const item = entry.path;
      let path = sysPath.join(directory, item);
      current.add(item);
      if (entry.stats.isSymbolicLink() && await this._handleSymlink(entry, directory, path, item)) {
        return;
      }
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      if (item === target || !target && !previous.has(item)) {
        this.fsw._incrReadyCount();
        path = sysPath.join(dir, sysPath.relative(dir, path));
        this._addToNodeFs(path, initialAdd, wh, depth + 1);
      }
    }).on(EV.ERROR, this._boundHandleError);
    return new Promise((resolve5, reject) => {
      if (!stream)
        return reject();
      stream.once(STR_END, () => {
        if (this.fsw.closed) {
          stream = void 0;
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;
        resolve5(void 0);
        previous.getChildren().filter((item) => {
          return item !== directory && !current.has(item);
        }).forEach((item) => {
          this.fsw._remove(directory, item);
        });
        stream = void 0;
        if (wasThrottled)
          this._handleRead(directory, false, wh, target, dir, depth, throttler);
      });
    });
  }
  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @param realpath
   * @returns closer for the watcher instance.
   */
  async _handleDir(dir, stats, initialAdd, depth, target, wh, realpath2) {
    const parentDir = this.fsw._getWatchedDir(sysPath.dirname(dir));
    const tracked = parentDir.has(sysPath.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }
    parentDir.add(sysPath.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler;
    let closer;
    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath2)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed)
          return;
      }
      closer = this._watchWithNodeFs(dir, (dirPath, stats2) => {
        if (stats2 && stats2.mtimeMs === 0)
          return;
        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }
  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to _handleFile / _handleDir after checks.
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async _addToNodeFs(path, initialAdd, priorWh, depth, target) {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path) || this.fsw.closed) {
      ready();
      return false;
    }
    const wh = this.fsw._getWatchHelpers(path);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed)
        return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }
      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sysPath.resolve(path);
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed)
          return;
        closer = await this._handleDir(wh.watchPath, stats, initialAdd, depth, target, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (absPath !== targetPath && targetPath !== void 0) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed)
          return;
        const parent = sysPath.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (targetPath !== void 0) {
          this.fsw._symlinkPaths.set(sysPath.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();
      if (closer)
        this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error)) {
        ready();
        return path;
      }
    }
  }
};

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/index.js
var SLASH = "/";
var SLASH_SLASH = "//";
var ONE_DOT = ".";
var TWO_DOTS = "..";
var STRING_TYPE = "string";
var BACK_SLASH_RE = /\\/g;
var DOUBLE_SLASH_RE = /\/\//;
var DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
var REPLACER_RE = /^\.[/\\]/;
function arrify(item) {
  return Array.isArray(item) ? item : [item];
}
var isMatcherObject = (matcher) => typeof matcher === "object" && matcher !== null && !(matcher instanceof RegExp);
function createPattern(matcher) {
  if (typeof matcher === "function")
    return matcher;
  if (typeof matcher === "string")
    return (string) => matcher === string;
  if (matcher instanceof RegExp)
    return (string) => matcher.test(string);
  if (typeof matcher === "object" && matcher !== null) {
    return (string) => {
      if (matcher.path === string)
        return true;
      if (matcher.recursive) {
        const relative4 = sysPath2.relative(matcher.path, string);
        if (!relative4) {
          return false;
        }
        return !relative4.startsWith("..") && !sysPath2.isAbsolute(relative4);
      }
      return false;
    };
  }
  return () => false;
}
function normalizePath(path) {
  if (typeof path !== "string")
    throw new Error("string expected");
  path = sysPath2.normalize(path);
  path = path.replace(/\\/g, "/");
  let prepend = false;
  if (path.startsWith("//"))
    prepend = true;
  const DOUBLE_SLASH_RE2 = /\/\//;
  while (path.match(DOUBLE_SLASH_RE2))
    path = path.replace(DOUBLE_SLASH_RE2, "/");
  if (prepend)
    path = "/" + path;
  return path;
}
function matchPatterns(patterns, testString, stats) {
  const path = normalizePath(testString);
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }
  return false;
}
function anymatch(matchers, testString) {
  if (matchers == null) {
    throw new TypeError("anymatch: specify first argument");
  }
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));
  if (testString == null) {
    return (testString2, stats) => {
      return matchPatterns(patterns, testString2, stats);
    };
  }
  return matchPatterns(patterns, testString);
}
var unifyPaths = (paths_) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};
var toUnix = (string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  while (str.match(DOUBLE_SLASH_RE)) {
    str = str.replace(DOUBLE_SLASH_RE, SLASH);
  }
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};
var normalizePathToUnix = (path) => toUnix(sysPath2.normalize(toUnix(path)));
var normalizeIgnored = (cwd = "") => (path) => {
  if (typeof path === "string") {
    return normalizePathToUnix(sysPath2.isAbsolute(path) ? path : sysPath2.join(cwd, path));
  } else {
    return path;
  }
};
var getAbsolutePath = (path, cwd) => {
  if (sysPath2.isAbsolute(path)) {
    return path;
  }
  return sysPath2.join(cwd, path);
};
var EMPTY_SET = Object.freeze(/* @__PURE__ */ new Set());
var DirEntry = class {
  constructor(dir, removeWatcher) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = /* @__PURE__ */ new Set();
  }
  add(item) {
    const { items } = this;
    if (!items)
      return;
    if (item !== ONE_DOT && item !== TWO_DOTS)
      items.add(item);
  }
  async remove(item) {
    const { items } = this;
    if (!items)
      return;
    items.delete(item);
    if (items.size > 0)
      return;
    const dir = this.path;
    try {
      await readdir2(dir);
    } catch (err) {
      if (this._removeWatcher) {
        this._removeWatcher(sysPath2.dirname(dir), sysPath2.basename(dir));
      }
    }
  }
  has(item) {
    const { items } = this;
    if (!items)
      return;
    return items.has(item);
  }
  getChildren() {
    const { items } = this;
    if (!items)
      return [];
    return [...items.values()];
  }
  dispose() {
    this.items.clear();
    this.path = "";
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
};
var STAT_METHOD_F = "stat";
var STAT_METHOD_L = "lstat";
var WatchHelper = class {
  constructor(path, follow, fsw) {
    this.fsw = fsw;
    const watchPath = path;
    this.path = path = path.replace(REPLACER_RE, "");
    this.watchPath = watchPath;
    this.fullWatchPath = sysPath2.resolve(watchPath);
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1)
        parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }
  entryPath(entry) {
    return sysPath2.join(this.watchPath, sysPath2.relative(this.watchPath, entry.fullPath));
  }
  filterPath(entry) {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink())
      return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats);
  }
  filterDir(entry) {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
};
var FSWatcher = class extends EventEmitter {
  // Not indenting methods for history sake; for now.
  constructor(_opts = {}) {
    super();
    this.closed = false;
    this._closers = /* @__PURE__ */ new Map();
    this._ignoredPaths = /* @__PURE__ */ new Set();
    this._throttled = /* @__PURE__ */ new Map();
    this._streams = /* @__PURE__ */ new Set();
    this._symlinkPaths = /* @__PURE__ */ new Map();
    this._watched = /* @__PURE__ */ new Map();
    this._pendingWrites = /* @__PURE__ */ new Map();
    this._pendingUnlinks = /* @__PURE__ */ new Map();
    this._readyCount = 0;
    this._readyEmitted = false;
    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2e3, pollInterval: 100 };
    const opts = {
      // Defaults
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: false,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: true,
      usePolling: false,
      // useAsync: false,
      atomic: true,
      // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish: awf === true ? DEF_AWF : typeof awf === "object" ? { ...DEF_AWF, ...awf } : false
    };
    if (isIBMi)
      opts.usePolling = true;
    if (opts.atomic === void 0)
      opts.atomic = !opts.usePolling;
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== void 0) {
      const envLower = envPoll.toLowerCase();
      if (envLower === "false" || envLower === "0")
        opts.usePolling = false;
      else if (envLower === "true" || envLower === "1")
        opts.usePolling = true;
      else
        opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval)
      opts.interval = Number.parseInt(envInterval, 10);
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        process.nextTick(() => this.emit(EVENTS.READY));
      }
    };
    this._emitRaw = (...args) => this.emit(EVENTS.RAW, ...args);
    this._boundRemove = this._remove.bind(this);
    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    Object.freeze(opts);
  }
  _addIgnoredPath(matcher) {
    if (isMatcherObject(matcher)) {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher.path && ignored.recursive === matcher.recursive) {
          return;
        }
      }
    }
    this._ignoredPaths.add(matcher);
  }
  _removeIgnoredPath(matcher) {
    this._ignoredPaths.delete(matcher);
    if (typeof matcher === "string") {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this._ignoredPaths.delete(ignored);
        }
      }
    }
  }
  // Public methods
  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list. Other arguments are unused
   */
  add(paths_, _origAdd, _internal) {
    const { cwd } = this.options;
    this.closed = false;
    this._closePromise = void 0;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path) => {
        const absPath = getAbsolutePath(path, cwd);
        return absPath;
      });
    }
    paths.forEach((path) => {
      this._removeIgnoredPath(path);
    });
    this._userIgnored = void 0;
    if (!this._readyCount)
      this._readyCount = 0;
    this._readyCount += paths.length;
    Promise.all(paths.map(async (path) => {
      const res = await this._nodeFsHandler._addToNodeFs(path, !_internal, void 0, 0, _origAdd);
      if (res)
        this._emitReady();
      return res;
    })).then((results) => {
      if (this.closed)
        return;
      results.forEach((item) => {
        if (item)
          this.add(sysPath2.dirname(item), sysPath2.basename(_origAdd || item));
      });
    });
    return this;
  }
  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_) {
    if (this.closed)
      return this;
    const paths = unifyPaths(paths_);
    const { cwd } = this.options;
    paths.forEach((path) => {
      if (!sysPath2.isAbsolute(path) && !this._closers.has(path)) {
        if (cwd)
          path = sysPath2.join(cwd, path);
        path = sysPath2.resolve(path);
      }
      this._closePath(path);
      this._addIgnoredPath(path);
      if (this._watched.has(path)) {
        this._addIgnoredPath({
          path,
          recursive: true
        });
      }
      this._userIgnored = void 0;
    });
    return this;
  }
  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close() {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;
    this.removeAllListeners();
    const closers = [];
    this._closers.forEach((closerList) => closerList.forEach((closer) => {
      const promise = closer();
      if (promise instanceof Promise)
        closers.push(promise);
    }));
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = void 0;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());
    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();
    this._closePromise = closers.length ? Promise.all(closers).then(() => void 0) : Promise.resolve();
    return this._closePromise;
  }
  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched() {
    const watchList = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sysPath2.relative(this.options.cwd, dir) : dir;
      const index = key || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }
  emitWithAll(event, args) {
    this.emit(event, ...args);
    if (event !== EVENTS.ERROR)
      this.emit(EVENTS.ALL, event, ...args);
  }
  // Common helpers
  // --------------
  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event, path, stats) {
    if (this.closed)
      return;
    const opts = this.options;
    if (isWindows)
      path = sysPath2.normalize(path);
    if (opts.cwd)
      path = sysPath2.relative(opts.cwd, path);
    const args = [path];
    if (stats != null)
      args.push(stats);
    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = /* @__PURE__ */ new Date();
      return this;
    }
    if (opts.atomic) {
      if (event === EVENTS.UNLINK) {
        this._pendingUnlinks.set(path, [event, ...args]);
        setTimeout(() => {
          this._pendingUnlinks.forEach((entry, path2) => {
            this.emit(...entry);
            this.emit(EVENTS.ALL, ...entry);
            this._pendingUnlinks.delete(path2);
          });
        }, typeof opts.atomic === "number" ? opts.atomic : 100);
        return this;
      }
      if (event === EVENTS.ADD && this._pendingUnlinks.has(path)) {
        event = EVENTS.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }
    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this._readyEmitted) {
      const awfEmit = (err, stats2) => {
        if (err) {
          event = EVENTS.ERROR;
          args[0] = err;
          this.emitWithAll(event, args);
        } else if (stats2) {
          if (args.length > 1) {
            args[1] = stats2;
          } else {
            args.push(stats2);
          }
          this.emitWithAll(event, args);
        }
      };
      this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
      return this;
    }
    if (event === EVENTS.CHANGE) {
      const isThrottled = !this._throttle(EVENTS.CHANGE, path, 50);
      if (isThrottled)
        return this;
    }
    if (opts.alwaysStat && stats === void 0 && (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)) {
      const fullPath = opts.cwd ? sysPath2.join(opts.cwd, path) : path;
      let stats2;
      try {
        stats2 = await stat3(fullPath);
      } catch (err) {
      }
      if (!stats2 || this.closed)
        return;
      args.push(stats2);
    }
    this.emitWithAll(event, args);
    return this;
  }
  /**
   * Common handler for errors
   * @returns The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error) {
    const code = error && error.code;
    if (error && code !== "ENOENT" && code !== "ENOTDIR" && (!this.options.ignorePermissionErrors || code !== "EPERM" && code !== "EACCES")) {
      this.emit(EVENTS.ERROR, error);
    }
    return error || this.closed;
  }
  /**
   * Helper utility for throttling
   * @param actionType type being throttled
   * @param path being acted upon
   * @param timeout duration of time to suppress duplicate actions
   * @returns tracking object or false if action should be suppressed
   */
  _throttle(actionType, path, timeout) {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, /* @__PURE__ */ new Map());
    }
    const action = this._throttled.get(actionType);
    if (!action)
      throw new Error("invalid throttle");
    const actionPath = action.get(path);
    if (actionPath) {
      actionPath.count++;
      return false;
    }
    let timeoutObject;
    const clear = () => {
      const item = action.get(path);
      const count = item ? item.count : 0;
      action.delete(path);
      clearTimeout(timeoutObject);
      if (item)
        clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path, thr);
    return thr;
  }
  _incrReadyCount() {
    return this._readyCount++;
  }
  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   * @param path being acted upon
   * @param threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
   * @param event
   * @param awfEmit Callback to be called when ready for event to be emitted.
   */
  _awaitWriteFinish(path, threshold, event, awfEmit) {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== "object")
      return;
    const pollInterval = awf.pollInterval;
    let timeoutHandler;
    let fullPath = path;
    if (this.options.cwd && !sysPath2.isAbsolute(path)) {
      fullPath = sysPath2.join(this.options.cwd, path);
    }
    const now = /* @__PURE__ */ new Date();
    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat) {
      statcb(fullPath, (err, curStat) => {
        if (err || !writes.has(path)) {
          if (err && err.code !== "ENOENT")
            awfEmit(err);
          return;
        }
        const now2 = Number(/* @__PURE__ */ new Date());
        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path).lastChange = now2;
        }
        const pw = writes.get(path);
        const df = now2 - pw.lastChange;
        if (df >= threshold) {
          writes.delete(path);
          awfEmit(void 0, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }
    if (!writes.has(path)) {
      writes.set(path, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        }
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }
  /**
   * Determines whether user has asked to ignore this path.
   */
  _isIgnored(path, stats) {
    if (this.options.atomic && DOT_RE.test(path))
      return true;
    if (!this._userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;
      const ignored = (ign || []).map(normalizeIgnored(cwd));
      const ignoredPaths = [...this._ignoredPaths];
      const list = [...ignoredPaths.map(normalizeIgnored(cwd)), ...ignored];
      this._userIgnored = anymatch(list, void 0);
    }
    return this._userIgnored(path, stats);
  }
  _isntIgnored(path, stat4) {
    return !this._isIgnored(path, stat4);
  }
  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  _getWatchHelpers(path) {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }
  // Directory helpers
  // -----------------
  /**
   * Provides directory tracking objects
   * @param directory path of the directory
   */
  _getWatchedDir(directory) {
    const dir = sysPath2.resolve(directory);
    if (!this._watched.has(dir))
      this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir);
  }
  // File helpers
  // ------------
  /**
   * Check for read permissions: https://stackoverflow.com/a/11781404/1358405
   */
  _hasReadPermissions(stats) {
    if (this.options.ignorePermissionErrors)
      return true;
    return Boolean(Number(stats.mode) & 256);
  }
  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  _remove(directory, item, isDirectory) {
    const path = sysPath2.join(directory, item);
    const fullPath = sysPath2.resolve(path);
    isDirectory = isDirectory != null ? isDirectory : this._watched.has(path) || this._watched.has(fullPath);
    if (!this._throttle("remove", path, 100))
      return;
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }
    const wp = this._getWatchedDir(path);
    const nestedDirectoryChildren = wp.getChildren();
    nestedDirectoryChildren.forEach((nested) => this._remove(path, nested));
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }
    let relPath = path;
    if (this.options.cwd)
      relPath = sysPath2.relative(this.options.cwd, path);
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath).cancelWait();
      if (event === EVENTS.ADD)
        return;
    }
    this._watched.delete(path);
    this._watched.delete(fullPath);
    const eventName = isDirectory ? EVENTS.UNLINK_DIR : EVENTS.UNLINK;
    if (wasTracked && !this._isIgnored(path))
      this._emit(eventName, path);
    this._closePath(path);
  }
  /**
   * Closes all watchers for a path
   */
  _closePath(path) {
    this._closeFile(path);
    const dir = sysPath2.dirname(path);
    this._getWatchedDir(dir).remove(sysPath2.basename(path));
  }
  /**
   * Closes only file-specific watchers
   */
  _closeFile(path) {
    const closers = this._closers.get(path);
    if (!closers)
      return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }
  _addPathCloser(path, closer) {
    if (!closer)
      return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }
  _readdirp(root, opts) {
    if (this.closed)
      return;
    const options = { type: EVENTS.ALL, alwaysStat: true, lstat: true, ...opts, depth: 0 };
    let stream = readdirp(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = void 0;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = void 0;
      }
    });
    return stream;
  }
};
function watch(paths, options = {}) {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}

// src/watcher.ts
import { sep } from "node:path";
var IGNORED = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)graft(\/|$)/,
  /(^|\/)\.[^/]+(\/|$)/
  // dotfiles and dot-directories (.DS_Store, .env, .github, …)
];
function isIgnored(relPath) {
  return IGNORED.some((pattern) => pattern.test(relPath));
}
function startChokidarWatcher(repoRoot, onChange) {
  return new Promise((resolve5) => {
    let watcher;
    try {
      watcher = watch(repoRoot, {
        ignoreInitial: true,
        ignored: (path) => {
          const rel = path.startsWith(`${repoRoot}${sep}`) ? path.slice(repoRoot.length + 1) : path;
          return isIgnored(rel);
        }
      });
    } catch {
      resolve5({ close: () => void 0 });
      return;
    }
    watcher.on("all", (event, path) => {
      if (event !== "change" && event !== "add" && event !== "unlink") return;
      const rel = path.startsWith(`${repoRoot}${sep}`) ? path.slice(repoRoot.length + 1) : path;
      try {
        onChange(rel);
      } catch {
      }
    });
    resolve5({ close: async () => {
      await watcher.close();
    } });
  });
}

// src/hooks.ts
import { isAbsolute as isAbsolute3, join as join6, relative as relative3, resolve as resolve4 } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// src/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

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
var BLAST_SEED_CAP = 20;
var BLAST_IMPACTED_CAP = 40;
var BLAST_CHANGED_CAP = 20;
function blastSymbolLine(symbol, withRelation) {
  const name2 = typeof symbol.name === "string" && symbol.name !== "" ? symbol.name : void 0;
  if (name2 === void 0) return void 0;
  const where = typeof symbol.path === "string" ? `${symbol.path}${typeof symbol.span === "string" ? `:${symbol.span}` : ""}` : void 0;
  const base = where !== void 0 ? `${name2} @ ${where}` : name2;
  if (!withRelation) return base;
  const relation = typeof symbol.relation === "string" && symbol.relation !== "" ? symbol.relation : "depends";
  const depth = typeof symbol.depth === "number" ? symbol.depth : 1;
  return `${base} (${relation}, depth ${depth})`;
}
function renderBlast(payload, maxBytes) {
  const basis = typeof payload.basis === "string" && payload.basis !== "" ? payload.basis : "unknown basis";
  const depth = typeof payload.depth === "number" ? payload.depth : 2;
  const changed = Array.isArray(payload.changed) ? payload.changed : [];
  const seeds = Array.isArray(payload.seeds) ? payload.seeds : [];
  const impacted = Array.isArray(payload.impacted) ? payload.impacted : [];
  if (changed.length === 0 && seeds.length === 0 && impacted.length === 0) {
    return `Blast radius (${basis}, depth ${depth}): No diff to analyze (clean working tree, no base ref given).`;
  }
  const lines = [`Blast radius (${basis}, depth ${depth}):`];
  if (changed.length > 0) {
    lines.push("changed:");
    for (const file of changed.slice(0, BLAST_CHANGED_CAP)) {
      const path = typeof file?.path === "string" && file.path !== "" ? file.path : "(unknown path)";
      const status = typeof file?.status === "string" && file.status !== "" ? ` (${file.status})` : "";
      lines.push(`  - ${path}${status}`);
    }
  }
  if (seeds.length > 0) {
    lines.push("touched symbols:");
    for (const symbol of seeds.slice(0, BLAST_SEED_CAP)) {
      const line = blastSymbolLine(symbol, false);
      if (line !== void 0) lines.push(`  - ${line}`);
    }
  }
  if (impacted.length > 0) {
    lines.push("impacted (downstream):");
    for (const symbol of impacted.slice(0, BLAST_IMPACTED_CAP)) {
      const line = blastSymbolLine(symbol, true);
      if (line !== void 0) lines.push(`  - ${line}`);
    }
  } else {
    lines.push("No impacted symbols detected beyond the changed lines.");
  }
  const unindexed = Array.isArray(payload.unindexed) ? payload.unindexed.filter((p) => typeof p === "string" && p !== "") : [];
  if (unindexed.length > 0) {
    lines.push(`unindexed changed files (no graph coverage): ${unindexed.slice(0, 10).join(", ")}`);
  }
  const deleted = Array.isArray(payload.deleted) ? payload.deleted.filter((p) => typeof p === "string" && p !== "") : [];
  if (deleted.length > 0) {
    lines.push(`deleted: ${deleted.slice(0, 10).join(", ")}`);
  }
  return truncateToBytes(lines.join("\n"), maxBytes);
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
import { dirname as dirname3, join as join4, resolve as resolve3, sep as sep2 } from "node:path";
var existsOnDisk = (path) => existsSync(path);
function findGitRoot(cwd, exists = existsOnDisk) {
  if (cwd === void 0 || cwd === "") return void 0;
  let dir = resolve3(cwd);
  for (; ; ) {
    if (exists(join4(dir, ".git"))) return dir;
    const parent = dirname3(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function findGraphDir(cwd, exists = existsOnDisk) {
  if (cwd === void 0 || cwd === "") return void 0;
  let dir = resolve3(cwd);
  for (; ; ) {
    const candidate = join4(dir, "graft");
    if (exists(candidate)) return candidate;
    const parent = dirname3(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
function resolveRepoAnchor(cwd, processCwd = process.cwd(), exists = existsOnDisk) {
  const effectiveCwd = cwd !== void 0 && cwd !== "" ? cwd : processCwd;
  const gitRoot = findGitRoot(effectiveCwd, exists);
  const graphDir = findGraphDir(effectiveCwd, exists);
  const graphRepoRoot = graphDir !== void 0 && graphDir.endsWith(sep2 + "graft") ? dirname3(graphDir) : graphDir;
  return {
    cwd: effectiveCwd,
    ...gitRoot !== void 0 ? { gitRoot } : {},
    ...graphDir !== void 0 ? { graphDir, graphRepoRoot } : {},
    outsideGit: gitRoot === void 0
  };
}

// src/tools.ts
var TOOL_NAMES = {
  findCode: "graph_find_code",
  fileApi: "graph_file_api",
  traceCalls: "graph_trace_calls",
  findAll: "graph_find_all",
  repoMap: "graph_repo_map",
  checkFreshness: "graph_check_freshness",
  blast: "graph_blast",
  enrich: "graph_enrich"
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
var blastSymbolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    path: { type: "string", required: true },
    span: { type: "string" },
    relation: { type: "string" },
    depth: { type: "integer" }
  }
};
var blastChangedSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    status: { type: "string" }
  }
};
function buildBlastTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.blast,
    description: 'Blast radius of a git diff (working tree vs HEAD, or against a base ref via --base): the symbols the changed lines touch and the downstream dependents that may break. Zero-cost (no LLM). Use before refactoring or to answer "what breaks if I change X".',
    parameters: {
      base: { type: "string", description: 'Base ref to diff against its merge base with HEAD (e.g. "origin/main"). Default: working tree vs HEAD.' },
      depth: { type: "integer", description: "Hops to walk over incoming edges, 1-8 (default 2)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          basis: { type: "string" },
          depth: { type: "integer" },
          changed: { type: "array", items: blastChangedSchema },
          seeds: { type: "array", items: blastSymbolSchema },
          impacted: { type: "array", items: blastSymbolSchema },
          unindexed: { type: "array", items: { type: "string" } },
          blastText: { type: "string" }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "GRAPH_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        const blastText = typeof record.blastText === "string" && record.blastText !== "" ? record.blastText : "No diff to analyze.";
        return [{ type: "text", text: blastText }];
      }
    },
    async execute(args, exec) {
      const anchor = anchorFromExec(exec, deps);
      const base = typeof args.base === "string" && args.base.trim() !== "" ? args.base.trim() : void 0;
      const depth = clampInt(args.depth, 1, 8, 2);
      const result = await withGraph(
        anchor,
        config,
        deps,
        exec.signal,
        (dir) => [
          "blast",
          ...base !== void 0 ? ["--base", base] : [],
          "--depth",
          String(depth),
          "--format",
          "json",
          dir
        ],
        (json, code) => {
          if (code !== 0) {
            return { ok: false, error: "BLAST_FAILED", hint: `graft blast exited ${code}` };
          }
          const payload = json;
          const changed = (Array.isArray(payload.changed) ? payload.changed : []).filter((f) => typeof f?.path === "string" && f.path !== "").slice(0, BLAST_TOOL_CHANGED_CAP).map((f) => ({
            path: f.path,
            ...typeof f.status === "string" ? { status: f.status } : {}
          }));
          const seeds = [];
          for (const symbol of Array.isArray(payload.seeds) ? payload.seeds : []) {
            if (typeof symbol?.name !== "string" || symbol.name === "" || typeof symbol?.path !== "string") continue;
            seeds.push({
              name: symbol.name,
              path: symbol.path,
              ...typeof symbol.span === "string" ? { span: symbol.span } : {}
            });
            if (seeds.length >= 20) break;
          }
          const impacted = [];
          for (const symbol of Array.isArray(payload.impacted) ? payload.impacted : []) {
            if (typeof symbol?.name !== "string" || symbol.name === "" || typeof symbol?.path !== "string") continue;
            impacted.push({
              name: symbol.name,
              path: symbol.path,
              ...typeof symbol.span === "string" ? { span: symbol.span } : {},
              ...typeof symbol.relation === "string" ? { relation: symbol.relation } : {},
              ...typeof symbol.depth === "number" ? { depth: symbol.depth } : {}
            });
            if (impacted.length >= 40) break;
          }
          const unindexed = Array.isArray(payload.unindexed) ? payload.unindexed.filter((p) => typeof p === "string" && p !== "").slice(0, 10) : [];
          const blastText = renderBlast(payload, config.maxInjectBytes);
          return {
            ok: true,
            ...typeof payload.basis === "string" ? { basis: payload.basis } : {},
            depth,
            changed,
            seeds,
            impacted,
            unindexed,
            blastText
          };
        }
      );
      return result;
    },
    timeoutMs: config.timeoutMs + 45e3
  });
}
var DEEP_TIMEOUT_FLOOR_MS = 6e5;
var DEEP_SUMMARY_TAIL = 500;
var DEEP_ERR_TAIL = 300;
function buildEnrichTool(config, deps) {
  return defineTool({
    name: TOOL_NAMES.enrich,
    description: "Run the engine LLM enrichment pass (graft build --deep) against the configured LOCAL model (OpenAI-compatible endpoint, e.g. Ollama): concept nodes + per-symbol summaries/crux. Explicit on-demand tool \u2014 the hooks never run it, and the key comes only from the plugin config (deep.apiKey / deep.apiKeyEnv), never from the ambient environment. The engine content-hash cache makes re-runs cheap.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          hint: { type: "string" },
          summary: { type: "string" }
        }
      },
      render: (_args, value) => {
        const record = asRecord(value) ?? {};
        if (record.ok !== true) {
          return [{ type: "text", text: `[${record.error ?? "DEEP_FAILED"}] ${typeof record.hint === "string" ? record.hint : ""}`.trim() }];
        }
        return [{ type: "text", text: typeof record.summary === "string" && record.summary !== "" ? record.summary : "Deep pass complete." }];
      }
    },
    timeoutMs: Math.max(config.timeoutMs, DEEP_TIMEOUT_FLOOR_MS),
    async execute(_args, exec) {
      const deep = config.deep;
      if (deep === void 0) {
        return { ok: false, error: "DEEP_DISABLED", hint: "enable deep.tool in the plugin config" };
      }
      const model = deep.model.trim();
      if (model === "") {
        return { ok: false, error: "DEEP_MODEL_MISSING", hint: "set deep.model (e.g. a local Ollama model id)" };
      }
      const key = deep.apiKey.trim() !== "" ? deep.apiKey.trim() : deep.apiKeyEnv.trim() !== "" ? (process.env[deep.apiKeyEnv.trim()] ?? "").trim() : "";
      if (key === "") {
        return {
          ok: false,
          error: "DEEP_KEY_MISSING",
          hint: "set deep.apiKey or deep.apiKeyEnv (the ambient GRAFT_API_KEY is never read)"
        };
      }
      const anchor = anchorFromExec(exec, deps);
      if (anchor.outsideGit || anchor.gitRoot === void 0) {
        return { ok: false, error: "NO_GIT_ROOT", hint: "graph_enrich runs inside a git repository" };
      }
      const dir = anchor.graphRepoRoot ?? anchor.gitRoot;
      const timeoutMs = Math.max(config.timeoutMs, DEEP_TIMEOUT_FLOOR_MS);
      try {
        const result = await deps.runGraphText?.(
          ["build", "--deep", dir],
          {
            cwd: dir,
            timeoutMs,
            graphPath: config.graphPath,
            signal: exec.signal,
            extraEnv: {
              GRAFT_PROVIDER: deep.provider.trim() !== "" ? deep.provider.trim() : "openai",
              GRAFT_BASE_URL: deep.baseUrl.trim() !== "" ? deep.baseUrl.trim() : "http://127.0.0.1:11434/v1",
              GRAFT_MODEL: model,
              GRAFT_API_KEY: key
            }
          }
        );
        if (result === void 0) {
          return { ok: false, error: "DEEP_DISABLED", hint: "runGraphText seam missing" };
        }
        if (result.code !== 0) {
          const tail2 = result.stderr.trim().slice(-DEEP_ERR_TAIL);
          return {
            ok: false,
            error: "DEEP_FAILED",
            hint: tail2 !== "" ? `graft build --deep exited ${result.code}: ${tail2}` : `graft build --deep exited ${result.code}`
          };
        }
        const tail = result.stdout.trim().slice(-DEEP_SUMMARY_TAIL);
        return {
          ok: true,
          summary: tail !== "" ? tail : "Deep pass complete."
        };
      } catch (error) {
        if (error instanceof GraphError) {
          return { ok: false, error: error.code, hint: error.hint ?? error.message };
        }
        return {
          ok: false,
          error: "GRAPH_FAILED",
          hint: error instanceof Error ? error.message : "unknown error"
        };
      }
    }
  });
}
var BLAST_TOOL_CHANGED_CAP = 20;
function buildGraphTools(config, deps) {
  return {
    findCode: buildFindCodeTool(config, deps),
    fileApi: buildFileApiTool(config, deps),
    traceCalls: buildTraceCallsTool(config, deps),
    findAll: buildFindAllTool(config, deps),
    repoMap: buildRepoMapTool(config, deps),
    checkFreshness: buildCheckFreshnessTool(config, deps),
    blast: buildBlastTool(config, deps),
    ...config.deep?.tool === true ? { enrich: buildEnrichTool(config, deps) } : {}
  };
}

// src/session-state.ts
import { existsSync as existsSync2, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as join5 } from "node:path";
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
  /**
   * Observe a compaction (P2b, spec #6): a NEW compaction id arms a one-shot
   * map re-inject for this (session, repo); re-observing the same id does not
   * re-arm (the summary event is replayed across listeners).
   */
  markCompaction(sessionId, gitRoot, compactionId) {
    const state = this.get(sessionId, gitRoot);
    if (state.lastCompactionId === compactionId) return;
    state.lastCompactionId = compactionId;
    state.compactionPending = compactionId;
  }
  /**
   * Take the pending compaction re-inject (P2b): returns the compaction id
   * exactly once, then clears it. Undefined when nothing is pending.
   */
  takePendingCompaction(sessionId, gitRoot) {
    const state = this.states.get(_SessionStateStore.key(sessionId, gitRoot));
    const pending = state?.compactionPending;
    if (state !== void 0 && state.compactionPending !== void 0) state.compactionPending = void 0;
    return pending;
  }
  /** Arm the one-shot subagent short map for this (session, repo) (P2b, spec #5). */
  markSubagentMap(sessionId, gitRoot) {
    this.get(sessionId, gitRoot).subagentMapPending = true;
  }
  /** Take the armed subagent short map (P2b): true exactly once, then cleared. */
  takeSubagentMap(sessionId, gitRoot) {
    const state = this.states.get(_SessionStateStore.key(sessionId, gitRoot));
    const pending = state?.subagentMapPending === true;
    if (state !== void 0 && pending) state.subagentMapPending = void 0;
    return pending;
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
  /**
   * Mark every known (session, repo) state for the repo dirty (P2c #17 file
   * watcher: the user edited in an IDE, no edit-tool event will come).
   * Unknown sessions are not created — the watcher marks what exists.
   */
  markRepoDirty(gitRoot) {
    for (const [key, state] of this.states) {
      const repo = key.split("\0")[1];
      if (repo === gitRoot) state.dirty = true;
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
  const lockPath = join5(repoRoot, LOCK_FILE_NAME);
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
  const lockPath = join5(repoRoot, LOCK_FILE_NAME);
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
function isSubagentAgent(agent) {
  try {
    const header = agent.session?.header;
    if (header === void 0) return false;
    if (header.origin === "subagent") return true;
    return typeof header.parentSession === "string" && header.parentSession !== "";
  } catch {
    return false;
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
async function handleSessionStart(agent, source, config, deps, runGraph3, watcherByRepo) {
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
  if (config.injectSubagentMap && isSubagentAgent(agent)) return;
  if (config.watcher && deps.startRepoWatcher !== void 0 && watcherByRepo.has(root) === false) {
    try {
      const handle = await deps.startRepoWatcher(root, (relPath) => {
        deps.state.markRepoDirty(root);
        deps.logger.info(`dsh-context-graph: watcher marked ${root} dirty via ${relPath}`);
      });
      watcherByRepo.set(root, handle);
      deps.logger.info(`dsh-context-graph: file watcher started for ${root}`);
    } catch (error) {
      deps.logger.warn(`dsh-context-graph: file watcher skipped (${errorMessage(error)})`);
    }
  }
  if (config.blastOnResume && source === "resume" && deps.gitDirty !== void 0) {
    const blastRoot = anchor.graphRepoRoot ?? root;
    try {
      const dirty = await deps.gitDirty(root);
      if (dirty) {
        const { json, code } = await runGraph3(["blast", "--depth", "2", "--format", "json", blastRoot], {
          cwd: blastRoot,
          timeoutMs: config.timeoutMs,
          graphPath: config.graphPath
        });
        if (code !== 0) {
          deps.logger.warn(`dsh-context-graph: graft blast exited ${code}; skipping resume blast`);
        } else {
          const rendered = renderBlast(json, Math.floor(config.maxInjectBytes / 2));
          if (rendered !== "") injectSafe(agent, rendered, deps);
        }
      }
    } catch (error) {
      deps.logger.warn(`dsh-context-graph: resume blast skipped (${errorMessage(error)})`);
    }
  }
  const dir = anchor.graphRepoRoot ?? root;
  try {
    const { json, code } = await runGraph3(["map", "--json", dir], {
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
async function handlePreStep(payload, next, config, deps, runGraph3) {
  const decision = await next();
  if (decision.kind !== "enter") return decision;
  let result = decision;
  if (config.injectSubagentMap) {
    result = await injectSubagentMap(payload, config, deps, runGraph3, result);
  }
  if (config.reinjectAfterCompaction) {
    result = await reInjectCompactedMap(payload, config, deps, runGraph3, result);
  }
  if (!config.injectPromptHits || config.injectMode === "map-only") return result;
  try {
    const prompt = promptText(decision.messages);
    if (prompt.length < config.promptMinChars) return result;
    const agent = payload.agent;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return result;
    const root = anchor.gitRoot;
    if (root === void 0 || anchor.graphDir === void 0) return result;
    const sessionKey = agentId(agent);
    const dir = anchor.graphRepoRoot ?? root;
    const promptHash = hashPrompt(prompt);
    const memoized = deps.state.lookupPromptHit(sessionKey, root, promptHash);
    if (memoized !== void 0 && deps.state.isHitInjected(sessionKey, root, memoized)) {
      return result;
    }
    const lastFile = config.scopeFromLastEdit ? deps.state.getLastFile(sessionKey, root) : void 0;
    const scope = lastFile !== void 0 && lastFile.includes("/") ? lastFile.slice(0, lastFile.indexOf("/")) : void 0;
    const args = ["ask", prompt.slice(0, 1024), "--json", "-n", "3"];
    if (config.injectMode === "sourced") args.push("--source");
    if (scope !== void 0) args.push("--in", scope);
    args.push(dir);
    const { json, code } = await runGraph3(args, {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath,
      signal: payload.signal
    });
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: pre-step ask exited ${code}; skipping`);
      return result;
    }
    const hits = Array.isArray(json.hits) ? json.hits : [];
    const top = hits[0];
    if (top === void 0 || typeof top !== "object" || top === null) return result;
    const hitKey = `${typeof top.pointer === "string" ? top.pointer : ""}\0${typeof top.title === "string" ? top.title : ""}`;
    deps.state.recordPromptHit(sessionKey, root, promptHash, hitKey);
    if (!deps.state.markHitInjected(sessionKey, root, hitKey)) return result;
    const rendered = config.injectMode === "sourced" ? renderPromptHitsSourced(json, config.maxInjectBytes) : renderPromptHits(json, config.maxInjectBytes);
    if (rendered === "") return result;
    const message = createUserMessage({
      content: [{ type: "text", text: rendered }],
      source: { kind: "plugin", plugin: deps.pluginName }
    });
    return { ...result, messages: [...result.messages, message] };
  } catch (error) {
    if (error instanceof GraphError && error.code === "GRAPH_CLI_MISSING") return result;
    deps.logger.error(`dsh-context-graph: pre-step hook failed (${errorMessage(error)})`);
    return result;
  }
}
async function blastRadiusForFile(relPath, dir, config, runGraph3) {
  const { json: skeleton, code } = await runGraph3(
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
      const { json: calls } = await runGraph3(
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
  const resolved = isAbsolute3(readPath) ? readPath : resolve4(sessionCwd, readPath);
  const rel = relative3(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute3(rel)) return "nonSource";
  const graphDir = anchor.graphDir ?? join6(root, "graft");
  if (resolved === graphDir || resolved.startsWith(graphDir + "/")) return "nonSource";
  return "source";
}
async function handlePostExecute(exec, _result, next, config, deps, runGraph3) {
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
    const resolved = isAbsolute3(filePath) ? filePath : resolve4(sessionCwd, filePath);
    const rel = relative3(root, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute3(rel)) return decision;
    const graphDir = anchor.graphDir ?? join6(root, "graft");
    if (resolved === graphDir || resolved.startsWith(graphDir + "/")) return decision;
    deps.state.markDirty(sessionKey, root);
    deps.state.setLastFile(sessionKey, root, rel);
    if (!config.injectBlastRadius || anchor.graphDir === void 0) return decision;
    const dir = anchor.graphRepoRoot ?? root;
    const blast = await blastRadiusForFile(rel, dir, config, runGraph3);
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
        const resolved = isAbsolute3(readPath) ? readPath : resolve4(sessionCwd, readPath);
        const graphInner = join6(anchor.graphDir ?? join6(root, "graft"), ".graph");
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
var COMPACTION_REINJECT_INTRO = "Session history was compacted \u2014 repo orientation restored (short map; use the graph tools for source):";
var SUBAGENT_MAP_INTRO = "Repo context graph (short map for this subagent; use the graph tools for source):";
async function reInjectCompactedMap(payload, config, deps, runGraph3, decision) {
  try {
    const agent = payload.agent;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return decision;
    const root = anchor.gitRoot;
    if (root === void 0 || anchor.graphDir === void 0) return decision;
    const sessionKey = agentId(agent);
    const pendingId = deps.state.takePendingCompaction(sessionKey, root);
    if (pendingId === void 0) return decision;
    const dir = anchor.graphRepoRoot ?? root;
    const { json, code } = await runGraph3(["map", "--json", dir], {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath,
      signal: payload.signal
    });
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: compaction re-inject map exited ${code}; skipping`);
      return decision;
    }
    const rendered = renderMap(json, config.maxInjectBytes / 2);
    if (rendered === "") return decision;
    const message = createUserMessage({
      content: [{ type: "text", text: `${COMPACTION_REINJECT_INTRO}
${rendered}` }],
      source: { kind: "plugin", plugin: deps.pluginName }
    });
    deps.logger.info(`dsh-context-graph: compaction map re-injected (id ${pendingId})`);
    return { ...decision, messages: [...decision.messages, message] };
  } catch (error) {
    deps.logger.error(`dsh-context-graph: compaction re-inject failed (${errorMessage(error)})`);
    return decision;
  }
}
function handleAgentCreated(agent, config, deps) {
  if (!config.injectSubagentMap) return;
  try {
    if (!isSubagentAgent(agent)) return;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return;
    const root = anchor.gitRoot;
    if (root === void 0 || anchor.graphDir === void 0) return;
    deps.state.markSubagentMap(agentId(agent), root);
    deps.logger.info("dsh-context-graph: subagent map armed; delivered at the subagent's first pre-step");
  } catch (error) {
    deps.logger.warn(`dsh-context-graph: agent-created hook failed (${errorMessage(error)})`);
  }
}
async function injectSubagentMap(payload, config, deps, runGraph3, decision) {
  try {
    const agent = payload.agent;
    const anchor = sessionAnchor(agent, deps);
    if (anchor === void 0 || anchor.outsideGit) return decision;
    const root = anchor.gitRoot;
    if (root === void 0 || anchor.graphDir === void 0) return decision;
    const sessionKey = agentId(agent);
    if (!deps.state.takeSubagentMap(sessionKey, root)) return decision;
    const dir = anchor.graphRepoRoot ?? root;
    const { json, code } = await runGraph3(["map", "--json", dir], {
      cwd: dir,
      timeoutMs: config.timeoutMs,
      graphPath: config.graphPath,
      signal: payload.signal
    });
    if (code !== 0) {
      deps.logger.warn(`dsh-context-graph: subagent map exited ${code}; skipping`);
      return decision;
    }
    const rendered = renderMap(json, config.maxInjectBytes / 2);
    if (rendered === "") return decision;
    const message = createUserMessage({
      content: [{ type: "text", text: `${SUBAGENT_MAP_INTRO}
${rendered}` }],
      source: { kind: "plugin", plugin: deps.pluginName }
    });
    deps.logger.info(`dsh-context-graph: subagent map delivered at pre-step (session ${sessionKey})`);
    return { ...decision, messages: [...decision.messages, message] };
  } catch (error) {
    deps.logger.error(`dsh-context-graph: subagent map delivery failed (${errorMessage(error)})`);
    return decision;
  }
}
function handleSessionEvent(session, event, config, deps) {
  if (!config.reinjectAfterCompaction) return;
  try {
    if (event === null || typeof event !== "object") return;
    if (event.type !== "compaction/summary" && event.type !== "compaction/prune") return;
    const data = event.data;
    const compactionId = data !== void 0 && typeof data.compactionId === "string" ? data.compactionId : void 0;
    if (compactionId === void 0) return;
    const header = session?.header;
    if (header === void 0) return;
    const sessionId = typeof header.id === "string" ? header.id : void 0;
    const cwd = typeof header.cwd === "string" ? header.cwd : void 0;
    if (sessionId === void 0) return;
    const anchor = resolveRepoAnchor(cwd, deps.processCwd?.() ?? process.cwd());
    if (anchor === void 0 || anchor.outsideGit) return;
    if (anchor.gitRoot === void 0 || anchor.graphDir === void 0) return;
    deps.state.markCompaction(sessionId, anchor.gitRoot, compactionId);
    deps.logger.info(`dsh-context-graph: compaction ${compactionId} observed; map re-injects at the next pre-step`);
  } catch (error) {
    deps.logger.warn(`dsh-context-graph: session/event hook failed (${errorMessage(error)})`);
  }
}
function reorderToolsForGraph(tools, graphToolNames) {
  if (tools === void 0) return [];
  const graph = new Set(graphToolNames);
  const head = [];
  const tail = [];
  for (const tool of tools) {
    if (tool !== null && typeof tool === "object" && typeof tool.name === "string" && graph.has(tool.name)) {
      head.push(tool);
    } else {
      tail.push(tool);
    }
  }
  if (head.length === 0) return tools;
  return [...head, ...tail];
}
async function handleAssemble(_assembly, _context, next, config, logger) {
  const result = await next();
  if (!config.toolOrder) return result;
  try {
    if (result !== null && typeof result === "object" && Array.isArray(result.tools)) {
      result.tools = reorderToolsForGraph(result.tools, Object.values(TOOL_NAMES));
    }
  } catch (error) {
    logger.warn(`dsh-context-graph: toolOrder skipped (${errorMessage(error)})`);
  }
  return result;
}
function registerHooks(ctx, config, deps, runGraph3) {
  const watcherByRepo = /* @__PURE__ */ new Map();
  if (config.injectSessionMap) {
    ctx.on("agent/session-start", (payload) => {
      void handleSessionStart(payload.agent, payload.source, config, deps, runGraph3, watcherByRepo).catch((error) => {
        deps.logger.error(`dsh-context-graph: session-start hook failed (${errorMessage(error)})`);
      });
    });
  }
  ctx.on("agent/pre-step", (payload, next) => {
    return handlePreStep(payload, next, config, deps, runGraph3);
  });
  ctx.on("tools/pre-execute", (exec, next) => {
    return handlePreExecute(exec, next, config, deps);
  });
  ctx.on("tools/post-execute", (exec, result, next) => {
    return handlePostExecute(exec, result, next, config, deps, runGraph3);
  });
  ctx.on("agent/turn-stopping", (payload) => {
    void handleTurnStopping(payload.agent, config, deps).catch((error) => {
      deps.logger.error(`dsh-context-graph: turn-stopping hook failed (${errorMessage(error)})`);
    });
  });
  if (config.injectSubagentMap) {
    ctx.on("agent/created", (payload) => {
      handleAgentCreated(payload.agent, config, deps);
    });
  }
  if (config.reinjectAfterCompaction) {
    ctx.on("session/event", (session, event) => {
      handleSessionEvent(session, event, config, deps);
    });
  }
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    return handleAssemble(assembly, context, next, config, deps.logger);
  });
}

// src/metrics.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join8 } from "node:path";

// src/skill.ts
import { homedir } from "node:os";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join7 } from "node:path";

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
Code Mode (PTC): all graph tools are callable inside \`run_code\` programs
  as \`await tools.graph_<name>(args)\` \u2014 the host SDK includes them automatically.
- \`graph_blast\` \u2014 diff blast radius: the symbols the changed lines touch and the
  downstream dependents that may break (\`base\` to diff against a ref like
  \`origin/main\`). Use before refactoring / for "what breaks if I change X".
- \`graph_enrich\` \u2014 ONLY if enabled in config (\`deep.tool: true\`): on-demand LOCAL LLM deep pass (\`graft build --deep\` against the configured endpoint, e.g. Ollama); expensive \u2014 call only when richer symbol summaries are needed.

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
  return join7(homedir(), ".dsh");
}
function installSkill(options = {}) {
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.warn(`dsh-context-graph: skill install skipped (${message})`);
    return { ok: false, error: message };
  };
  try {
    const home = resolveDshHome(options.env);
    const file = join7(home, SKILL_FILE_RELATIVE_PATH);
    if (existsSync3(file)) {
      return { ok: true, path: file };
    }
    mkdirSync2(join7(home, "skills", "graph"), { recursive: true });
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
  return join8(resolveDshHome(), STATS_FILE_NAME);
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

// src/index.ts
var execFileAsync = promisify(execFile);
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
  // P2c #7: legacy boolean rows (deep: true/false) and the new object form
  // are both accepted; normalizeConfig unifies them into DeepConfig.
  deep: z.union([
    z.boolean(),
    z.object({
      tool: z.boolean().default(false),
      model: z.string().default(""),
      baseUrl: z.string().default(""),
      provider: z.string().default("openai"),
      apiKey: z.string().default(""),
      apiKeyEnv: z.string().default("")
    })
  ]).default(false),
  editToolNames: z.array(z.string()).default(["write", "edit"]),
  // schemastery (v3.18.2) has no z.enum: a closed set of literals is a union of consts.
  injectMode: z.union([z.const("pointers"), z.const("sourced"), z.const("map-only")]).default("sourced"),
  nudgeOnBlindSearch: z.boolean().default(true),
  scopeFromLastEdit: z.boolean().default(false),
  metrics: z.boolean().default(true),
  guardWiringReads: z.boolean().default(false),
  injectSubagentMap: z.boolean().default(true),
  reinjectAfterCompaction: z.boolean().default(true),
  toolOrder: z.boolean().default(true),
  blastOnResume: z.boolean().default(true),
  watcher: z.boolean().default(false)
});
function normalizeDeep(raw) {
  const defaults = { tool: false, model: "", baseUrl: "", provider: "openai", apiKey: "", apiKeyEnv: "" };
  if (typeof raw === "boolean") return { ...defaults, tool: raw };
  if (raw !== null && typeof raw === "object") {
    const source = raw;
    return {
      tool: source.tool === true,
      model: typeof source.model === "string" ? source.model : "",
      baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
      provider: typeof source.provider === "string" && source.provider !== "" ? source.provider : "openai",
      apiKey: typeof source.apiKey === "string" ? source.apiKey : "",
      apiKeyEnv: typeof source.apiKeyEnv === "string" ? source.apiKeyEnv : ""
    };
  }
  return defaults;
}
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
    deep: normalizeDeep(source.deep),
    editToolNames: Array.isArray(source.editToolNames) ? source.editToolNames.filter((entry) => typeof entry === "string" && entry !== "") : ["write", "edit"],
    injectMode: source.injectMode === "pointers" || source.injectMode === "sourced" || source.injectMode === "map-only" ? source.injectMode : "sourced",
    nudgeOnBlindSearch: source.nudgeOnBlindSearch ?? true,
    scopeFromLastEdit: source.scopeFromLastEdit ?? false,
    metrics: source.metrics ?? true,
    guardWiringReads: source.guardWiringReads ?? false,
    injectSubagentMap: source.injectSubagentMap ?? true,
    reinjectAfterCompaction: source.reinjectAfterCompaction ?? true,
    toolOrder: source.toolOrder ?? true,
    blastOnResume: source.blastOnResume ?? true,
    watcher: source.watcher === true
  };
  return out;
}
function positiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
async function isGitDirty(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      timeout: 5e3,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}
function systemPromptSection(config) {
  return [
    "Repo context graph (dsh-context-graph) is available for this workspace.",
    `Native tools: ${TOOL_NAMES.repoMap} (orientation), ${TOOL_NAMES.findCode} (question/symbol/error to file:line), ${TOOL_NAMES.fileApi} (file signatures without bodies), ${TOOL_NAMES.traceCalls} (callers/callees, depth for blast radius), ${TOOL_NAMES.findAll} (ranked regex), ${TOOL_NAMES.checkFreshness} (drift), ${TOOL_NAMES.blast} (diff blast radius: what breaks if these lines change).`,
    "Before broad grep/read, call graph_repo_map (unfamiliar repo) or graph_find_code (a concrete question).",
    "After larger edits, call graph_check_freshness; on drift run `graft build` (structural, no LLM).",
    ...config.deep.tool ? [`${TOOL_NAMES.enrich} (on-demand LOCAL LLM deep pass against the configured endpoint, deep.* config; expensive \u2014 call only when richer symbol summaries are needed).`] : [],
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
      maxInjectBytes: config.maxInjectBytes,
      deep: config.deep
    };
    const tools = buildGraphTools(toolsConfig, {
      runGraphJson,
      runGraphText: runGraph,
      onNpxFallback: (note) => logger.warn(`dsh-context-graph: ${note}`)
    });
    ctx.tools.register(tools.findCode);
    ctx.tools.register(tools.fileApi);
    ctx.tools.register(tools.traceCalls);
    ctx.tools.register(tools.findAll);
    ctx.tools.register(tools.repoMap);
    ctx.tools.register(tools.checkFreshness);
    ctx.tools.register(tools.blast);
    if (tools.enrich !== void 0) ctx.tools.register(tools.enrich);
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
    injectMode: config.injectMode,
    nudgeOnBlindSearch: config.nudgeOnBlindSearch,
    scopeFromLastEdit: config.scopeFromLastEdit,
    metrics: config.metrics,
    guardWiringReads: config.guardWiringReads,
    injectSubagentMap: config.injectSubagentMap,
    reinjectAfterCompaction: config.reinjectAfterCompaction,
    toolOrder: config.toolOrder,
    blastOnResume: config.blastOnResume,
    watcher: config.watcher
  };
  registerHooks(ctx, hooksConfig, {
    state,
    spawnBuild: spawnDetachedBuild,
    releaseLock: (repoRoot) => releaseBuildLock(repoRoot),
    pluginName: name,
    logger,
    gitDirty: isGitDirty,
    startRepoWatcher: config.watcher ? startChokidarWatcher : void 0,
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
  logger.info(`dsh-context-graph: loaded (tools=${config.tools}, sessionMap=${config.injectSessionMap}, autoBuild=${config.autoBuild}, promptHits=${config.injectPromptHits}/${config.injectMode}, blast=${config.injectBlastRadius}, autoSync=${config.autoSync}, nudge=${config.nudgeOnBlindSearch}, scope=${config.scopeFromLastEdit}, metrics=${config.metrics}, guardWiring=${config.guardWiringReads}, subagentMap=${config.injectSubagentMap}, compactionReinject=${config.reinjectAfterCompaction}, toolOrder=${config.toolOrder}, blastOnResume=${config.blastOnResume}, deepTool=${config.deep.tool}, watcher=${config.watcher})`);
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
/*! Bundled license information:

chokidar/esm/index.js:
  (*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) *)
*/
