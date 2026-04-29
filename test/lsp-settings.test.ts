import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomicPreservingSymlink } from "../src/lsp.js";

describe("LSP settings writes", () => {
  test("preserves symlinked settings.json when writing atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-settings-"));
    const target = path.join(dir, "real-settings.json");
    const link = path.join(dir, "settings.json");

    try {
      fs.writeFileSync(target, JSON.stringify({ lsp: { hookMode: "agent_end" } }, null, 2) + "\n");
      fs.symlinkSync(target, link);

      writeJsonAtomicPreservingSymlink(link, { lsp: { hookMode: "edit_write" } });

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(target);
      expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ lsp: { hookMode: "edit_write" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
