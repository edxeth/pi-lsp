/**
 * LSP Tool Extension
 *
 * Provides Language Server Protocol tool for:
 * - definitions, references, hover, signature help
 * - document symbols, diagnostics, workspace diagnostics
 * - rename, code actions
 *
 * Supported languages:
 *   - Dart/Flutter (dart language-server)
 *   - TypeScript/JavaScript (tsgo --lsp or typescript-language-server)
 *   - Vue (vue-language-server)
 *   - Svelte (svelteserver)
 *   - Python (pyright-langserver)
 *   - Go (gopls)
 *   - Rust (rust-analyzer)
 */

import * as path from "node:path";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SignatureHelp, WorkspaceEdit, CodeAction, Command } from "vscode-languageserver-protocol";
import { getOrCreateManager, shutdownManager, formatDiagnostic, filterDiagnosticsBySeverity, uriToPath, resolvePosition, type SeverityFilter } from "./lsp-core.js";
import { formatBoundedDiagnostics, TOOL_DIAGNOSTIC_BUDGET } from "./diagnostic-output.js";

const PREVIEW_LINES = 10;
const PREVIEW_LINE_CHARS = 80;
const DIAGNOSTICS_WAIT_MS_DEFAULT = 3000;

function wrapPreviewLine(line: string): string[] {
  if (line.length <= PREVIEW_LINE_CHARS) return [line];
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > PREVIEW_LINE_CHARS) {
    const breakAt = Math.max(rest.lastIndexOf(" ", PREVIEW_LINE_CHARS), PREVIEW_LINE_CHARS);
    chunks.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function previewContentLines(lines: string[], maxLines: number): { lines: Array<{ text: string; source: string }>; remaining: number } {
  const preview: Array<{ text: string; source: string }> = [];
  let total = 0;

  for (const line of lines) {
    const wrapped = wrapPreviewLine(line);
    total += wrapped.length;
    for (const text of wrapped) {
      if (preview.length < maxLines) preview.push({ text, source: line });
    }
  }

  return { lines: preview, remaining: Math.max(0, total - preview.length) };
}

function styleToolResultLine(line: string, theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2], source = line): string {
  if (/^(ERROR|FATAL)\b/i.test(source)) return theme.fg("error", line);
  if (/^(WARN|WARNING)\b/i.test(source) || /^(Unsupported|Timeout|LSP unavailable)\b/i.test(source)) return theme.fg("warning", line);
  if (/^INFO\b/i.test(source)) return theme.fg("muted", line);
  if (/^HINT\b/i.test(source)) return theme.fg("dim", line);
  return theme.fg("toolOutput", line);
}

function normalizeToolFilePath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const trimmed = filePath.trim();
  const match = /^(?:file|path)=(.+)$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function diagnosticsWaitMsForFile(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"].includes(ext)) return 15000;
  if (ext === ".go") return 8000;
  if (ext === ".rs") return 20000;
  return DIAGNOSTICS_WAIT_MS_DEFAULT;
}

function toolDiagnosticsWaitMsForFile(filePath: string): number {
  return Math.max(diagnosticsWaitMsForFile(filePath), 10000);
}

const ACTIONS = ["definition", "references", "hover", "symbols", "diagnostics", "workspace-diagnostics", "signature", "rename", "codeAction", "restart"] as const;
const SEVERITY_FILTERS = ["all", "error", "warning", "info", "hint"] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.Optional(Type.String({ description: "File path (required for most actions)" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "File paths for workspace-diagnostics" })),
  line: Type.Optional(Type.Number({ description: "Line (1-indexed). Required for position-based actions unless query provided." })),
  column: Type.Optional(Type.Number({ description: "Column (1-indexed). Required for position-based actions unless query provided." })),
  endLine: Type.Optional(Type.Number({ description: "End line for range-based actions (codeAction)" })),
  endColumn: Type.Optional(Type.Number({ description: "End column for range-based actions (codeAction)" })),
  query: Type.Optional(Type.String({ description: "Symbol name filter (for symbols) or to resolve position (for definition/references/hover/signature)" })),
  newName: Type.Optional(Type.String({ description: "New name for rename action" })),
  severity: Type.Optional(StringEnum(SEVERITY_FILTERS, { description: 'Filter diagnostics: "all"|"error"|"warning"|"info"|"hint"' })),
});

