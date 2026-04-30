import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { formatBoundedDiagnostics, HOOK_DIAGNOSTIC_BUDGET, TOOL_DIAGNOSTIC_BUDGET } from "../src/diagnostic-output.js";

function diagnostic(message: string, line = 0): Diagnostic {
  return {
    severity: 1,
    range: {
      start: { line, character: 7 },
      end: { line, character: 8 },
    },
    message,
    source: "ts",
  };
}

describe("bounded diagnostic output", () => {
  test("hook output is a compact summary with a short follow-up hint", () => {
    const output = formatBoundedDiagnostics("src/subagents/index.ts", Array.from({ length: 9 }, (_, i) => diagnostic(`failure ${i + 1}`, i)), HOOK_DIAGNOSTIC_BUDGET);

    expect(output).toContain("LSP diagnostics src/subagents/index.ts");
    expect(output).toContain("ERROR [1:8] failure 1");
    expect(output).toContain("... 6 more diagnostics hidden.");
    expect(output).toContain("Run lsp diagnostics with severity for details.");
    expect(output).not.toContain("failure 4");
    expect(output.length).toBeLessThanOrEqual(HOOK_DIAGNOSTIC_BUDGET.maxTotalChars);
  });

  test("hook output truncates pathological diagnostic messages before they enter context", () => {
    const huge = "No overload matches this call. " + "very long overload details ".repeat(300);
    const output = formatBoundedDiagnostics("src/example.ts", [diagnostic(huge)], HOOK_DIAGNOSTIC_BUDGET);

    expect(output).toContain("ERROR [1:8] No overload matches this call.");
    expect(output).toContain("…");
    expect(output).toContain("Run lsp diagnostics with severity for details.");
    expect(output).not.toContain("Diagnostic output truncated.");
    expect(output.length).toBeLessThanOrEqual(HOOK_DIAGNOSTIC_BUDGET.maxTotalChars);
  });

  test("tool diagnostics are more detailed but still bounded", () => {
    const huge = "x".repeat(TOOL_DIAGNOSTIC_BUDGET.maxTotalChars * 2);
    const output = formatBoundedDiagnostics("src/example.ts", [diagnostic(huge)], TOOL_DIAGNOSTIC_BUDGET, { includeHeader: false });

    expect(output).toContain("ERROR [1:8]");
    expect(output).toContain("Diagnostic output truncated.");
    expect(output.length).toBeLessThanOrEqual(TOOL_DIAGNOSTIC_BUDGET.maxTotalChars);
  });
});
