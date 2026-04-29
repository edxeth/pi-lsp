import { describe, expect, test } from "bun:test";
import { resolvePiPaths } from "../src/lsp-paths.js";
import { buildInstallPlan, buildNodeInstallCommand, formatRepairBlock, parseNpmCommand } from "../src/lsp-installer.js";
import { getRegistryEntry } from "../src/lsp-registry.js";

describe("Pi path resolution", () => {
  test("defaults to the standard Pi cache location", () => {
    const paths = resolvePiPaths({}, "/home/user");
    expect(paths.agentDir).toBe("/home/user/.pi/agent");
    expect(paths.settingsPath).toBe("/home/user/.pi/agent/settings.json");
    expect(paths.cacheDir).toBe("/home/user/.pi/cache/lsp");
    expect(paths.lspCacheDir).toBe("/home/user/.pi/cache/lsp");
    expect(paths.lspBinDir).toBe("/home/user/.pi/cache/lsp/bin");
  });

  test("follows PI_CODING_AGENT_DIR for settings while keeping the standard Pi cache default", () => {
    const paths = resolvePiPaths({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, "/home/user");
    expect(paths.agentDir).toBe("/tmp/pi-agent");
    expect(paths.settingsPath).toBe("/tmp/pi-agent/settings.json");
    expect(paths.cacheDir).toBe("/home/user/.pi/cache/lsp");
  });

  test("allows a feature-specific LSP cache override", () => {
    const paths = resolvePiPaths({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_LSP_CACHE_DIR: "/tmp/custom-lsp-cache" }, "/home/user");
    expect(paths.cacheDir).toBe("/tmp/custom-lsp-cache");
    expect(paths.lspCacheDir).toBe("/tmp/custom-lsp-cache");
  });
});

describe("node package-manager commands", () => {
  test("uses add for bun/pnpm/yarn and install for npm", () => {
    expect(buildNodeInstallCommand(["bun"], ["pyright"])).toEqual(["bun", "add", "pyright"]);
    expect(buildNodeInstallCommand(["pnpm"], ["pyright"])).toEqual(["pnpm", "add", "pyright"]);
    expect(buildNodeInstallCommand(["yarn"], ["pyright"])).toEqual(["yarn", "add", "pyright"]);
    expect(buildNodeInstallCommand(["npm"], ["pyright"])).toEqual(["npm", "install", "pyright"]);
    expect(buildNodeInstallCommand(["corepack", "pnpm"], ["pyright"])).toEqual(["corepack", "pnpm", "add", "pyright"]);
    expect(buildNodeInstallCommand(["bun", "--bun"], ["pyright"])).toEqual(["bun", "--bun", "add", "pyright"]);
  });

  test("parses Pi npmCommand from array or string", () => {
    expect(parseNpmCommand(["bun"])).toEqual(["bun"]);
    expect(parseNpmCommand("pnpm --dir .")).toEqual(["pnpm", "--dir", "."]);
    expect(parseNpmCommand([])).toBeUndefined();
    expect(parseNpmCommand(["bun", 1])).toBeUndefined();
  });
});

describe("LSP installer registry", () => {
  test("builds a cache install plan for TypeScript", () => {
    const entry = getRegistryEntry("typescript");
    expect(entry?.repair.kind).toBe("tool-cache-node-package");
    const plan = buildInstallPlan(entry!, ["bun"]);
    expect(plan?.command).toEqual(["bun", "add", "typescript-language-server", "typescript"]);
    expect(plan?.cwd).toContain(".pi/cache/lsp/node/typescript");
    expect(plan?.targetBin).toContain(".pi/cache/lsp/bin/typescript-language-server");
  });

  test("doctor repair block points to the explicit install command", () => {
    const block = formatRepairBlock("pyright").join("\n");
    expect(block).toContain("Repair available:");
    expect(block).toContain("/lsp-install pyright");
    expect(block).toContain("pyright");
  });
});