type LspParamsType = Static<typeof LspParams>;

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      }
    );
  });
}

function isAbortedError(e: unknown): boolean {
  return e instanceof Error && e.message === "aborted";
}

function cancelledToolResult() {
  return {
    content: [{ type: "text" as const, text: "Cancelled" }],
    details: { cancelled: true },
  };
}

type ExecuteArgs = {
  signal: AbortSignal | undefined;
  onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void) | undefined;
  ctx: { cwd: string };
};

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && "aborted" in value && typeof (value as Record<string, unknown>).aborted === "boolean" && typeof (value as Record<string, unknown>).addEventListener === "function";
}

function isContextLike(value: unknown): value is { cwd: string } {
  return !!value && typeof value === "object" && typeof (value as { cwd: unknown }).cwd === "string";
}

function normalizeExecuteArgs(onUpdateArg: unknown, ctxArg: unknown, signalArg: unknown): ExecuteArgs {
  // Runtime >= 0.51: (signal, onUpdate, ctx)
  if (isContextLike(signalArg)) {
    return {
      signal: isAbortSignalLike(onUpdateArg) ? onUpdateArg : undefined,
      onUpdate: typeof ctxArg === "function" ? (ctxArg as ExecuteArgs["onUpdate"]) : undefined,
      ctx: signalArg,
    };
  }

  // Runtime <= 0.50: (onUpdate, ctx, signal)
  if (isContextLike(ctxArg)) {
    return {
      signal: isAbortSignalLike(signalArg) ? signalArg : undefined,
      onUpdate: typeof onUpdateArg === "function" ? (onUpdateArg as ExecuteArgs["onUpdate"]) : undefined,
      ctx: ctxArg,
    };
  }

  throw new Error("Invalid tool execution context");
}

function formatLocation(loc: { uri: string; range?: { start?: { line: number; character: number } } }, cwd?: string): string {
  const abs = uriToPath(loc.uri);
  const display = cwd && path.isAbsolute(abs) ? path.relative(cwd, abs) : abs;
  const { line, character: col } = loc.range?.start ?? {};
  return typeof line === "number" && typeof col === "number" ? `${display}:${line + 1}:${col + 1}` : display;
}

function formatHover(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents))
    return contents
      .map((c) => (typeof c === "string" ? c : (c as { value?: string })?.value ?? ""))
      .filter(Boolean)
      .join("\n\n");
  if (contents && typeof contents === "object" && "value" in contents) return String((contents as { value: unknown }).value);
  return "";
}

function formatSignature(help: SignatureHelp | null): string {
  if (!help?.signatures?.length) return "No signature help available.";
  const sig = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  let text = sig.label ?? "Signature";
  if (sig.documentation) text += `\n${typeof sig.documentation === "string" ? sig.documentation : sig.documentation?.value ?? ""}`;
  if (sig.parameters?.length) {
    const params = sig.parameters
      .map((p) => (typeof p.label === "string" ? p.label : Array.isArray(p.label) ? String(p.label[0]) + "-" + String(p.label[1]) : ""))
      .filter(Boolean);
    if (params.length) text += `\nParameters: ${params.join(", ")}`;
  }
  return text;
}

function collectSymbols(symbols: Array<{ name?: string; range?: { start?: { line: number; character: number } }; children?: unknown[] }>, depth = 0, lines: string[] = [], query?: string): string[] {
  for (const sym of symbols) {
    const name = sym?.name ?? "<unknown>";
    if (query && !name.toLowerCase().includes(query.toLowerCase())) {
      if (sym.children?.length) collectSymbols(sym.children as typeof symbols, depth + 1, lines, query);
      continue;
    }
    const loc = sym?.range?.start ? `${sym.range.start.line + 1}:${sym.range.start.character + 1}` : "";
    lines.push(`${"  ".repeat(depth)}${name}${loc ? ` (${loc})` : ""}`);
    if (sym.children?.length) collectSymbols(sym.children as typeof symbols, depth + 1, lines, query);
  }
  return lines;
}

