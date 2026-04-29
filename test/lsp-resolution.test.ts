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

function withResolutionEnv<T>(cache: string, global: string, fn: () => T): T {
  const oldCache = process.env.PI_LSP_CACHE_DIR;
  const oldPath = process.env.PATH;
  process.env.PI_LSP_CACHE_DIR = cache;
  process.env.PATH = global;
  try {
    return fn();
  } finally {
    if (oldCache === undefined) delete process.env.PI_LSP_CACHE_DIR;
    else process.env.PI_LSP_CACHE_DIR = oldCache;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

function makeTypeScriptProject(): { dir: string; project: string; cache: string; global: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-resolution-"));
  const project = path.join(dir, "project");
  const cache = path.join(dir, "cache");
  const global = path.join(dir, "global");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const file = path.join(project, "index.ts");
  fs.writeFileSync(file, "export const x = 1;\n");
  return { dir, project, cache, global, file };
}

describe("LSP binary resolution", () => {
  test("project-local TypeScript language server wins over Pi cache and global PATH", () => {
    const { dir, project, cache, global, file } = makeTypeScriptProject();
    const projectBin = path.join(project, "node_modules", ".bin", "typescript-language-server");
    const cacheBin = path.join(cache, "bin", "typescript-language-server");
    const globalBin = path.join(global, "typescript-language-server");
    touchExecutable(projectBin);
    touchExecutable(cacheBin);
    touchExecutable(globalBin);

    try {
      withResolutionEnv(cache, global, () => {
        const info = inspectLspForFile(project, file);
        expect(info.status).toBe("ok");
        expect(info.binary).toBe(projectBin);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("project-local TypeScript language server wins over global tsgo", () => {
    const { dir, project, cache, global, file } = makeTypeScriptProject();
    const projectBin = path.join(project, "node_modules", ".bin", "typescript-language-server");
    const globalTsgo = path.join(global, "tsgo");
    touchExecutable(projectBin);
    touchExecutable(globalTsgo);

    try {
      withResolutionEnv(cache, global, () => {
        const info = inspectLspForFile(project, file);
        expect(info.status).toBe("ok");
        expect(info.binary).toBe(projectBin);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Pi cache wins over global PATH when no project-local server exists", () => {
    const { dir, project, cache, global, file } = makeTypeScriptProject();
    const cacheBin = path.join(cache, "bin", "typescript-language-server");
    const globalBin = path.join(global, "typescript-language-server");
    touchExecutable(cacheBin);
    touchExecutable(globalBin);

    try {
      withResolutionEnv(cache, global, () => {
        const info = inspectLspForFile(project, file);
        expect(info.status).toBe("ok");
        expect(info.binary).toBe(cacheBin);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("global PATH is still detected when Pi cache and project-local server are absent", () => {
    const { dir, project, cache, global, file } = makeTypeScriptProject();
    const globalBin = path.join(global, "typescript-language-server");
    touchExecutable(globalBin);

    try {
      withResolutionEnv(cache, global, () => {
        const info = inspectLspForFile(project, file);
        expect(info.status).toBe("ok");
        expect(info.binary).toBe(globalBin);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
