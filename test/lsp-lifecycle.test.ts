import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateManager, isLspDeadConnectionError, shutdownManager } from "../src/lsp-core.js";

function writeFakeServer(dir: string, mode: "normal" | "silent" | "crash-on-open" | "crash-on-definition" = "normal"): string {
  const server = path.join(dir, `fake-${mode}.mjs`);
  fs.writeFileSync(
    server,
    `
const mode = ${JSON.stringify(mode)};
let buffer = Buffer.alloc(0);
const docs = new Map();
function write(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  process.stdout.write(Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'));
  process.stdout.write(body);
}
function diagnosticFor(uri) {
  const text = docs.get(uri) || '';
  return text.includes('bad') ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, source: 'fake-ls', message: 'fake bad diagnostic' }] : [];
}
function publish(uri) {
  if (mode === 'silent') return;
  write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagnosticFor(uri) } });
}
function handle(msg) {
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 2 } } });
    return;
  }
  if (msg.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const doc = msg.params.textDocument;
    docs.set(doc.uri, doc.text || '');
    if (mode === 'crash-on-open') process.exit(42);
    publish(doc.uri);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const uri = msg.params.textDocument.uri;
    docs.set(uri, msg.params.contentChanges?.[0]?.text || '');
    publish(uri);
    return;
  }
  if (msg.method === 'textDocument/didSave') {
    publish(msg.params.textDocument.uri);
    return;
  }
  if (msg.method === 'textDocument/definition') {
    if (mode === 'crash-on-definition') process.exit(43);
    write({ jsonrpc: '2.0', id: msg.id, result: [] });
  }
}
function pump() {
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.slice(bodyStart + length);
    handle(JSON.parse(body));
  }
}
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); pump(); });
`.trimStart()
  );
  return server;
}

function makeRepo(ext = ".fake", mode: "normal" | "silent" | "crash-on-open" | "crash-on-definition" = "normal") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-life-"));
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  const server = writeFakeServer(dir, mode);
  fs.writeFileSync(path.join(dir, ".pi", "lsp-client.json"), JSON.stringify({ lsp: { fake: { command: [process.execPath, server], extensions: [ext] } } }, null, 2));
  return dir;
}

async function cleanup(dir: string) {
  await shutdownManager(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("LSP lifecycle invariants", () => {
  test("changed file content invalidates cached diagnostics and clean files clear", async () => {
    const dir = makeRepo();
    const file = path.join(dir, "sample.fake");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(file, "bad\n");
      const bad = await manager.touchFileAndWait(file, 1000);
      expect(bad.receivedResponse).toBe(true);
      expect(bad.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");

      fs.writeFileSync(file, "good\n");
      const good = await manager.touchFileAndWait(file, 1000);
      expect(good.receivedResponse).toBe(true);
      expect(good.diagnostics).toHaveLength(0);

      fs.writeFileSync(file, "bad again\n");
      const badAgain = await manager.touchFileAndWait(file, 1000);
      expect(badAgain.receivedResponse).toBe(true);
      expect(badAgain.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");
    } finally {
      await cleanup(dir);
    }
  });

  test("unchanged file diagnostics are served from cache without waiting", async () => {
    const dir = makeRepo();
    const file = path.join(dir, "sample.fake");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(file, "bad\n");
      await manager.touchFileAndWait(file, 1000);
      const start = Date.now();
      const cached = await manager.touchFileAndWait(file, 1000);
      expect(cached.receivedResponse).toBe(true);
      expect(cached.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");
      expect(Date.now() - start).toBeLessThan(50);
    } finally {
      await cleanup(dir);
    }
  });

  test("silent initialized servers time out without hanging", async () => {
    const dir = makeRepo(".silent", "silent");
    const file = path.join(dir, "sample.silent");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(file, "bad\n");
      const start = Date.now();
      const result = await manager.touchFileAndWait(file, 150);
      expect(result.receivedResponse).toBe(false);
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      await cleanup(dir);
    }
  });

  test("crashing servers are contained and do not hang the diagnostic path", async () => {
    const dir = makeRepo(".crash", "crash-on-open");
    const file = path.join(dir, "sample.crash");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(file, "bad\n");
      const start = Date.now();
      const result = await manager.touchFileAndWait(file, 300);
      expect(result.receivedResponse).toBe(false);
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      await cleanup(dir);
    }
  });

  test("request-time process exits are typed as dead-connection errors", async () => {
    const dir = makeRepo(".dead", "crash-on-definition");
    const file = path.join(dir, "sample.dead");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(file, "good\n");
      await manager.touchFileAndWait(file, 1000);
      const definition = await manager.getDefinition(file, 1, 1);
      expect(definition).toEqual([]);
      const unavailable = manager.describeUnavailableForFile(file);
      expect(unavailable).toContain("fake language server connection closed during definition");
      expect(isLspDeadConnectionError(new Error("ordinary"))).toBe(false);
    } finally {
      await cleanup(dir);
    }
  });

  test("restart clears client/cache state and diagnostics still work", async () => {
    const dir = makeRepo();
    const file = path.join(dir, "sample.fake");
    fs.writeFileSync(file, "bad\n");

    try {
      const firstManager = getOrCreateManager(dir);
      const first = await firstManager.touchFileAndWait(file, 1000);
      expect(first.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");
      await shutdownManager(dir);

      const secondManager = getOrCreateManager(dir);
      const second = await secondManager.touchFileAndWait(file, 1000);
      expect(second.receivedResponse).toBe(true);
      expect(second.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");
    } finally {
      await cleanup(dir);
    }
  });

  test("two roots of the same language do not share cached diagnostics", async () => {
    const a = makeRepo();
    const b = makeRepo();
    const fileA = path.join(a, "sample.fake");
    const fileB = path.join(b, "sample.fake");

    try {
      fs.writeFileSync(fileA, "bad\n");
      fs.writeFileSync(fileB, "good\n");
      const resultA = await getOrCreateManager(a).touchFileAndWait(fileA, 1000);
      const resultB = await getOrCreateManager(b).touchFileAndWait(fileB, 1000);
      expect(resultA.diagnostics.map((d) => d.message)).toContain("fake bad diagnostic");
      expect(resultB.receivedResponse).toBe(true);
      expect(resultB.diagnostics).toHaveLength(0);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  test("outside-cwd files without their own root are unsupported instead of using the wrong workspace", async () => {
    const dir = makeRepo();
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-outside-")), "sample.fake");
    const manager = getOrCreateManager(dir);

    try {
      fs.writeFileSync(outside, "bad\n");
      const result = await manager.touchFileAndWait(outside, 500);
      expect(result.unsupported).toBe(true);
      expect(result.error).toContain("No LSP");
    } finally {
      fs.rmSync(path.dirname(outside), { recursive: true, force: true });
      await cleanup(dir);
    }
  });
});
