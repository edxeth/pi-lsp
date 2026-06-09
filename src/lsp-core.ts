/**
 * LSP Core - Language Server Protocol client management
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolvePiPaths } from "./lsp-paths.js";
import { LANGUAGE_IDS, LSP_REGISTRY, getRegistryEntry, type LspRegistryEntry } from "./lsp-registry.js";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentDiagnosticRequest,
  WorkspaceDiagnosticRequest,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  SignatureHelpRequest,
  DocumentSymbolRequest,
  RenameRequest,
  CodeActionRequest,
} from "vscode-languageserver-protocol/node";
import {
  type Diagnostic,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type SignatureHelp,
  type WorkspaceEdit,
  type CodeAction,
  type Command,
  CodeActionKind,
  DocumentDiagnosticReportKind,
} from "vscode-languageserver-protocol";

// Config
const INIT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 1000;
const MAX_OPEN_FILES = 30;
const IDLE_TIMEOUT_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

export class LspConnectionClosedError extends Error {
  constructor(
    readonly serverId: string,
    readonly root: string,
    message = `LSP connection closed for ${serverId} at ${root}`
  ) {
    super(message);
    this.name = "LspConnectionClosedError";
  }
}

export class LspProcessExitedError extends Error {
  constructor(
    readonly serverId: string,
    readonly root: string,
    readonly exitCode: number | null,
    readonly stderrTail = ""
  ) {
    super(`LSP process ${serverId} at ${root} exited with code ${exitCode}${stderrTail ? `; stderr tail: ${stderrTail}` : ""}`);
    this.name = "LspProcessExitedError";
  }
}

export function isLspDeadConnectionError(error: unknown): boolean {
  return error instanceof LspConnectionClosedError || error instanceof LspProcessExitedError;
}

// Types
interface LSPServerConfig {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<{ process: ChildProcessWithoutNullStreams; initOptions?: Record<string, unknown> } | undefined>;
  command?: string[];
  env?: Record<string, string>;
}

interface CustomServerConfig {
  command?: string[];
  extensions?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

interface CustomLspConfig {
  lsp?: Record<string, CustomServerConfig>;
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function loadCustomServerConfig(cwd: string): Record<string, CustomServerConfig> {
  const userConfigDir = process.env.PI_CODING_AGENT_DIR || (process.env.HOME ? path.join(process.env.HOME, ".pi") : undefined);
  const userConfig = userConfigDir ? readJsonFile<CustomLspConfig>(path.join(userConfigDir, "lsp-client.json"))?.lsp : undefined;
  const projectConfig = readJsonFile<CustomLspConfig>(path.join(cwd, ".pi", "lsp-client.json"))?.lsp;
  return { ...(userConfig ?? {}), ...(projectConfig ?? {}) };
}

export interface LspInspection {
  file: string;
  ext: string;
  serverId?: string;
  root?: string;
  binary?: string;
  status: "ok" | "unsupported" | "missing-binary" | "startup-failed";
  reason?: string;
}

interface OpenFile {
  version: number;
  lastAccess: number;
  text: string;
}

interface LSPClient {
  serverId: string;
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFile>;
  listeners: Map<string, Array<() => void>>;
  stderr: string[];
  capabilities?: unknown;
  root: string;
  closed: boolean;
}

export interface LspClientSnapshot {
  root: string;
  serverId: string;
  openFiles: number;
  alive: boolean;
  command: string[];
}

interface FileDiagnosticItem {
  file: string;
  diagnostics: Diagnostic[];
  status: "ok" | "timeout" | "error" | "unsupported";
  error?: string;
}

export interface FileDiagnosticsResult {
  items: FileDiagnosticItem[];
}

// Utilities
function globalSearchPaths(): string[] {
  return Array.from(
    new Set([
      ...(process.env.PATH?.split(path.delimiter) || []),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, "bin") : "",
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.pub-cache/bin`,
      `${process.env.HOME}/fvm/default/bin`,
      `${process.env.HOME}/go/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ].filter(Boolean))
  );
}

function findExecutableInDirs(cmd: string, dirs: string[]): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
}

function cachedBin(cmd: string): string | undefined {
  return findExecutableInDirs(cmd, [resolvePiPaths().lspBinDir]);
}

function firstDefined(...items: (string | undefined)[]): string | undefined {
  return items.find((item): item is string => !!item);
}

function resolveCommandBinary(root: string, cmd: string): string | undefined {
  return path.isAbsolute(cmd) ? (fs.existsSync(cmd) ? cmd : undefined) : projectBin(root, cmd) || cachedBin(cmd) || globalBin(cmd);
}

function globalBin(cmd: string): string | undefined {
  return findExecutableInDirs(cmd, globalSearchPaths());
}

function which(cmd: string): string | undefined {
  return cachedBin(cmd) || globalBin(cmd);
}

function projectBin(root: string, cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const full = path.join(root, "node_modules", ".bin", cmd + ext);
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  } catch {}
}

function normalizeFsPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function findMarkerInDir(dir: string, target: string): string | undefined {
  if (!target.includes("*")) {
    const candidate = path.join(dir, target);
    return fs.existsSync(candidate) ? candidate : undefined;
  }
  if (!fs.existsSync(dir)) return undefined;
  const pattern = new RegExp(`^${target.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const match = fs.readdirSync(dir).find((name) => pattern.test(name));
  return match ? path.join(dir, match) : undefined;
}

function findNearestFile(startDir: string, targets: string[], stopDir: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  if (isPathInsideOrEqual(current, stop)) {
    // Inside or equal to cwd: walk up but stop at cwd boundary.
    while (isPathInsideOrEqual(current, stop)) {
      for (const t of targets) {
        const marker = findMarkerInDir(current, t);
        if (marker) return marker;
      }
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } else {
    // Outside cwd: walk up from the file's directory toward filesystem root.
    // Use a depth cap to avoid runaway traversal on very deep trees.
    const MAX_DEPTH = 20;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      for (const t of targets) {
        const marker = findMarkerInDir(current, t);
        if (marker) return marker;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function findRoot(file: string, cwd: string, markers: string[]): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : undefined;
}

function timeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    promise.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function spawnCommand(command: string[], env?: Record<string, string>) {
  return async (root: string) => {
    const [bin, ...args] = command;
    if (!bin) return undefined;
    const cmd = resolveCommandBinary(root, bin);
    if (!cmd) return undefined;
    return { process: spawn(cmd, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env }) };
  };
}

function simpleSpawn(bin: string, args: string[] = ["--stdio"]) {
  return spawnCommand([bin, ...args]);
}

async function spawnChecked(cmd: string, args: string[], cwd: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  try {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

    return await new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };

      let timer: NodeJS.Timeout | null = null;

      const finish = (value: ChildProcessWithoutNullStreams | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const onExit = () => finish(undefined);
      const onError = () => finish(undefined);

      child.once("exit", onExit);
      child.once("error", onError);

      timer = setTimeout(() => finish(child), 200);
      (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
    });
  } catch {
    return undefined;
  }
}

function detectConfiguredServerBinary(config: LSPServerConfig, root: string): string | undefined {
  if (config.command?.length) {
    const bin = config.command[0];
    if (!bin) return undefined;
    return resolveCommandBinary(root, bin);
  }
  return detectServerBinary(config.id, root);
}

function detectServerBinary(serverId: string, root: string): string | undefined {
  switch (serverId) {
    case "typescript":
      return firstDefined(
        projectBin(root, "tsgo"),
        projectBin(root, "typescript-language-server"),
        cachedBin("tsgo"),
        cachedBin("typescript-language-server"),
        globalBin("tsgo"),
        globalBin("typescript-language-server")
      );
    case "vue":
      return projectBin(root, "vue-language-server") || which("vue-language-server");
    case "svelte":
      return projectBin(root, "svelteserver") || which("svelteserver");
    case "bash":
      return projectBin(root, "bash-language-server") || which("bash-language-server");
    case "yaml-ls":
      return projectBin(root, "yaml-language-server") || which("yaml-language-server");
    case "dockerfile":
      return projectBin(root, "docker-langserver") || which("docker-langserver");
    case "php-intelephense":
      return projectBin(root, "intelephense") || which("intelephense");
    case "prisma":
      return projectBin(root, "prisma") || which("prisma");
    case "terraform":
      return projectBin(root, "terraform-ls") || which("terraform-ls");
    case "clangd":
      return projectBin(root, "clangd") || which("clangd");
    case "lua-ls":
      return projectBin(root, "lua-language-server") || which("lua-language-server");
    case "pyright":
      return projectBin(root, "pyright-langserver") || which("pyright-langserver");
    case "gopls":
      return projectBin(root, "gopls") || which("gopls");
    case "rust-analyzer":
      return projectBin(root, "rust-analyzer") || which("rust-analyzer");
    case "dart": {
      let dart = which("dart");
      const pubspec = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspec)) {
        try {
          const content = fs.readFileSync(pubspec, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutter = which("flutter");
            if (flutter) {
              const dir = path.dirname(fs.realpathSync(flutter));
              for (const p of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
                const candidate = path.join(dir, p);
                if (fs.existsSync(candidate)) return candidate;
              }
            }
          }
        } catch {}
      }
      return dart;
    }
    default:
      return undefined;
  }
}

function fileMatchKeys(absPath: string): string[] {
  return [path.extname(absPath), path.basename(absPath)].filter(Boolean);
}

function serverMatchesFile(config: LSPServerConfig, absPath: string): boolean {
  return fileMatchKeys(absPath).some((key) => config.extensions.includes(key));
}

function languageIdForFile(fp: string): string {
  for (const key of fileMatchKeys(fp)) {
    const languageId = LANGUAGE_IDS[key];
    if (languageId) return languageId;
  }
  return "plaintext";
}

function explainNoLspReason(cwd: string, absPath: string): string {
  const ext = path.extname(absPath);

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
    if (findNearestFile(path.dirname(absPath), ["deno.json", "deno.jsonc"], cwd)) {
      return "Deno project detected. This extension intentionally skips the TypeScript LSP for Deno roots.";
    }
    return "No JS/TS project root detected (looked for package.json, tsconfig.json, or jsconfig.json under cwd).";
  }

  if (ext === ".go") {
    return "No Go project root detected (looked for go.work or go.mod under cwd).";
  }

  return `No LSP for ${ext}`;
}

export function inspectLspForFile(cwd: string, filePath: string): LspInspection {
  const absPath = normalizeFsPath(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
  const ext = path.extname(absPath);

  for (const config of lspServersFor(cwd)) {
    if (!serverMatchesFile(config, absPath)) continue;
    const root = config.findRoot(absPath, cwd);
    if (!root) continue;

    const binary = detectConfiguredServerBinary(config, root);
    if (binary) {
      return { file: absPath, ext, serverId: config.id, root, binary, status: "ok" };
    }

    return {
      file: absPath,
      ext,
      serverId: config.id,
      root,
      status: "missing-binary",
      reason: `Project root detected, but no ${getRegistryEntry(config.id)?.displayName ?? config.id} language-server binary was found.`,
    };
  }

  return { file: absPath, ext, status: "unsupported", reason: explainNoLspReason(cwd, absPath) };
}

// Server Configs
export const LSP_SERVERS: LSPServerConfig[] = [
  {
    id: "dart",
    extensions: getRegistryEntry("dart")?.extensions ?? [".dart"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dart = which("dart");
      const pubspec = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspec)) {
        try {
          const content = fs.readFileSync(pubspec, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutter = which("flutter");
            if (flutter) {
              const dir = path.dirname(fs.realpathSync(flutter));
              for (const p of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
                const c = path.join(dir, p);
                if (fs.existsSync(c)) {
                  dart = c;
                  break;
                }
              }
            }
          }
        } catch {}
      }
      if (!dart) return undefined;
      return { process: spawn(dart, ["language-server", "--protocol=lsp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },
  {
    id: "typescript",
    extensions: getRegistryEntry("typescript")?.extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: (f, cwd) => {
      // Skip if this is a Deno project
      if (findNearestFile(path.dirname(f), ["deno.json", "deno.jsonc"], cwd)) return undefined;
      return findRoot(f, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: async (root) => {
      const candidates = [
        { cmd: projectBin(root, "tsgo"), args: ["--lsp", "--stdio"] },
        { cmd: projectBin(root, "typescript-language-server"), args: ["--stdio"] },
        { cmd: cachedBin("tsgo"), args: ["--lsp", "--stdio"] },
        { cmd: cachedBin("typescript-language-server"), args: ["--stdio"] },
        { cmd: globalBin("tsgo"), args: ["--lsp", "--stdio"] },
        { cmd: globalBin("typescript-language-server"), args: ["--stdio"] },
      ];

      for (const candidate of candidates) {
        if (!candidate.cmd) continue;
        if (path.basename(candidate.cmd).startsWith("tsgo")) {
          const proc = await spawnChecked(candidate.cmd, candidate.args, root);
          if (proc) return { process: proc };
          continue;
        }
        return { process: spawn(candidate.cmd, candidate.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
      }

      return undefined;
    },
  },
  {
    id: "vue",
    extensions: getRegistryEntry("vue")?.extensions ?? [".vue"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "vite.config.ts", "vite.config.js"]),
    spawn: simpleSpawn("vue-language-server"),
  },
  {
    id: "svelte",
    extensions: getRegistryEntry("svelte")?.extensions ?? [".svelte"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "svelte.config.js"]),
    spawn: simpleSpawn("svelteserver"),
  },
  {
    id: "pyrefly",
    extensions: getRegistryEntry("pyrefly")?.extensions ?? [".py", ".pyi"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["pyrefly.toml"]),
    command: ["pyrefly", "lsp"],
    spawn: simpleSpawn("pyrefly", ["lsp"]),
  },
  {
    id: "pyright",
    extensions: getRegistryEntry("pyright")?.extensions ?? [".py", ".pyi"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]),
    spawn: simpleSpawn("pyright-langserver"),
  },
  {
    id: "bash",
    extensions: getRegistryEntry("bash")?.extensions ?? [".sh", ".bash", ".zsh", ".ksh"],
    findRoot: (_f, cwd) => cwd,
    spawn: simpleSpawn("bash-language-server", ["start"]),
  },
  {
    id: "yaml-ls",
    extensions: getRegistryEntry("yaml-ls")?.extensions ?? [".yaml", ".yml"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    spawn: simpleSpawn("yaml-language-server", ["--stdio"]),
  },
  {
    id: "dockerfile",
    extensions: getRegistryEntry("dockerfile")?.extensions ?? [".dockerfile", "Dockerfile"],
    findRoot: (_f, cwd) => cwd,
    spawn: simpleSpawn("docker-langserver", ["--stdio"]),
  },
  {
    id: "php-intelephense",
    extensions: getRegistryEntry("php-intelephense")?.extensions ?? [".php"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["composer.json", "composer.lock", ".php-version"]),
    spawn: simpleSpawn("intelephense", ["--stdio"]),
  },
  {
    id: "prisma",
    extensions: getRegistryEntry("prisma")?.extensions ?? [".prisma"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["schema.prisma", "package.json"]),
    spawn: simpleSpawn("prisma", ["language-server"]),
  },
  {
    id: "terraform",
    extensions: getRegistryEntry("terraform")?.extensions ?? [".tf", ".tfvars"],
    findRoot: (_f, cwd) => cwd,
    spawn: simpleSpawn("terraform-ls", ["serve"]),
  },
  {
    id: "clangd",
    extensions: getRegistryEntry("clangd")?.extensions ?? [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["compile_commands.json", "compile_flags.txt", ".clangd"]),
    spawn: simpleSpawn("clangd", []),
  },
  {
    id: "lua-ls",
    extensions: getRegistryEntry("lua-ls")?.extensions ?? [".lua"],
    findRoot: (f, cwd) => findRoot(f, cwd, [".luarc.json", ".luarc.jsonc", ".luacheckrc", ".stylua.toml", "stylua.toml", "selene.toml", "selene.yml"]),
    spawn: simpleSpawn("lua-language-server", []),
  },
  {
    id: "gopls",
    extensions: getRegistryEntry("gopls")?.extensions ?? [".go"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["go.work"]) || findRoot(f, cwd, ["go.mod"]),
    spawn: simpleSpawn("gopls", []),
  },
  {
    id: "rust-analyzer",
    extensions: getRegistryEntry("rust-analyzer")?.extensions ?? [".rs"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["Cargo.toml"]),
    spawn: simpleSpawn("rust-analyzer", []),
  },
];

const SPECIAL_SERVER_IDS = new Set(LSP_SERVERS.map((server) => server.id));

function findRuntimeRoot(file: string, cwd: string, entry: LspRegistryEntry): string | undefined {
  if (entry.runtime?.rootStrategy === "cwd") return isPathInsideOrEqual(file, cwd) ? cwd : undefined;
  const markers = entry.runtime?.rootMarkers;
  if (!markers?.length) return isPathInsideOrEqual(file, cwd) ? cwd : undefined;
  return findRoot(file, cwd, markers);
}

function registryRuntimeServerConfigs(): LSPServerConfig[] {
  return LSP_REGISTRY.filter((entry) => entry.runtime && !SPECIAL_SERVER_IDS.has(entry.id)).map((entry) => ({
    id: entry.id,
    extensions: entry.extensions,
    findRoot: (file, cwd) => findRuntimeRoot(file, cwd, entry),
    command: entry.runtime!.command,
    spawn: spawnCommand(entry.runtime!.command),
  }));
}

function customServerConfigs(cwd: string): LSPServerConfig[] {
  const configured = loadCustomServerConfig(cwd);
  const servers: LSPServerConfig[] = [];

  for (const [id, entry] of Object.entries(configured)) {
    if (entry.disabled || !entry.command?.length || !entry.extensions?.length) continue;
    servers.push({
      id,
      extensions: entry.extensions,
      findRoot: (file, rootCwd) => (isPathInsideOrEqual(file, rootCwd) ? rootCwd : undefined),
      command: entry.command,
      env: entry.env,
      spawn: async (root) => {
        const spawned = await spawnCommand(entry.command!, entry.env)(root);
        return spawned ? { ...spawned, initOptions: entry.initialization } : undefined;
      },
    });
  }

  return servers;
}

function lspServersFor(cwd: string): LSPServerConfig[] {
  const configured = loadCustomServerConfig(cwd);
  const disabled = new Set(Object.entries(configured).filter(([, entry]) => entry.disabled).map(([id]) => id));
  return [...customServerConfigs(cwd), ...LSP_SERVERS.filter((server) => !disabled.has(server.id)), ...registryRuntimeServerConfigs().filter((server) => !disabled.has(server.id))];
}

// Manager registry. Keep managers scoped by cwd so two sessions in one process do not
// accidentally tear down each other's language servers.
const managers = new Map<string, LSPManager>();

function managerKey(cwd: string): string {
  return normalizeFsPath(path.resolve(cwd));
}

export function getOrCreateManager(cwd: string): LSPManager {
  const key = managerKey(cwd);
  const existing = managers.get(key);
  if (existing) return existing;

  const manager = new LSPManager(key);
  managers.set(key, manager);
  return manager;
}

export async function shutdownManager(cwd?: string): Promise<void> {
  if (cwd) {
    const key = managerKey(cwd);
    const manager = managers.get(key);
    if (!manager) return;
    managers.delete(key);
    await manager.shutdown();
    return;
  }

  const all = Array.from(managers.values());
  managers.clear();
  await Promise.all(all.map((manager) => manager.shutdown()));
}

// LSP Manager
export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private startingProcesses = new Set<ChildProcessWithoutNullStreams>();
  private broken = new Set<string>();
  private lastFailures = new Map<string, string>();
  private cwd: string;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.cleanupTimer = setInterval(() => this.cleanupIdleFiles(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private cleanupIdleFiles() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      for (const [fp, state] of client.openFiles) {
        if (now - state.lastAccess > IDLE_TIMEOUT_MS) this.closeFile(client, fp);
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string) {
    if (!client.openFiles.has(absPath)) return;
    client.openFiles.delete(absPath);
    if (client.closed) return;
    try {
      void client.connection
        .sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri: pathToFileURL(absPath).href },
        })
        .catch(() => {});
    } catch {}
  }

  private evictLRU(client: LSPClient) {
    if (client.openFiles.size <= MAX_OPEN_FILES) return;
    let oldest: { path: string; time: number } | null = null;
    for (const [fp, s] of client.openFiles) {
      if (!oldest || s.lastAccess < oldest.time) oldest = { path: fp, time: s.lastAccess };
    }
    if (oldest) this.closeFile(client, oldest.path);
  }

  private key(id: string, root: string) {
    return `${id}:${root}`;
  }

  private recordFailure(key: string, message: string, stderr?: string[]): void {
    const stderrTail = stderr?.length ? `\nstderr:\n${stderr.slice(-20).join("\n")}` : "";
    this.lastFailures.set(key, `${message}${stderrTail}`);
    this.broken.add(key);
  }

  private clearFailure(key: string): void {
    this.lastFailures.delete(key);
    this.broken.delete(key);
  }

  private async lspRequest<T>(client: LSPClient, request: unknown, params: unknown, name: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const k = this.key(client.serverId, client.root);
    if (client.closed) {
      this.recordFailure(k, `${client.serverId} language server connection is closed.`, client.stderr);
      throw new LspConnectionClosedError(client.serverId, client.root);
    }
    if (client.process.exitCode !== null) {
      const error = new LspProcessExitedError(client.serverId, client.root, client.process.exitCode, client.stderr.slice(-20).join("\n"));
      this.recordFailure(k, error.message, client.stderr);
      client.closed = true;
      this.clients.delete(k);
      throw error;
    }

    let cleanupExitListener: (() => void) | undefined;
    try {
      const processExit = new Promise<never>((_resolve, reject) => {
        const onExit = () => {
          cleanupExitListener?.();
          reject(new LspProcessExitedError(client.serverId, client.root, client.process.exitCode, client.stderr.slice(-20).join("\n")));
        };
        cleanupExitListener = () => client.process.off("exit", onExit);
        client.process.once("exit", onExit);
      });
      return await timeout(Promise.race([client.connection.sendRequest(request as never, params as never) as Promise<T>, processExit]), timeoutMs, name);
    } catch (error) {
      if (client.closed) {
        this.recordFailure(k, `${client.serverId} language server connection closed during ${name}.`, client.stderr);
        throw new LspConnectionClosedError(client.serverId, client.root);
      }
      if (client.process.exitCode !== null) {
        const exited = new LspProcessExitedError(client.serverId, client.root, client.process.exitCode, client.stderr.slice(-20).join("\n"));
        this.recordFailure(k, exited.message, client.stderr);
        client.closed = true;
        this.clients.delete(k);
        throw exited;
      }
      throw error;
    } finally {
      cleanupExitListener?.();
    }
  }

  describeUnavailableForFile(filePath: string): string | undefined {
    const absPath = this.resolve(filePath);

    for (const config of lspServersFor(this.cwd)) {
      if (!serverMatchesFile(config, absPath)) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) return this.explainNoLsp(absPath);

      const k = this.key(config.id, root);
      return this.lastFailures.get(k) || (this.broken.has(k) ? `${config.id} language server is unavailable for ${root}` : undefined);
    }

    return this.explainNoLsp(absPath);
  }

  private async initClient(config: LSPServerConfig, root: string): Promise<LSPClient | undefined> {
    const k = this.key(config.id, root);
    let processHandle: ChildProcessWithoutNullStreams | undefined;
    let stderr: string[] = [];
    try {
      if (this.closed) return undefined;
      const handle = await config.spawn(root);
      if (!handle) {
        this.recordFailure(k, `Project root detected, but no ${config.id} language-server binary was found or it exited immediately.`);
        return undefined;
      }
      processHandle = handle.process;
      this.startingProcesses.add(processHandle);
      if (this.closed) {
        try {
          processHandle.kill();
        } catch {}
        return undefined;
      }

      const reader = new StreamMessageReader(handle.process.stdout!);
      const writer = new StreamMessageWriter(handle.process.stdin!);
      const conn = createMessageConnection(reader, writer);

      handle.process.stdin?.on("error", () => {});
      handle.process.stdout?.on("error", () => {});

      stderr = [];
      const MAX_STDERR_LINES = 200;
      handle.process.stderr?.on("data", (chunk: Buffer) => {
        try {
          const text = chunk.toString("utf-8");
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            stderr.push(line);
            if (stderr.length > MAX_STDERR_LINES) stderr.splice(0, stderr.length - MAX_STDERR_LINES);
          }
        } catch {}
      });
      handle.process.stderr?.on("error", () => {});

      const client: LSPClient = {
        serverId: config.id,
        connection: conn,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        listeners: new Map(),
        stderr,
        root,
        closed: false,
      };

      conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
        const fpRaw = uriToPath(params.uri);
        const fp = normalizeFsPath(fpRaw);
        const currentVersion = client.openFiles.get(fp)?.version ?? client.openFiles.get(fpRaw)?.version;
        if (typeof params.version === "number" && typeof currentVersion === "number" && params.version < currentVersion) return;

        client.diagnostics.set(fp, params.diagnostics);

        const listeners1 = client.listeners.get(fp);
        const listeners2 = fp !== fpRaw ? client.listeners.get(fpRaw) : undefined;

        listeners1?.slice().forEach((fn) => {
          try {
            fn();
          } catch {}
        });
        listeners2?.slice().forEach((fn) => {
          try {
            fn();
          } catch {}
        });
      });

      conn.onError(() => {});
      conn.onClose(() => {
        client.closed = true;
        this.clients.delete(k);
      });

      conn.onRequest("workspace/configuration", () => [handle.initOptions ?? {}]);
      conn.onRequest("window/workDoneProgress/create", () => null);
      conn.onRequest("client/registerCapability", () => {});
      conn.onRequest("client/unregisterCapability", () => {});
      conn.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: pathToFileURL(root).href }]);

      handle.process.on("exit", () => {
        client.closed = true;
        this.clients.delete(k);
      });
      handle.process.on("error", () => {
        client.closed = true;
        this.clients.delete(k);
        this.broken.add(k);
      });

      conn.listen();

      const initResult = await timeout(
        conn.sendRequest(InitializeRequest.method, {
          rootUri: pathToFileURL(root).href,
          rootPath: root,
          processId: process.pid,
          workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
          initializationOptions: handle.initOptions ?? {},
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true },
            textDocument: {
              synchronization: { didSave: true, didOpen: true, didChange: true, didClose: true },
              publishDiagnostics: { versionSupport: true },
              diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            },
          },
        }),
        INIT_TIMEOUT_MS,
        `${config.id} init`
      );

      client.capabilities = (initResult as { capabilities?: unknown })?.capabilities;

      conn.sendNotification(InitializedNotification.type, {});
      if (handle.initOptions) {
        conn.sendNotification("workspace/didChangeConfiguration", { settings: handle.initOptions });
      }
      if (this.closed) {
        client.closed = true;
        try {
          client.connection.end();
        } catch {}
        try {
          client.process.kill();
        } catch {}
        return undefined;
      }
      this.clearFailure(k);
      return client;
    } catch (e) {
      if (processHandle) {
        try {
          processHandle.kill();
        } catch {}
      }
      this.recordFailure(k, e instanceof Error ? e.message : String(e), stderr);
      return undefined;
    } finally {
      if (processHandle) this.startingProcesses.delete(processHandle);
    }
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of lspServersFor(this.cwd)) {
      if (!serverMatchesFile(config, absPath)) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;
      const k = this.key(config.id, root);
      if (this.broken.has(k)) continue;

      const existing = this.clients.get(k);
      if (existing) {
        clients.push(existing);
        continue;
      }

      if (!this.spawning.has(k)) {
        const p = this.initClient(config, root);
        this.spawning.set(k, p);
        p.finally(() => this.spawning.delete(k));
      }
      const client = await this.spawning.get(k);
      if (client) {
        this.clients.set(k, client);
        clients.push(client);
      }
    }
    return clients;
  }

  private resolve(fp: string) {
    const abs = path.isAbsolute(fp) ? fp : path.resolve(this.cwd, fp);
    return normalizeFsPath(abs);
  }

  private langId(fp: string) {
    return languageIdForFile(fp);
  }

  private readFile(fp: string): string | null {
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      return null;
    }
  }

  private explainNoLsp(absPath: string): string {
    return explainNoLspReason(this.cwd, absPath);
  }

  private toPos(line: number, col: number) {
    return { line: Math.max(0, line - 1), character: Math.max(0, col - 1) };
  }

  private normalizeLocs(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (!items.length) return [];
    if ("uri" in items[0] && "range" in items[0]) return items as Location[];
    return (items as LocationLink[]).map((l) => ({ uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange }));
  }

  private normalizeSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined): DocumentSymbol[] {
    if (!result?.length) return [];
    const first = result[0];
    if ("location" in first) {
      return (result as SymbolInformation[]).map((s) => ({
        name: s.name,
        kind: s.kind,
        range: s.location.range,
        selectionRange: s.location.range,
        detail: s.containerName,
        tags: s.tags,
        children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  private async openOrUpdate(clients: LSPClient[], absPath: string, uri: string, langId: string, content: string, evict = true) {
    const now = Date.now();
    for (const client of clients) {
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      try {
        if (state) {
          const v = state.version + 1;
          client.openFiles.set(absPath, { version: v, lastAccess: now, text: content });
          void client.connection
            .sendNotification(DidChangeTextDocumentNotification.type, {
              textDocument: { uri, version: v },
              contentChanges: [{ text: content }],
            })
            .catch(() => {});
        } else {
          client.openFiles.set(absPath, { version: 0, lastAccess: now, text: content });
          void client.connection
            .sendNotification(DidOpenTextDocumentNotification.type, {
              textDocument: { uri, languageId: langId, version: 0, text: content },
            })
            .catch(() => {});
          if (evict) this.evictLRU(client);
        }
        void client.connection
          .sendNotification(DidSaveTextDocumentNotification.type, {
            textDocument: { uri },
            text: content,
          })
          .catch(() => {});
      } catch {}
    }
  }

  private async loadFile(filePath: string) {
    const absPath = this.resolve(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return null;
    const content = this.readFile(absPath);
    if (content === null) return null;
    return { clients, absPath, uri: pathToFileURL(absPath).href, langId: this.langId(absPath), content };
  }

  private waitForDiagnostics(client: LSPClient, absPath: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (client.closed) return resolve(false);

      let resolved = false;
      let settleTimer: NodeJS.Timeout | null = null;
      let listener: () => void = () => {};

      const cleanupListener = () => {
        const listeners = client.listeners.get(absPath);
        if (!listeners) return;
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        if (listeners.length === 0) client.listeners.delete(absPath);
      };

      const finish = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(timer);
        cleanupListener();
        resolve(value);
      };

      listener = () => {
        if (resolved) return;

        const current = client.diagnostics.get(absPath);
        if (current && current.length > 0) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(true), 50);
          return;
        }

        if (settleTimer) clearTimeout(settleTimer);
        const emptySettleMs = client.serverId === "rust-analyzer" ? 2500 : 300;
        settleTimer = setTimeout(() => finish(true), emptySettleMs);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);

      const listeners = client.listeners.get(absPath) || [];
      listeners.push(listener);
      client.listeners.set(absPath, listeners);
    });
  }

  private async pullDiagnostics(client: LSPClient, absPath: string, uri: string): Promise<{ diagnostics: Diagnostic[]; responded: boolean }> {
    if (client.closed) return { diagnostics: [], responded: false };

    if (!client.capabilities || !(client.capabilities as { diagnosticProvider?: unknown }).diagnosticProvider) {
      return { diagnostics: [], responded: false };
    }

    try {
      const res = (await this.lspRequest(client, DocumentDiagnosticRequest.method, {
        textDocument: { uri },
      }, "document diagnostics")) as { kind?: string; items?: Diagnostic[] };

      if (res?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(res.items) ? res.items : [], responded: true };
      }
      if (res?.kind === DocumentDiagnosticReportKind.Unchanged) {
        return { diagnostics: client.diagnostics.get(absPath) || [], responded: true };
      }
      if (Array.isArray(res?.items)) {
        return { diagnostics: res.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {}

    try {
      const res = (await this.lspRequest(client, WorkspaceDiagnosticRequest.method, {
        previousResultIds: [],
      }, "workspace diagnostics")) as { items?: Array<{ uri?: string; kind?: string; items?: Diagnostic[] }> };

      const items = res?.items || [];
      const match = items.find((it) => it?.uri === uri);
      if (match?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(match.items) ? match.items : [], responded: true };
      }
      if (Array.isArray(match?.items)) {
        return { diagnostics: match.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      return { diagnostics: [], responded: false };
    }
  }

  async touchFileAndWait(filePath: string, timeoutMs: number): Promise<{ diagnostics: Diagnostic[]; receivedResponse: boolean; unsupported?: boolean; error?: string }> {
    const absPath = this.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: "File not found" };
    }

    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: this.describeUnavailableForFile(absPath) ?? this.explainNoLsp(absPath) };
    }

    const content = this.readFile(absPath);
    if (content === null) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: "Could not read file" };
    }

    const cachedDiagnostics = clients
      .filter((c) => c.openFiles.get(absPath)?.text === content && c.diagnostics.has(absPath))
      .flatMap((c) => c.diagnostics.get(absPath) ?? []);
    if (cachedDiagnostics.length || clients.some((c) => c.openFiles.get(absPath)?.text === content && c.diagnostics.has(absPath))) {
      return { diagnostics: cachedDiagnostics, receivedResponse: true };
    }

    const uri = pathToFileURL(absPath).href;
    const langId = this.langId(absPath);
    for (const c of clients) c.diagnostics.delete(absPath);

    const waits = clients.map((c) => this.waitForDiagnostics(c, absPath, timeoutMs));
    await this.openOrUpdate(clients, absPath, uri, langId, content);
    const results = await Promise.all(waits);

    let responded = results.some((r) => r);
    let diags: Diagnostic[] = [];
    for (const c of clients) {
      const d = c.diagnostics.get(absPath);
      if (d) diags.push(...d);
    }
    if (!responded && clients.some((c) => c.diagnostics.has(absPath))) responded = true;

    if (!responded) {
      const pulled = await Promise.all(clients.map((c) => this.pullDiagnostics(c, absPath, uri)));
      const pulledDiags: Diagnostic[] = [];
      let pulledResponded = false;
      for (let i = 0; i < clients.length; i++) {
        const r = pulled[i];
        if (!r.responded) continue;
        pulledResponded = true;
        responded = true;
        clients[i].diagnostics.set(absPath, r.diagnostics);
        pulledDiags.push(...r.diagnostics);
      }
      if (pulledResponded) diags = pulledDiags;
    }

    return { diagnostics: diags, receivedResponse: responded };
  }

  async getDiagnosticsForFiles(files: string[], timeoutMs: number): Promise<FileDiagnosticsResult> {
    const unique = [...new Set(files.map((f) => this.resolve(f)))];
    const results: FileDiagnosticItem[] = [];
    const toClose: Map<LSPClient, string[]> = new Map();

    for (const absPath of unique) {
      if (!fs.existsSync(absPath)) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "File not found" });
        continue;
      }

      let clients: LSPClient[];
      try {
        clients = await this.getClientsForFile(absPath);
      } catch (e) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: String(e) });
        continue;
      }

      if (!clients.length) {
        results.push({ file: absPath, diagnostics: [], status: "unsupported", error: this.describeUnavailableForFile(absPath) ?? this.explainNoLsp(absPath) });
        continue;
      }

      const content = this.readFile(absPath);
      if (content === null) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "Could not read file" });
        continue;
      }

      const cachedDiagnostics = clients
        .filter((c) => c.openFiles.get(absPath)?.text === content && c.diagnostics.has(absPath))
        .flatMap((c) => c.diagnostics.get(absPath) ?? []);
      if (cachedDiagnostics.length || clients.some((c) => c.openFiles.get(absPath)?.text === content && c.diagnostics.has(absPath))) {
        results.push({ file: absPath, diagnostics: cachedDiagnostics, status: "ok" });
        continue;
      }

      const uri = pathToFileURL(absPath).href;
      const langId = this.langId(absPath);
      for (const c of clients) c.diagnostics.delete(absPath);

      for (const c of clients) {
        if (!c.openFiles.has(absPath)) {
          if (!toClose.has(c)) toClose.set(c, []);
          toClose.get(c)!.push(absPath);
        }
      }

      const waits = clients.map((c) => this.waitForDiagnostics(c, absPath, timeoutMs));
      await this.openOrUpdate(clients, absPath, uri, langId, content, false);
      const waitResults = await Promise.all(waits);

      let diags: Diagnostic[] = [];
      for (const c of clients) {
        const d = c.diagnostics.get(absPath);
        if (d) diags.push(...d);
      }

      let responded = waitResults.some((r) => r) || diags.length > 0;

      if (!responded) {
        const pulled = await Promise.all(clients.map((c) => this.pullDiagnostics(c, absPath, uri)));
        const pulledDiags: Diagnostic[] = [];
        let pulledResponded = false;
        for (let i = 0; i < clients.length; i++) {
          const r = pulled[i];
          if (!r.responded) continue;
          pulledResponded = true;
          responded = true;
          clients[i].diagnostics.set(absPath, r.diagnostics);
          pulledDiags.push(...r.diagnostics);
        }
        if (pulledResponded) diags = pulledDiags;
      }

      if (!responded && !diags.length) {
        results.push({ file: absPath, diagnostics: [], status: "timeout", error: "LSP did not respond" });
      } else {
        results.push({ file: absPath, diagnostics: diags, status: "ok" });
      }
    }

    for (const [c, fps] of toClose) {
      for (const fp of fps) this.closeFile(c, fp);
    }
    for (const c of this.clients.values()) {
      while (c.openFiles.size > MAX_OPEN_FILES) this.evictLRU(c);
    }

    return { items: results };
  }

  async getDefinition(fp: string, line: number, col: number): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeLocs(await this.lspRequest(c, DefinitionRequest.type, { textDocument: { uri: l.uri }, position: pos }, "definition"));
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  }

  async getReferences(fp: string, line: number, col: number): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeLocs(await this.lspRequest(c, ReferencesRequest.type, { textDocument: { uri: l.uri }, position: pos, context: { includeDeclaration: true } }, "references"));
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  }

  async getHover(fp: string, line: number, col: number): Promise<Hover | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = await this.lspRequest<Hover | null>(c, HoverRequest.type, { textDocument: { uri: l.uri }, position: pos }, "hover");
        if (r) return r;
      } catch {}
    }
    return null;
  }

  async getSignatureHelp(fp: string, line: number, col: number): Promise<SignatureHelp | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = await this.lspRequest<SignatureHelp | null>(c, SignatureHelpRequest.type, { textDocument: { uri: l.uri }, position: pos }, "signature help");
        if (r) return r;
      } catch {}
    }
    return null;
  }

  async getDocumentSymbols(fp: string): Promise<DocumentSymbol[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeSymbols(await this.lspRequest(c, DocumentSymbolRequest.type, { textDocument: { uri: l.uri } }, "document symbols"));
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  }

  async rename(fp: string, line: number, col: number, newName: string): Promise<WorkspaceEdit | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = await this.lspRequest<WorkspaceEdit | null>(c, RenameRequest.type, {
          textDocument: { uri: l.uri },
          position: pos,
          newName,
        }, "rename");
        if (r) return r;
      } catch {}
    }
    return null;
  }

  async getCodeActions(fp: string, startLine: number, startCol: number, endLine?: number, endCol?: number): Promise<(CodeAction | Command)[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);

    const start = this.toPos(startLine, startCol);
    const end = this.toPos(endLine ?? startLine, endCol ?? startCol);
    const range = { start, end };

    const diagnostics: Diagnostic[] = [];
    for (const c of l.clients) {
      const fileDiags = c.diagnostics.get(l.absPath) || [];
      for (const d of fileDiags) {
        if (this.rangesOverlap(d.range, range)) diagnostics.push(d);
      }
    }

    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          const r = await this.lspRequest<(CodeAction | Command)[] | null>(c, CodeActionRequest.type, {
            textDocument: { uri: l.uri },
            range,
            context: { diagnostics, only: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source] },
          }, "code actions");
          return r || [];
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  }

  private rangesOverlap(
    a: { start: { line: number; character: number }; end: { line: number; character: number } },
    b: { start: { line: number; character: number }; end: { line: number; character: number } }
  ): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
  }

  getSnapshot(): LspClientSnapshot[] {
    return Array.from(this.clients.values())
      .map((client) => ({
        root: client.root,
        serverId: client.serverId,
        openFiles: client.openFiles.size,
        alive: !client.closed && client.process.exitCode === null,
        command: client.process.spawnargs ?? [],
      }))
      .sort((a, b) => `${a.serverId}:${a.root}`.localeCompare(`${b.serverId}:${b.root}`));
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const proc of Array.from(this.startingProcesses)) {
      try {
        proc.kill();
      } catch {}
    }
    this.startingProcesses.clear();
    this.spawning.clear();

    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const c of clients) {
      const wasClosed = c.closed;
      c.closed = true;
      if (!wasClosed) {
        try {
          await Promise.race([c.connection.sendRequest("shutdown"), new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS))]);
        } catch {}
        try {
          void c.connection.sendNotification("exit").catch(() => {});
        } catch {}
      }
      try {
        c.connection.end();
      } catch {}
      try {
        c.process.kill();
      } catch {}
    }
  }
}

// Diagnostic Formatting
export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

function diagnosticSeverityLabel(severity: Diagnostic["severity"]): string {
  return severity === 1 ? "ERROR" : severity === 2 ? "WARN" : severity === 3 ? "INFO" : severity === 4 ? "HINT" : "DIAG";
}

export function formatDiagnostic(d: Diagnostic): string {
  const sev = diagnosticSeverityLabel(d.severity);
  return `${sev} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}

export function filterDiagnosticsBySeverity(diags: Diagnostic[], filter: SeverityFilter): Diagnostic[] {
  if (filter === "all") return diags;
  const max = { error: 1, warning: 2, info: 3, hint: 4 }[filter];
  return diags.filter((d) => typeof d.severity === "number" && d.severity <= max);
}

// URI utilities
export function uriToPath(uri: string): string {
  if (uri.startsWith("file://"))
    try {
      return fileURLToPath(uri);
    } catch {}
  return uri;
}

// Symbol search
function findSymbolPosition(symbols: DocumentSymbol[], query: string): { line: number; character: number } | null {
  const q = query.toLowerCase();
  let exact: { line: number; character: number } | null = null;
  let partial: { line: number; character: number } | null = null;

  const visit = (items: DocumentSymbol[]) => {
    for (const sym of items) {
      const name = String(sym?.name ?? "").toLowerCase();
      const pos = sym?.selectionRange?.start ?? sym?.range?.start;
      if (pos && typeof pos.line === "number" && typeof pos.character === "number") {
        if (!exact && name === q) exact = pos;
        if (!partial && name.includes(q)) partial = pos;
      }
      if (sym?.children?.length) visit(sym.children);
    }
  };
  visit(symbols);
  return exact ?? partial;
}

export async function resolvePosition(manager: LSPManager, file: string, query: string): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  const pos = findSymbolPosition(symbols, query);
  return pos ? { line: pos.line + 1, column: pos.character + 1 } : null;
}