function formatWorkspaceEdit(edit: WorkspaceEdit, cwd?: string): string {
  const lines: string[] = [];

  if (edit.documentChanges?.length) {
    for (const change of edit.documentChanges) {
      // TextDocumentEdit has textDocument, CreateFile/RenameFile/DeleteFile don't
      if ("textDocument" in change && change.textDocument?.uri) {
        const fp = uriToPath(change.textDocument.uri);
        const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
        lines.push(`${display}:`);
        for (const e of change.edits || []) {
          if ("range" in e) {
            const loc = `${e.range.start.line + 1}:${e.range.start.character + 1}`;
            lines.push(`  [${loc}] → "${e.newText}"`);
          }
        }
      }
    }
  }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fp = uriToPath(uri);
      const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
      lines.push(`${display}:`);
      for (const e of edits) {
        const loc = `${e.range.start.line + 1}:${e.range.start.character + 1}`;
        lines.push(`  [${loc}] → "${e.newText}"`);
      }
    }
  }

  return lines.length ? lines.join("\n") : "No edits.";
}

function formatCodeActions(actions: (CodeAction | Command)[]): string[] {
  return actions.map((a, i) => {
    // CodeAction has title directly; Command also has title
    const title = a.title || "Untitled action";
    // Only CodeAction has kind and isPreferred
    const kind = "kind" in a && a.kind ? ` (${a.kind})` : "";
    const isPreferred = "isPreferred" in a && a.isPreferred ? " ★" : "";
    return `${i + 1}. ${title}${kind}${isPreferred}`;
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Query language server for definitions, references, types, symbols, diagnostics, rename previews, and code-action previews.

Actions: definition, references, hover, signature, rename (preview only; require file + line/column or query), symbols (file, optional query), diagnostics (file), workspace-diagnostics (files array), codeAction (preview/list only; file + position), restart (no args - restarts all LSP servers).
Use find/grep or bash to locate files before querying LSP positions.`,
    promptSnippet:
      "lsp: Query language servers for definitions, references, hover, signature, symbols, diagnostics, rename previews, code-action previews, and restart.",
    parameters: LspParams,

    async execute(_toolCallId, params, signalArg, onUpdateArg, ctxArg) {
      const { signal, ctx } = normalizeExecuteArgs(signalArg, onUpdateArg, ctxArg);
      if (signal?.aborted) return cancelledToolResult();
      const manager = getOrCreateManager(ctx.cwd);
      const { action, files, line, column, endLine, endColumn, query, newName, severity } = params as LspParamsType;
      const file = normalizeToolFilePath((params as LspParamsType).file);
      const normalizedFiles = files?.map(normalizeToolFilePath).filter((item): item is string => !!item);
      const sevFilter: SeverityFilter = severity || "all";
      const needsFile = action !== "workspace-diagnostics" && action !== "restart";
      const needsPos = ["definition", "references", "hover", "signature", "rename", "codeAction"].includes(action);

      try {
        if (needsFile && !file) throw new Error(`Action "${action}" requires a file path.`);

        let rLine = line,
          rCol = column,
          fromQuery = false;
        if (needsPos && (rLine === undefined || rCol === undefined) && query && file) {
          const resolved = await abortable(resolvePosition(manager, file, query), signal);
          if (resolved) {
            rLine = resolved.line;
            rCol = resolved.column;
            fromQuery = true;
          }
        }
        if (needsPos && (rLine === undefined || rCol === undefined)) {
          throw new Error(`Action "${action}" requires line/column or a query matching a symbol.`);
        }

        const qLine = query ? `query: ${query}\n` : "";
        const sevLine = sevFilter !== "all" ? `severity: ${sevFilter}\n` : "";
        const posLine = fromQuery && rLine && rCol ? `resolvedPosition: ${rLine}:${rCol}\n` : "";

        switch (action) {
          case "definition": {
            const results = await abortable(manager.getDefinition(file!, rLine!, rCol!), signal);
            const locs = results.map((l) => formatLocation(l, ctx?.cwd));
            const unavailable = !locs.length ? manager.describeUnavailableForFile(file!) : undefined;
            const payload = locs.length ? locs.join("\n") : unavailable ? `LSP unavailable: ${unavailable}` : fromQuery ? `${file}:${rLine}:${rCol}` : "No definitions found.";
            return { content: [{ type: "text", text: `action: definition\n${qLine}${posLine}${payload}` }], details: results };
          }
          case "references": {
            const results = await abortable(manager.getReferences(file!, rLine!, rCol!), signal);
            const locs = results.map((l) => formatLocation(l, ctx?.cwd));
            const unavailable = !locs.length ? manager.describeUnavailableForFile(file!) : undefined;
            const payload = locs.length ? locs.join("\n") : unavailable ? `LSP unavailable: ${unavailable}` : "No references found.";
            return { content: [{ type: "text", text: `action: references\n${qLine}${posLine}${payload}` }], details: results };
          }
          case "hover": {
            const result = await abortable(manager.getHover(file!, rLine!, rCol!), signal);
            const unavailable = !result ? manager.describeUnavailableForFile(file!) : undefined;
            const payload = result ? formatHover(result.contents) || "No hover information." : unavailable ? `LSP unavailable: ${unavailable}` : "No hover information.";
            return { content: [{ type: "text", text: `action: hover\n${qLine}${posLine}${payload}` }], details: result ?? null };
          }
          case "symbols": {
            const symbols = await abortable(manager.getDocumentSymbols(file!), signal);
            const lines = collectSymbols(symbols, 0, [], query);
            const unavailable = !lines.length ? manager.describeUnavailableForFile(file!) : undefined;
            const payload = lines.length ? lines.join("\n") : unavailable ? `LSP unavailable: ${unavailable}` : query ? `No symbols matching "${query}".` : "No symbols found.";
            return { content: [{ type: "text", text: `action: symbols\n${qLine}${payload}` }], details: symbols };
          }
          case "diagnostics": {
            const result = await abortable(manager.touchFileAndWait(file!, toolDiagnosticsWaitMsForFile(file!)), signal);
            const filtered = filterDiagnosticsBySeverity(result.diagnostics, sevFilter);
            const displayFile = ctx?.cwd && path.isAbsolute(file!) ? path.relative(ctx.cwd, file!) : file!;
            const body = result.unsupported
              ? `Unsupported: ${result.error || "No LSP for this file."}`
              : !result.receivedResponse
                ? "Timeout: LSP server did not respond. Try again."
                : filtered.length
                  ? formatBoundedDiagnostics(displayFile, filtered, TOOL_DIAGNOSTIC_BUDGET, { includeHeader: false })
                  : "No diagnostics.";
            return {
              content: [{ type: "text", text: `${sevLine}${body}` }],
              isError: !result.unsupported && !result.receivedResponse,
              details: {
                ...result,
                diagnostics: filtered.slice(0, TOOL_DIAGNOSTIC_BUDGET.maxDiagnostics),
                diagnosticCount: filtered.length,
                diagnosticsTruncated: filtered.length > TOOL_DIAGNOSTIC_BUDGET.maxDiagnostics,
              },
            };
          }
          case "workspace-diagnostics": {
            if (!normalizedFiles?.length) throw new Error('Action "workspace-diagnostics" requires a "files" array.');
            const waitMs = Math.max(...normalizedFiles.map(toolDiagnosticsWaitMsForFile));
            const result = await abortable(manager.getDiagnosticsForFiles(normalizedFiles, waitMs), signal);
            const out: string[] = [];
            let errors = 0,
              warnings = 0,
              filesWithIssues = 0;

            for (const item of result.items) {
              const display = ctx?.cwd && path.isAbsolute(item.file) ? path.relative(ctx.cwd, item.file) : item.file;
              if (item.status !== "ok") {
                out.push(`${display}: ${item.error || item.status}`);
                continue;
              }
              const filtered = filterDiagnosticsBySeverity(item.diagnostics, sevFilter);
              if (filtered.length) {
                filesWithIssues++;
                out.push(`${display}:`);
                for (const d of filtered) {
                  if (d.severity === 1) errors++;
                  else if (d.severity === 2) warnings++;
                  out.push(`  ${formatDiagnostic(d)}`);
                }
              }
            }

            const summary = `Analyzed ${result.items.length} file(s): ${errors} error(s), ${warnings} warning(s) in ${filesWithIssues} file(s)`;
            const body = out.length ? out.join("\n") : "No diagnostics.";
            const bounded = body.length > TOOL_DIAGNOSTIC_BUDGET.maxTotalChars ? `${body.slice(0, TOOL_DIAGNOSTIC_BUDGET.maxTotalChars - 31).trimEnd()}\nDiagnostic output truncated.` : body;
            const hasTimeout = result.items.some((item) => item.status === "timeout");
            const boundedDetails = {
              ...result,
              items: result.items.map((item) => ({
                ...item,
                diagnostics: item.diagnostics?.slice(0, TOOL_DIAGNOSTIC_BUDGET.maxDiagnostics),
                diagnosticCount: item.diagnostics?.length ?? 0,
                diagnosticsTruncated: (item.diagnostics?.length ?? 0) > TOOL_DIAGNOSTIC_BUDGET.maxDiagnostics,
              })),
            };
            return { content: [{ type: "text", text: `action: workspace-diagnostics\n${sevLine}${summary}\n\n${bounded}` }], details: boundedDetails, isError: hasTimeout };
          }
          case "signature": {
            const result = await abortable(manager.getSignatureHelp(file!, rLine!, rCol!), signal);
            const unavailable = !result ? manager.describeUnavailableForFile(file!) : undefined;
            const payload = unavailable ? `LSP unavailable: ${unavailable}` : formatSignature(result);
            return { content: [{ type: "text", text: `action: signature\n${qLine}${posLine}${payload}` }], details: result ?? null };
          }
          case "rename": {
            if (!newName) throw new Error('Action "rename" requires a "newName" parameter.');
            const result = await abortable(manager.rename(file!, rLine!, rCol!, newName), signal);
            if (!result) return { content: [{ type: "text", text: `action: rename\n${qLine}${posLine}No rename available at this position.` }], details: null };
            const edits = formatWorkspaceEdit(result, ctx?.cwd);
            return { content: [{ type: "text", text: `action: rename\n${qLine}${posLine}mode: preview-only\nnewName: ${newName}\n\n${edits}` }], details: result };
          }
          case "codeAction": {
            const result = await abortable(manager.getCodeActions(file!, rLine!, rCol!, endLine, endColumn), signal);
            const actions = formatCodeActions(result);
            return { content: [{ type: "text", text: `action: codeAction\n${qLine}${posLine}mode: preview-only\n${actions.length ? actions.join("\n") : "No code actions available."}` }], details: result };
          }
          case "restart": {
            await shutdownManager();
            return { content: [{ type: "text", text: "action: restart\nLSP servers restarted. Next query will start fresh servers." }], details: { restarted: true } };
          }
        }
      } catch (e) {
        if (signal?.aborted || isAbortedError(e)) return cancelledToolResult();
        throw e;
      }
    },

    renderCall(args, theme) {
      const params = args as LspParamsType;
      let text = theme.fg("toolTitle", theme.bold("lsp ")) + theme.fg("accent", params.action || "...");
      if (params.file) text += " " + theme.fg("muted", params.file);
      else if (params.files?.length) text += " " + theme.fg("muted", `${params.files.length} file(s)`);
      if (params.query) text += " " + theme.fg("dim", `query="${params.query}"`);
      else if (params.line !== undefined && params.column !== undefined) text += theme.fg("warning", `:${params.line}:${params.column}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);

      const textContent = (result.content?.find((c: { type: string }) => c.type === "text") as { text?: string })?.text || "";
      const lines = textContent.split("\n");

      let headerEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^(action|query|severity|resolvedPosition):/.test(lines[i])) headerEnd = i + 1;
        else break;
      }

      const header = lines.slice(0, headerEnd);
      const content = lines.slice(headerEnd);
      const contentPreviewLines = Math.max(0, PREVIEW_LINES - header.length);
      const preview = options.expanded
        ? { lines: content.map((line) => ({ text: line, source: line })), remaining: 0 }
        : previewContentLines(content, contentPreviewLines);

      let out = header.map((l: string) => theme.fg("muted", l)).join("\n");
      if (preview.lines.length) {
        if (out) out += "\n";
        out += preview.lines.map(({ text, source }) => styleToolResultLine(text, theme, source)).join("\n");
      }
      if (preview.remaining > 0) {
        const remaining = preview.remaining;
        out += options.expanded
          ? theme.fg("dim", `\n(${keyHint("app.tools.expand", "to collapse")})`)
          : theme.fg("dim", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
      }

      return new Text(out, 0, 0);
    },
  });
}
