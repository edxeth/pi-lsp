import * as os from "node:os";
import * as path from "node:path";

export interface PiPaths {
  agentDir: string;
  settingsPath: string;
  cacheDir: string;
  lspCacheDir: string;
  lspBinDir: string;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

export function resolvePiPaths(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): PiPaths {
  const agentDir = path.resolve(expandHome(env.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi", "agent"), homeDir));
  const settingsPath = path.join(agentDir, "settings.json");
  const lspCacheDir = path.resolve(expandHome(env.PI_LSP_CACHE_DIR || path.join(homeDir, ".pi", "cache", "lsp"), homeDir));
  const cacheDir = lspCacheDir;
  const lspBinDir = path.join(lspCacheDir, "bin");
  return { agentDir, settingsPath, cacheDir, lspCacheDir, lspBinDir };
}
