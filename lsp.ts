/**
 * LSP Hook Extension
 *
 * Provides automatic diagnostics feedback (default: agent end).
 * Can run after each write/edit or once per agent response.
 *
 * Usage: /lsp to configure hook mode
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Diagnostic } from "vscode-languageserver-protocol";
import { LSP_SERVERS, diagnosticSeverityLabel, formatDiagnostic, getOrCreateManager, inspectLspForFile, shutdownManager } from "./lsp-core.js";

type HookScope = "session" | "global";
type HookMode = "edit_write" | "agent_end" | "disabled";

const DIAGNOSTICS_WAIT_MS_DEFAULT = 3000;

function diagnosticsWaitMsForFile(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".go") return 20000;
  if (ext === ".rs") return 20000;
  return DIAGNOSTICS_WAIT_MS_DEFAULT;
}

const DIAGNOSTICS_PREVIEW_LINES = 10;
const LSP_IDLE_SHUTDOWN_MS = 60_000;
const DEFAULT_HOOK_MODE: HookMode = "agent_end";
const SETTINGS_NAMESPACE = "lsp";
const LSP_CONFIG_ENTRY = "lsp-hook-config";

const MODE_LABELS: Record<HookMode, string> = {
  edit_write: "After each edit/write",
  agent_end: "At agent end",
  disabled: "Disabled",
};

function normalizeHookMode(value: unknown): HookMode | undefined {
  if (value === "edit_write" || value === "agent_end" || value === "disabled") return value;
  if (value === "turn_end") return "agent_end";
  return undefined;
}

interface HookConfigEntry {
  scope: HookScope;
  hookMode?: HookMode;
}

interface DiagnosticsContext {
  cwd: string;
  hasUI: boolean;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}

export default function (pi: ExtensionAPI) {
  type LspActivity = "idle" | "loading" | "working";

  let activeClients: Set<string> = new Set();
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;
  let hookMode: HookMode = DEFAULT_HOOK_MODE;
  let hookScope: HookScope = "global";
  let activity: LspActivity = "idle";
  let diagnosticsAbort: AbortController | null = null;
  let shuttingDown = false;
  let idleShutdownTimer: NodeJS.Timeout | null = null;

  const touchedFiles: Map<string, boolean> = new Map();
  const pendingBashFiles: Map<string, string[]> = new Map();
  const scheduledDiagnostics: Map<string, NodeJS.Timeout> = new Map();
  const lastDiagnosticReports: Map<string, string> = new Map();
  const bashReportedFiles: Set<string> = new Set();
  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

  function readSettingsFile(filePath: string): { ok: true; settings: Record<string, unknown> } | { ok: false; error: string; missing?: boolean } {
    try {
      if (!fs.existsSync(filePath)) return { ok: true, settings: {} };
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "Settings file must contain a JSON object." };
      return { ok: true, settings: parsed as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, filePath);
  }

  function getGlobalHookMode(): HookMode | undefined {
    const read = readSettingsFile(globalSettingsPath);
    if (!read.ok) return undefined;
    const settings = read.settings;
    const lspSettings = settings[SETTINGS_NAMESPACE];
    const hookValue = (lspSettings as { hookMode?: unknown; hookEnabled?: unknown } | undefined)?.hookMode;
    const normalized = normalizeHookMode(hookValue);
    if (normalized) return normalized;

    const legacyEnabled = (lspSettings as { hookEnabled?: unknown } | undefined)?.hookEnabled;
    if (typeof legacyEnabled === "boolean") return legacyEnabled ? "edit_write" : "disabled";
    return undefined;
  }

  function setGlobalHookMode(mode: HookMode): { ok: true } | { ok: false; error: string } {
    try {
      const read = readSettingsFile(globalSettingsPath);
      if (!read.ok) return { ok: false, error: `Could not parse ${globalSettingsPath}: ${read.error}` };

      const settings = read.settings;
      const existing = settings[SETTINGS_NAMESPACE];
      const nextNamespace =
        existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>), hookMode: mode } : { hookMode: mode };

      settings[SETTINGS_NAMESPACE] = nextNamespace;
      writeJsonAtomic(globalSettingsPath, settings);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function getLastHookEntry(ctx: ExtensionContext): HookConfigEntry | undefined {
    const branchEntries = ctx.sessionManager.getBranch();
    let latest: HookConfigEntry | undefined;

    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === LSP_CONFIG_ENTRY) {
        latest = entry.data as HookConfigEntry | undefined;
      }
    }

    return latest;
  }

  function restoreHookState(ctx: ExtensionContext): void {
    const entry = getLastHookEntry(ctx);
    if (entry?.scope === "session") {
      const normalized = normalizeHookMode(entry.hookMode);
      if (normalized) {
        hookMode = normalized;
        hookScope = "session";
        return;
      }

      const legacyEnabled = (entry as { hookEnabled?: unknown }).hookEnabled;
      if (typeof legacyEnabled === "boolean") {
        hookMode = legacyEnabled ? "edit_write" : "disabled";
        hookScope = "session";
        return;
      }
    }

    const globalSetting = getGlobalHookMode();
    hookMode = globalSetting ?? DEFAULT_HOOK_MODE;
    hookScope = "global";
  }

  function persistHookEntry(entry: HookConfigEntry): void {
    pi.appendEntry<HookConfigEntry>(LSP_CONFIG_ENTRY, entry);
  }

  function labelForMode(mode: HookMode): string {
    return MODE_LABELS[mode];
  }

  function messageContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) =>
          item && typeof item === "object" && "type" in item && (item as { type: string }).type === "text"
            ? String((item as { text?: string }).text ?? "")
            : ""
        )
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  function formatDiagnosticsForDisplay(text: string): string {
    return text
      .replace(/\n?This file has LSP (?:errors; please fix them|diagnostics; please review them)\n/gi, "\n")
      .replace(/\n?This file has errors, please fix\n/gi, "\n")
      .replace(/<\/?file_diagnostics>\n?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function styleDiagnosticDisplayLine(line: string, theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>>[2]): string {
    if (line.startsWith("File: ")) return theme.fg("muted", line);
    if (/^(ERROR|FATAL)\b/i.test(line) || /\bLSP errors?\b/i.test(line)) return theme.fg("error", line);
    if (/^(WARN|WARNING)\b/i.test(line) || /\bLSP unavailable\b/i.test(line)) return theme.fg("warning", line);
    if (/^(INFO|HINT)\b/i.test(line)) return theme.fg("muted", line);
    return theme.fg("toolOutput", line);
  }

  function setActivity(next: LspActivity): void {
    activity = next;
    updateLspStatus();
  }

  function clearIdleShutdownTimer(): void {
    if (!idleShutdownTimer) return;
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }

  async function shutdownLspServersForIdle(): Promise<void> {
    diagnosticsAbort?.abort();
    diagnosticsAbort = null;
    setActivity("idle");

    await shutdownManager();
    activeClients.clear();
    updateLspStatus();
  }

  function scheduleIdleShutdown(): void {
    clearIdleShutdownTimer();

    idleShutdownTimer = setTimeout(() => {
      idleShutdownTimer = null;
      if (shuttingDown) return;
      void shutdownLspServersForIdle();
    }, LSP_IDLE_SHUTDOWN_MS);

    (idleShutdownTimer as NodeJS.Timeout & { unref?: () => void }).unref?.();
  }

  function updateLspStatus(): void {
    if (!statusUpdateFn) return;

    const clients = activeClients.size > 0 ? [...activeClients].join(", ") : "";
    const activityHint = activity === "idle" ? "" : "•";

    if (hookMode === "disabled") {
      const text = clients ? `LSP (tool): ${clients}` : "LSP (tool)";
      statusUpdateFn("lsp", text);
      return;
    }

    let text = "LSP";
    if (activityHint) text += ` ${activityHint}`;
    if (clients) text += ` ${clients}`;
    statusUpdateFn("lsp", text);
  }

  function normalizeFilePath(filePath: string, cwd: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  }

  function snapshotDiagnosticsContext(ctx: ExtensionContext): DiagnosticsContext {
    const cwd = ctx.cwd;
    const hasUI = ctx.hasUI;
    const notify = hasUI ? ctx.ui.notify.bind(ctx.ui) : (message: string) => console.error(message);
    return { cwd, hasUI, notify };
  }

  pi.registerMessageRenderer("lsp-diagnostics", (message, options, theme) => {
    const content = formatDiagnosticsForDisplay(messageContentToText(message.content));
    if (!content) return new Text("", 0, 0);

    const expanded = options.expanded === true;
    const lines = content.split("\n");
    const maxLines = expanded ? lines.length : DIAGNOSTICS_PREVIEW_LINES;
    const display = lines.slice(0, maxLines);
    const remaining = lines.length - display.length;

    const styledLines = display.map((line) => styleDiagnosticDisplayLine(line, theme));

    if (!expanded && remaining > 0) {
      styledLines.push(theme.fg("dim", `... (${remaining} more lines)`));
    }

    return new Text(styledLines.join("\n"), 0, 0);
  });

  pi.registerMessageRenderer("lsp-doctor", (message, _options, theme) => {
    const content = messageContentToText(message.content).trim();
    if (!content) return new Text("", 0, 0);

    const styledLines = content.split("\n").map((line) => {
      if (line.startsWith("status:") || line.startsWith("server:") || line.startsWith("root:") || line.startsWith("binary:")) {
        return theme.fg("muted", line);
      }
      return theme.fg("toolOutput", line);
    });

    return new Text(styledLines.join("\n"), 0, 0);
  });

  function getServerConfig(filePath: string) {
    const ext = path.extname(filePath);
    return LSP_SERVERS.find((s) => s.extensions.includes(ext));
  }

  function ensureActiveClientForFile(filePath: string, cwd: string): string | undefined {
    const absPath = normalizeFilePath(filePath, cwd);
    const cfg = getServerConfig(absPath);
    if (!cfg) return undefined;

    if (!activeClients.has(cfg.id)) {
      activeClients.add(cfg.id);
      updateLspStatus();
    }

    return absPath;
  }

  function extractLspFiles(input: Record<string, unknown>): string[] {
    const files: string[] = [];

    if (typeof input.file === "string") files.push(input.file);
    if (Array.isArray(input.files)) {
      for (const item of input.files) {
        if (typeof item === "string") files.push(item);
      }
    }

    return files;
  }

  function extractBashFileCandidates(command: string, cwd: string): string[] {
    const candidates = new Set<string>();
    const supported = new Set(LSP_SERVERS.flatMap((server) => server.extensions));
    const pathLike = /(?:^|[\s'"`=:(>])((?:\.{1,2}\/|\/)?[A-Za-z0-9_@%+=:,./-]+\.[A-Za-z0-9]+)/g;
    const changesDirectory = /(?:^|[;&|()\n])\s*cd\s+/.test(command);

    for (const match of command.matchAll(pathLike)) {
      const raw = match[1]?.replace(/[),;]+$/, "");
      if (!raw) continue;
      if (!supported.has(path.extname(raw))) continue;
      if (changesDirectory && !path.isAbsolute(raw)) continue;
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      const rel = path.relative(cwd, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      candidates.add(abs);
      if (candidates.size >= 10) break;
    }

    return [...candidates];
  }

  async function waitForReadableFile(absPath: string, timeoutMs = 1500): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      try {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  function buildDiagnosticsOutput(
    filePath: string,
    diagnostics: Diagnostic[],
    cwd: string,
    includeFileHeader: boolean
  ): { notification: string; errorCount: number; output: string } {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absPath);
    const errorCount = diagnostics.filter((e) => e.severity === 1).length;

    const MAX = 5;
    const lines = diagnostics.slice(0, MAX).map((e) => {
      const sev = diagnosticSeverityLabel(e.severity);
      return `${sev}[${e.range.start.line + 1}] ${e.message.split("\n")[0]}`;
    });

    let notification = `📋 ${relativePath}\n${lines.join("\n")}`;
    if (diagnostics.length > MAX) notification += `\n... +${diagnostics.length - MAX} more`;

    const header = includeFileHeader ? `File: ${relativePath}\n` : "";
    const headline = errorCount > 0 ? "This file has LSP errors; please fix them" : "This file has LSP diagnostics; please review them";
    const output = `\n${header}${headline}\n<file_diagnostics>\n${diagnostics.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;

    return { notification, errorCount, output };
  }

  async function collectDiagnostics(
    filePath: string,
    diagnosticsCtx: DiagnosticsContext,
    includeWarnings: boolean,
    includeFileHeader: boolean,
    notify = true
  ): Promise<string | undefined> {
    const manager = getOrCreateManager(diagnosticsCtx.cwd);
    const absPath = ensureActiveClientForFile(filePath, diagnosticsCtx.cwd);
    if (!absPath) return undefined;

    try {
      await waitForReadableFile(absPath);
      const result = await manager.touchFileAndWait(absPath, diagnosticsWaitMsForFile(absPath));
      if (result.unsupported || result.error) {
        const inspection = inspectLspForFile(diagnosticsCtx.cwd, absPath);
        if (inspection.status === "missing-binary" || inspection.status === "unsupported") {
          lastDiagnosticReports.delete(absPath);
          return undefined;
        }

        const relativePath = path.relative(diagnosticsCtx.cwd, absPath);
        const message = `File: ${relativePath}\nLSP unavailable: ${result.error || "No LSP response"}`;
        if (notify) diagnosticsCtx.notify(message, "warning");
        const key = `unavailable:${message}`;
        if (lastDiagnosticReports.get(absPath) === key) return undefined;
        lastDiagnosticReports.set(absPath, key);
        return `\n${message}\n`;
      }
      if (!result.receivedResponse) return undefined;

      const diagnostics = includeWarnings ? result.diagnostics : result.diagnostics.filter((d) => d.severity === 1);
      if (!diagnostics.length) {
        lastDiagnosticReports.delete(absPath);
        return undefined;
      }

      const diagnosticText = diagnostics.map(formatDiagnostic).join("\n");
      if (lastDiagnosticReports.get(absPath) === diagnosticText) return undefined;
      lastDiagnosticReports.set(absPath, diagnosticText);

      const report = buildDiagnosticsOutput(filePath, diagnostics, diagnosticsCtx.cwd, includeFileHeader);

      if (notify) diagnosticsCtx.notify(report.notification, report.errorCount > 0 ? "error" : "warning");

      return report.output;
    } catch {
      return undefined;
    }
  }

  function sendDiagnosticsMessage(output: string): void {
    pi.sendMessage(
      {
        customType: "lsp-diagnostics",
        content: output,
        display: true,
      },
      {
        triggerTurn: true,
        deliverAs: "steer",
      }
    );
  }

  function clearScheduledDiagnostics(): void {
    for (const timer of scheduledDiagnostics.values()) clearTimeout(timer);
    scheduledDiagnostics.clear();
  }

  function scheduleEditWriteDiagnostics(filePath: string, diagnosticsCtx: DiagnosticsContext, includeWarnings: boolean): void {
    const absPath = normalizeFilePath(filePath, diagnosticsCtx.cwd);
    const existing = scheduledDiagnostics.get(absPath);
    if (existing) clearTimeout(existing);

    setActivity("working");
    const timer = setTimeout(() => {
      scheduledDiagnostics.delete(absPath);
      void (async () => {
        try {
          const output = await collectDiagnostics(absPath, diagnosticsCtx, includeWarnings, false);
          if (output && !shuttingDown) sendDiagnosticsMessage(output);
        } finally {
          if (!shuttingDown && scheduledDiagnostics.size === 0) {
            setActivity("idle");
            if (diagnosticsCtx.hasUI) scheduleIdleShutdown();
            else void shutdownLspServersForIdle();
          }
        }
      })();
    }, 750);
    scheduledDiagnostics.set(absPath, timer);
  }

  pi.registerCommand("lsp-restart", {
    description: "Restart all LSP servers",
    handler: async (_args, ctx) => {
      await shutdownManager();
      activeClients.clear();
      touchedFiles.clear();
      updateLspStatus();
      ctx.ui.notify("LSP servers restarted", "info");
    },
  });

  pi.registerCommand("lsp-doctor", {
    description: "Inspect LSP root and binary detection for a file",
    handler: async (args, ctx) => {
      const filePath = args?.trim();
      if (!filePath) {
        const usage = "Usage: /lsp-doctor <file>";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        else console.log(usage);
        return;
      }

      const info = inspectLspForFile(ctx.cwd, filePath);
      const lines = [
        `file: ${path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath)}`,
        `status: ${info.status}`,
        `server: ${info.serverId ?? "none"}`,
        `root: ${info.root ?? "none"}`,
        `binary: ${info.binary ?? "none"}`,
      ];
      if (info.reason) lines.push(`reason: ${info.reason}`);

      const report = lines.join("\n");
      if (ctx.hasUI) {
        pi.sendMessage({
          customType: "lsp-doctor",
          content: report,
          display: true,
        });
      } else {
        console.log(report);
      }
    },
  });

  pi.registerCommand("lsp", {
    description: "LSP settings (auto diagnostics hook)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("LSP settings require UI", "warning");
        return;
      }

      const currentMark = " ✓";
      const modeOptions = (["edit_write", "agent_end", "disabled"] as HookMode[]).map((mode) => ({
        mode,
        label: mode === hookMode ? `${labelForMode(mode)}${currentMark}` : labelForMode(mode),
      }));

      const modeChoice = await ctx.ui.select(
        "LSP auto diagnostics hook mode:",
        modeOptions.map((option) => option.label)
      );
      if (!modeChoice) return;

      const nextMode = modeOptions.find((option) => option.label === modeChoice)?.mode;
      if (!nextMode) return;

      const scopeOptions = [
        { scope: "session" as HookScope, label: "Session only" },
        { scope: "global" as HookScope, label: "Global (all sessions)" },
      ];

      const scopeChoice = await ctx.ui.select(
        "Apply LSP auto diagnostics hook setting to:",
        scopeOptions.map((option) => option.label)
      );
      if (!scopeChoice) return;

      const scope = scopeOptions.find((option) => option.label === scopeChoice)?.scope;
      if (!scope) return;
      if (scope === "global") {
        const ok = setGlobalHookMode(nextMode);
        if (!ok.ok) {
          ctx.ui.notify(`Failed to update global settings: ${ok.error}`, "error");
          return;
        }
      }

      hookMode = nextMode;
      hookScope = scope;
      touchedFiles.clear();
      pendingBashFiles.clear();
      clearScheduledDiagnostics();
      lastDiagnosticReports.clear();
      bashReportedFiles.clear();
      persistHookEntry({ scope, hookMode: nextMode });
      updateLspStatus();
      ctx.ui.notify(`LSP hook: ${labelForMode(hookMode)} (${hookScope})`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreHookState(ctx);
    statusUpdateFn = ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;
    updateLspStatus();
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreHookState(ctx);
    updateLspStatus();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearIdleShutdownTimer();
    diagnosticsAbort?.abort();
    diagnosticsAbort = null;
    setActivity("idle");

    await shutdownManager();
    activeClients.clear();
    touchedFiles.clear();
    pendingBashFiles.clear();
    clearScheduledDiagnostics();
    lastDiagnosticReports.clear();
    bashReportedFiles.clear();
    statusUpdateFn?.("lsp", undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};

    if (event.toolName === "bash" && typeof input.command === "string") {
      const id = (event as { toolCallId?: string }).toolCallId;
      const files = extractBashFileCandidates(input.command, ctx.cwd);
      if (id && files.length) pendingBashFiles.set(id, files);
      return;
    }

    if (event.toolName !== "lsp") return;

    clearIdleShutdownTimer();
    const files = extractLspFiles(input);
    for (const file of files) {
      ensureActiveClientForFile(file, ctx.cwd);
    }
  });

  pi.on("agent_start", async () => {
    clearIdleShutdownTimer();
    diagnosticsAbort?.abort();
    diagnosticsAbort = null;
    setActivity("idle");
    touchedFiles.clear();
    pendingBashFiles.clear();
    clearScheduledDiagnostics();
    lastDiagnosticReports.clear();
    bashReportedFiles.clear();
  });

  function assistantTurnShouldRunAgentEndDiagnostics(event: { message?: { role?: string; stopReason?: string } }): boolean {
    const message = event.message;
    if (!message || message.role !== "assistant") return false;
    return message.stopReason !== "toolUse";
  }

  function assistantTurnWasAborted(event: { message?: { role?: string; stopReason?: string } }): boolean {
    const message = event.message;
    return !!message && message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
  }

  pi.on("turn_end", async (event, ctx) => {
    let diagnosticsCtx: DiagnosticsContext | undefined;
    try {
      if (hookMode !== "agent_end") return;
      if (!assistantTurnShouldRunAgentEndDiagnostics(event)) return;

      if (assistantTurnWasAborted(event)) {
        touchedFiles.clear();
        return;
      }

      if (touchedFiles.size === 0) return;
      if (ctx.hasPendingMessages()) return;

      diagnosticsCtx = snapshotDiagnosticsContext(ctx);
      const abort = new AbortController();
      diagnosticsAbort?.abort();
      diagnosticsAbort = abort;

      const files = Array.from(touchedFiles.entries());
      touchedFiles.clear();

      try {
        const outputs: string[] = [];
        for (const [filePath, includeWarnings] of files) {
          if (shuttingDown || abort.signal.aborted) return;

          const output = await collectDiagnostics(filePath, diagnosticsCtx, includeWarnings, true, false);
          if (abort.signal.aborted) return;
          if (output) outputs.push(output);
        }

        if (shuttingDown || abort.signal.aborted) return;

        if (outputs.length) sendDiagnosticsMessage(outputs.join("\n"));
      } finally {
        if (diagnosticsAbort === abort) diagnosticsAbort = null;
        if (!shuttingDown) setActivity("idle");
      }
    } finally {
      if (!shuttingDown && diagnosticsCtx) {
        if (diagnosticsCtx.hasUI) scheduleIdleShutdown();
        else await shutdownLspServersForIdle();
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash") {
      const id = (event as { toolCallId?: string }).toolCallId;
      const files = id ? pendingBashFiles.get(id) : undefined;
      if (id) pendingBashFiles.delete(id);
      if (event.isError || hookMode === "disabled" || !files?.length) return;

      const diagnosticsCtx = snapshotDiagnosticsContext(ctx);
      for (const file of files) {
        const absPath = normalizeFilePath(file, diagnosticsCtx.cwd);
        if (bashReportedFiles.has(absPath)) continue;
        bashReportedFiles.add(absPath);
        scheduleEditWriteDiagnostics(absPath, diagnosticsCtx, true);
      }
      return;
    }

    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    const filePath = event.input.path as string;
    if (!filePath) return;

    const diagnosticsCtx = snapshotDiagnosticsContext(ctx);
    const absPath = ensureActiveClientForFile(filePath, diagnosticsCtx.cwd);
    if (!absPath) return;

    if (hookMode === "disabled") return;

    if (hookMode === "agent_end") {
      const includeWarnings = event.toolName === "write";
      const existing = touchedFiles.get(absPath) ?? false;
      touchedFiles.set(absPath, existing || includeWarnings);
      return;
    }

    const includeWarnings = event.toolName === "write";
    scheduleEditWriteDiagnostics(absPath, diagnosticsCtx, includeWarnings);
    return;
  });
}
