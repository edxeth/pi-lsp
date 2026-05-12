import { describe, expect, test } from "bun:test";
import { isLspDeadConnectionError, LspConnectionClosedError, LspProcessExitedError } from "../src/lsp-core.js";

describe("typed LSP dead connection errors", () => {
  test("classifies connection-closed and process-exited errors as dead connections", () => {
    expect(isLspDeadConnectionError(new LspConnectionClosedError("typescript", "/repo"))).toBe(true);
    expect(isLspDeadConnectionError(new LspProcessExitedError("typescript", "/repo", 1, "boom"))).toBe(true);
    expect(isLspDeadConnectionError(new Error("ordinary"))).toBe(false);
  });
});
