import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectLspForFile } from "../src/lsp-core.js";

function touchExecutable(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}

describe("LSP custom server config", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  test("PI_CODING_AGENT_DIR lsp-client.json can add a user-scoped language server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-config-"));
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-agent-"));
    const serverBin = path.join(dir, "bin", "user-demo-ls");
    const file = path.join(dir, "sample.userdemo");

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      touchExecutable(serverBin);
      fs.writeFileSync(file, "demo\n");
      fs.writeFileSync(
        path.join(agentDir, "lsp-client.json"),
        JSON.stringify({ lsp: { userdemo: { command: [serverBin, "--stdio"], extensions: [".userdemo"] } } }, null, 2)
      );

      const info = inspectLspForFile(dir, file);

      expect(info.status).toBe("ok");
      expect(info.serverId).toBe("userdemo");
      expect(info.root).toBe(dir);
    } finally {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("project .pi/lsp-client.json can add a custom language server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-config-"));
    const serverBin = path.join(dir, "bin", "demo-ls");
    const file = path.join(dir, "sample.demo");

    try {
      touchExecutable(serverBin);
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(file, "demo\n");
      fs.writeFileSync(
        path.join(dir, ".pi", "lsp-client.json"),
        JSON.stringify({ lsp: { demo: { command: [serverBin, "--stdio"], extensions: [".demo"] } } }, null, 2)
      );

      const info = inspectLspForFile(dir, file);

      expect(info.status).toBe("ok");
      expect(info.serverId).toBe("demo");
      expect(info.root).toBe(dir);
      expect(info.binary).toBe(serverBin);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("project .pi/lsp-client.json can disable a builtin language server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-config-"));
    const file = path.join(dir, "index.ts");

    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
      fs.writeFileSync(file, "export const value = 1;\n");
      fs.writeFileSync(path.join(dir, ".pi", "lsp-client.json"), JSON.stringify({ lsp: { typescript: { disabled: true } } }, null, 2));

      const info = inspectLspForFile(dir, file);

      expect(info.status).toBe("unsupported");
      expect(info.serverId).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
