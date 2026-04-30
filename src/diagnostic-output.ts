import type { Diagnostic } from "vscode-languageserver-protocol";
import { formatDiagnostic } from "./lsp-core.js";

export type DiagnosticOutputBudget = {
  maxDiagnostics: number;
  maxCharsPerDiagnostic: number;
  maxTotalChars: number;
  followUpHint?: boolean;
  truncationNotice?: boolean;
};

export const HOOK_DIAGNOSTIC_BUDGET: DiagnosticOutputBudget = {
  maxDiagnostics: 3,
  maxCharsPerDiagnostic: 120,
  maxTotalChars: 700,
  followUpHint: true,
  truncationNotice: false,
};

export const TOOL_DIAGNOSTIC_BUDGET: DiagnosticOutputBudget = {
  maxDiagnostics: 100,
  maxCharsPerDiagnostic: 2_000,
  maxTotalChars: 16_000,
  followUpHint: false,
};

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = "…";
  return { text: text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix, truncated: true };
}

function appendWithinBudget(lines: string[], line: string, maxTotalChars: number): boolean {
  const currentLength = lines.join("\n").length;
  const nextLength = currentLength + (lines.length ? 1 : 0) + line.length;
  if (nextLength <= maxTotalChars) {
    lines.push(line);
    return true;
  }
  return false;
}

function addTruncationNotice(lines: string[], maxTotalChars: number): void {
  const notice = "Diagnostic output truncated.";
  if (lines.includes(notice)) return;
  if (appendWithinBudget(lines, notice, maxTotalChars)) return;
  while (lines.length && !appendWithinBudget(lines, notice, maxTotalChars)) lines.pop();
}

export function formatBoundedDiagnostics(
  relativePath: string,
  diagnostics: Diagnostic[],
  budget: DiagnosticOutputBudget,
  options: { includeHeader?: boolean } = {}
): string {
  const includeHeader = options.includeHeader !== false;
  const lines: string[] = [];
  let truncated = false;

  if (includeHeader) appendWithinBudget(lines, `LSP diagnostics ${relativePath}`, budget.maxTotalChars);

  const visibleDiagnostics = diagnostics.slice(0, budget.maxDiagnostics);
  for (const diagnostic of visibleDiagnostics) {
    const formatted = formatDiagnostic(diagnostic).replace(/\s+/g, " ").trim();
    const limited = truncateText(formatted, budget.maxCharsPerDiagnostic);
    truncated ||= limited.truncated;
    if (!appendWithinBudget(lines, limited.text, budget.maxTotalChars)) {
      truncated = true;
      break;
    }
  }

  const hiddenCount = diagnostics.length - visibleDiagnostics.length;
  if (hiddenCount > 0) {
    truncated = true;
    appendWithinBudget(lines, `... ${hiddenCount} more diagnostics hidden.`, budget.maxTotalChars);
  }

  if (truncated && budget.truncationNotice !== false) addTruncationNotice(lines, budget.maxTotalChars);

  if (budget.followUpHint) {
    appendWithinBudget(lines, "Run lsp diagnostics with severity for details.", budget.maxTotalChars);
  }

  return lines.join("\n");
}
