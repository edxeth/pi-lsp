import { describe, expect, test } from "bun:test";
import { getOrCreateManager, shutdownManager } from "../src/lsp-core.js";

describe("LSP manager snapshot", () => {
  test("snapshot exposes an empty public server-pool state before any client starts", async () => {
    const cwd = process.cwd();
    const manager = getOrCreateManager(cwd);

    try {
      expect(manager.getSnapshot()).toEqual([]);
    } finally {
      await shutdownManager(cwd);
    }
  });
});
