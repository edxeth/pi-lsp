export type LspServerId = string;

export type RepairSpec =
  | {
      kind: "tool-cache-node-package";
      packages: string[];
      bin: string;
    }
  | {
      kind: "tool-cache-go-install";
      module: string;
      bin: string;
    }
  | {
      kind: "manual";
      hint: string;
    };

export interface LspRegistryEntry {
  id: LspServerId;
  displayName: string;
  extensions: string[];
  languageIds: Record<string, string>;
  repair: RepairSpec;
}

export const LSP_REGISTRY: LspRegistryEntry[] = [
  {
    id: "typescript",
    displayName: "TypeScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".mts": "typescript",
      ".cts": "typescript",
    },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["typescript-language-server", "typescript"],
      bin: "typescript-language-server",
    },
  },
  {
    id: "vue",
    displayName: "Vue",
    extensions: [".vue"],
    languageIds: { ".vue": "vue" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["@vue/language-server", "typescript"],
      bin: "vue-language-server",
    },
  },
  {
    id: "svelte",
    displayName: "Svelte",
    extensions: [".svelte"],
    languageIds: { ".svelte": "svelte" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["svelte-language-server", "typescript"],
      bin: "svelteserver",
    },
  },
  {
    id: "pyright",
    displayName: "Python / Pyright",
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["pyright"],
      bin: "pyright-langserver",
    },
  },
  {
    id: "bash",
    displayName: "Bash Language Server",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    languageIds: { ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript", ".ksh": "shellscript" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["bash-language-server"],
      bin: "bash-language-server",
    },
  },
  {
    id: "yaml-ls",
    displayName: "YAML Language Server",
    extensions: [".yaml", ".yml"],
    languageIds: { ".yaml": "yaml", ".yml": "yaml" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["yaml-language-server"],
      bin: "yaml-language-server",
    },
  },
  {
    id: "dockerfile",
    displayName: "Dockerfile Language Server",
    extensions: [".dockerfile", "Dockerfile"],
    languageIds: { ".dockerfile": "dockerfile", Dockerfile: "dockerfile" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["dockerfile-language-server-nodejs"],
      bin: "docker-langserver",
    },
  },
  {
    id: "php-intelephense",
    displayName: "PHP Intelephense",
    extensions: [".php"],
    languageIds: { ".php": "php" },
    repair: {
      kind: "tool-cache-node-package",
      packages: ["intelephense"],
      bin: "intelephense",
    },
  },
  {
    id: "gopls",
    displayName: "Go / gopls",
    extensions: [".go"],
    languageIds: { ".go": "go" },
    repair: {
      kind: "tool-cache-go-install",
      module: "golang.org/x/tools/gopls@latest",
      bin: "gopls",
    },
  },
  {
    id: "prisma",
    displayName: "Prisma Language Server",
    extensions: [".prisma"],
    languageIds: { ".prisma": "prisma" },
    repair: {
      kind: "manual",
      hint: "Install Prisma in the project or globally and ensure the prisma command is on PATH.",
    },
  },
  {
    id: "terraform",
    displayName: "Terraform Language Server",
    extensions: [".tf", ".tfvars"],
    languageIds: { ".tf": "terraform", ".tfvars": "terraform" },
    repair: {
      kind: "manual",
      hint: "Install terraform-ls and ensure the terraform-ls command is on PATH.",
    },
  },
  {
    id: "clangd",
    displayName: "clangd",
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
    languageIds: {
      ".c": "c",
      ".h": "c",
      ".cpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".c++": "cpp",
      ".hpp": "cpp",
      ".hh": "cpp",
      ".hxx": "cpp",
      ".h++": "cpp",
    },
    repair: {
      kind: "manual",
      hint: "Install clangd with your system package manager, LLVM package, or Xcode Command Line Tools, and ensure clangd is on PATH.",
    },
  },
  {
    id: "lua-ls",
    displayName: "Lua Language Server",
    extensions: [".lua"],
    languageIds: { ".lua": "lua" },
    repair: {
      kind: "manual",
      hint: "Install lua-language-server and ensure the lua-language-server command is on PATH.",
    },
  },
  {
    id: "rust-analyzer",
    displayName: "Rust Analyzer",
    extensions: [".rs"],
    languageIds: { ".rs": "rust" },
    repair: {
      kind: "manual",
      hint: "Install with your Rust toolchain, for example: rustup component add rust-analyzer",
    },
  },
  {
    id: "dart",
    displayName: "Dart",
    extensions: [".dart"],
    languageIds: { ".dart": "dart" },
    repair: {
      kind: "manual",
      hint: "Install Dart or Flutter and ensure the dart command is on PATH.",
    },
  },
];

export const LANGUAGE_IDS: Record<string, string> = Object.assign({}, ...LSP_REGISTRY.map((entry) => entry.languageIds));

export function getRegistryEntry(serverId: string | undefined): LspRegistryEntry | undefined {
  return serverId ? LSP_REGISTRY.find((entry) => entry.id === serverId) : undefined;
}

