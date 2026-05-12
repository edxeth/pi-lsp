import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePiPaths } from "./lsp-paths.js";
import { getRegistryEntry, type LspRegistryEntry, type RepairSpec } from "./lsp-registry.js";

export interface InstallPlan {
  entry: LspRegistryEntry;
  spec: RepairSpec;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  targetBin?: string;
  description: string;
}

export interface InstallResult {
  ok: boolean;
  plan: InstallPlan;
  output: string;
  binary?: string;
  error?: string;
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
  return JSON.stringify(arg);
}

export function formatCommand(command: string[]): string {
  return command.map(quoteArg).join(" ");
}

function commandBase(command: string): string {
  const base = path.basename(command).toLowerCase();
  return base.endsWith(".cmd") || base.endsWith(".exe") ? base.replace(/\.(cmd|exe)$/i, "") : base;
}

export function buildNodeInstallCommand(npmCommand: string[] | undefined, packages: string[]): string[] {
  const command = npmCommand?.length ? npmCommand : [process.platform === "win32" ? "npm.cmd" : "npm"];
  const knownManagers = new Set(["npm", "bun", "pnpm", "yarn"]);
  const base = [...command]
    .reverse()
    .map(commandBase)
    .find((item) => knownManagers.has(item)) ?? commandBase(command[0] ?? "npm");

  if (base === "bun" || base === "pnpm" || base === "yarn") return [...command, "add", ...packages];
  if (base === "npm") return [...command, "install", ...packages];

  // Unknown wrappers are treated as npm-compatible only when they are explicitly
  // configured. The exact command is always shown before execution.
  return [...command, "install", ...packages];
}

export function parseNpmCommand(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0) return value;
  if (typeof value === "string" && value.trim()) return value.trim().split(/\s+/);
  return undefined;
}

function readConfiguredNpmCommand(settingsPath = resolvePiPaths().settingsPath): string[] | undefined {
  try {
    if (!fs.existsSync(settingsPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return parseNpmCommand(parsed.npmCommand);
  } catch {
    return undefined;
  }
}

function nodeToolDir(serverId: string): string {
  return path.join(resolvePiPaths().lspCacheDir, "node", serverId);
}

export function buildInstallPlan(entry: LspRegistryEntry, npmCommand = readConfiguredNpmCommand()): InstallPlan | undefined {
  const piPaths = resolvePiPaths();
  const spec = entry.repair;

  if (spec.kind === "manual") return undefined;

  if (spec.kind === "tool-cache-node-package") {
    const cwd = nodeToolDir(entry.id);
    return {
      entry,
      spec,
      command: buildNodeInstallCommand(npmCommand, spec.packages),
      cwd,
      targetBin: path.join(piPaths.lspBinDir, spec.bin + (process.platform === "win32" ? ".cmd" : "")),
      description: `Install ${entry.displayName} language server into Pi LSP cache`,
    };
  }

  return {
    entry,
    spec,
    command: ["go", "install", spec.module],
    cwd: piPaths.lspCacheDir,
    env: { GOBIN: piPaths.lspBinDir },
    targetBin: path.join(piPaths.lspBinDir, spec.bin + (process.platform === "win32" ? ".exe" : "")),
    description: `Install ${entry.displayName} language server into Pi LSP cache`,
  };
}

export function formatRepairBlock(serverId: string | undefined): string[] {
  const entry = getRegistryEntry(serverId);
  if (!entry) return ["", "Repair: no known automatic repair for this server."];
  const spec = entry.repair;
  if (spec.kind === "manual") return ["", "Repair:", `  ${spec.hint}`];

  const plan = buildInstallPlan(entry);
  if (!plan) return ["", "Repair: no automatic repair plan available."];
  return [
    "",
    "Repair available:",
    `  ${plan.description}`,
    "",
    "Command:",
    `  ${formatCommand(plan.command)}`,
    "Working directory:",
    `  ${plan.cwd}`,
    "",
    `Run: /lsp-install ${entry.id}`,
  ];
}

async function runCommand(plan: InstallPlan): Promise<{ exitCode: number | null; output: string; error?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(plan.command[0], plan.command.slice(1), {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => resolve({ exitCode: null, output, error: error.message }));
    child.on("exit", (exitCode) => resolve({ exitCode, output }));
  });
}

function ensurePackageJson(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ private: true, dependencies: {} }, null, 2) + "\n", "utf-8");
  }
}

function linkBinary(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.rmSync(target, { force: true });
  } catch {}
  try {
    fs.symlinkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
    try {
      fs.chmodSync(target, 0o755);
    } catch {}
  }
}

function installedNodeBin(plan: InstallPlan): string | undefined {
  if (plan.spec.kind !== "tool-cache-node-package") return undefined;
  const ext = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(plan.cwd, "node_modules", ".bin", plan.spec.bin + ext);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export async function installLspServer(serverId: string, npmCommand = readConfiguredNpmCommand()): Promise<InstallResult> {
  const entry = getRegistryEntry(serverId);
  if (!entry) {
    const hint = "No known repair metadata is registered for this server.";
    const fallbackRepair: RepairSpec = { kind: "manual", hint };
    const fallback: LspRegistryEntry = {
      id: serverId,
      displayName: serverId,
      extensions: [],
      languageIds: {},
      repair: fallbackRepair,
    };
    return { ok: false, plan: { entry: fallback, spec: fallbackRepair, command: [], cwd: process.cwd(), description: hint }, output: "", error: hint };
  }

  const plan = buildInstallPlan(entry, npmCommand);
  if (!plan) {
    const hint = entry.repair.kind === "manual" ? entry.repair.hint : "No automatic repair plan available.";
    return { ok: false, plan: { entry, spec: entry.repair, command: [], cwd: process.cwd(), description: hint }, output: "", error: hint };
  }

  if (plan.spec.kind === "tool-cache-node-package") ensurePackageJson(plan.cwd);
  else fs.mkdirSync(plan.cwd, { recursive: true });
  fs.mkdirSync(resolvePiPaths().lspBinDir, { recursive: true });

  const result = await runCommand(plan);
  if (result.error || result.exitCode !== 0) {
    return { ok: false, plan, output: result.output, error: result.error ?? `Command exited with ${result.exitCode}` };
  }

  let binary = plan.targetBin;
  if (plan.spec.kind === "tool-cache-node-package") {
    const source = installedNodeBin(plan);
    if (!source || !plan.targetBin) return { ok: false, plan, output: result.output, error: `Installed package, but ${plan.spec.bin} was not found.` };
    linkBinary(source, plan.targetBin);
    binary = plan.targetBin;
  }

  if (binary && !fs.existsSync(binary)) return { ok: false, plan, output: result.output, error: `Installed, but ${binary} was not found.` };
  return { ok: true, plan, output: result.output, binary };
}
