type LspServerId = string;

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

interface LspRuntimeSpec {
  command: string[];
  rootMarkers?: string[];
  rootStrategy?: "cwd" | "nearest-marker";
}

export interface LspRegistryEntry {
  id: LspServerId;
  displayName: string;
  extensions: string[];
  languageIds: Record<string, string>;
  repair: RepairSpec;
  runtime?: LspRuntimeSpec;
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
    id: "pyrefly",
    displayName: "Python / Pyrefly",
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    repair: {
      kind: "manual",
      hint: "Install Pyrefly with pip, uv, conda, Poetry, or Pixi and ensure the pyrefly command is on PATH.",
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
  {
    id: "eslint",
    displayName: "ESLint Language Server",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
    languageIds: { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript", ".vue": "vue" },
    repair: { kind: "tool-cache-node-package", packages: ["vscode-langservers-extracted"], bin: "vscode-eslint-language-server" },
  },
  {
    id: "biome",
    displayName: "Biome Language Server",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc", ".css", ".graphql", ".gql", ".html", ".vue", ".astro", ".svelte"],
    languageIds: { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript", ".json": "json", ".jsonc": "jsonc", ".css": "css", ".graphql": "graphql", ".gql": "graphql", ".html": "html", ".vue": "vue", ".astro": "astro", ".svelte": "svelte" },
    repair: { kind: "tool-cache-node-package", packages: ["@biomejs/biome"], bin: "biome" },
  },
  {
    id: "oxlint",
    displayName: "Oxlint Language Server",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
    languageIds: { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript", ".vue": "vue", ".astro": "astro", ".svelte": "svelte" },
    repair: { kind: "manual", hint: "Install oxlint and ensure the oxlint command is on PATH." },
  },
  {
    id: "astro",
    displayName: "Astro Language Server",
    extensions: [".astro"],
    languageIds: { ".astro": "astro" },
    repair: { kind: "tool-cache-node-package", packages: ["@astrojs/language-server", "typescript"], bin: "astro-ls" },
    runtime: { command: ["astro-ls", "--stdio"], rootMarkers: ["astro.config.mjs", "astro.config.ts", "package.json"] },
  },
  {
    id: "basedpyright",
    displayName: "Python / Basedpyright",
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    repair: { kind: "manual", hint: "Install basedpyright and ensure basedpyright-langserver is on PATH." },
    runtime: { command: ["basedpyright-langserver", "--stdio"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json", "basedpyrightconfig.json"] },
  },
  {
    id: "ruff",
    displayName: "Ruff Language Server",
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    repair: { kind: "manual", hint: "Install ruff and ensure the ruff command is on PATH." },
    runtime: { command: ["ruff", "server"], rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml", "setup.py", "requirements.txt"] },
  },
  {
    id: "ty",
    displayName: "Ty Python Language Server",
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    repair: { kind: "manual", hint: "Install ty and ensure the ty command is on PATH." },
    runtime: { command: ["ty", "server"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"] },
  },
  {
    id: "ruby-lsp",
    displayName: "Ruby LSP",
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    languageIds: { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".ru": "ruby" },
    repair: { kind: "manual", hint: "Install ruby-lsp and ensure the ruby-lsp command is on PATH." },
    runtime: { command: ["ruby-lsp"], rootMarkers: ["Gemfile", ".ruby-version", "*.gemspec"] },
  },
  {
    id: "elixir-ls",
    displayName: "Elixir LS",
    extensions: [".ex", ".exs"],
    languageIds: { ".ex": "elixir", ".exs": "elixir" },
    repair: { kind: "manual", hint: "Install ElixirLS and ensure elixir-ls is on PATH." },
    runtime: { command: ["elixir-ls"], rootMarkers: ["mix.exs"] },
  },
  {
    id: "zls",
    displayName: "Zig Language Server",
    extensions: [".zig", ".zon"],
    languageIds: { ".zig": "zig", ".zon": "zig" },
    repair: { kind: "manual", hint: "Install zls and ensure the zls command is on PATH." },
    runtime: { command: ["zls"], rootMarkers: ["build.zig", "build.zig.zon"] },
  },
  {
    id: "csharp",
    displayName: "C# Language Server",
    extensions: [".cs"],
    languageIds: { ".cs": "csharp" },
    repair: { kind: "manual", hint: "Install csharp-ls and ensure the csharp-ls command is on PATH." },
    runtime: { command: ["csharp-ls"], rootMarkers: ["*.csproj", "*.sln", "global.json"] },
  },
  {
    id: "fsharp",
    displayName: "F# Language Server",
    extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
    languageIds: { ".fs": "fsharp", ".fsi": "fsharp", ".fsx": "fsharp", ".fsscript": "fsharp" },
    repair: { kind: "manual", hint: "Install fsautocomplete and ensure fsautocomplete is on PATH." },
    runtime: { command: ["fsautocomplete"], rootMarkers: ["*.fsproj", "*.sln", "global.json"] },
  },
  {
    id: "sourcekit-lsp",
    displayName: "SourceKit LSP",
    extensions: [".swift", ".m", ".mm"],
    languageIds: { ".swift": "swift", ".m": "objective-c", ".mm": "objective-cpp" },
    repair: { kind: "manual", hint: "Install Xcode or Swift toolchain and ensure sourcekit-lsp is on PATH." },
    runtime: { command: ["sourcekit-lsp"], rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"] },
  },
  {
    id: "jdtls",
    displayName: "Java / JDT LS",
    extensions: [".java"],
    languageIds: { ".java": "java" },
    repair: { kind: "manual", hint: "Install Eclipse JDT LS and ensure jdtls is on PATH." },
    runtime: { command: ["jdtls"], rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"] },
  },
  {
    id: "ocaml-lsp",
    displayName: "OCaml LSP",
    extensions: [".ml", ".mli"],
    languageIds: { ".ml": "ocaml", ".mli": "ocaml.interface" },
    repair: { kind: "manual", hint: "Install with opam install ocaml-lsp-server and ensure ocamllsp is on PATH." },
    runtime: { command: ["ocamllsp"], rootMarkers: ["dune-project", "dune", "*.opam"] },
  },
  {
    id: "texlab",
    displayName: "TeXLab",
    extensions: [".tex", ".bib"],
    languageIds: { ".tex": "latex", ".bib": "bibtex" },
    repair: { kind: "manual", hint: "Install texlab and ensure the texlab command is on PATH." },
    runtime: { command: ["texlab"], rootStrategy: "cwd" },
  },
  {
    id: "gleam",
    displayName: "Gleam Language Server",
    extensions: [".gleam"],
    languageIds: { ".gleam": "gleam" },
    repair: { kind: "manual", hint: "Install Gleam and ensure the gleam command is on PATH." },
    runtime: { command: ["gleam", "lsp"], rootMarkers: ["gleam.toml"] },
  },
  {
    id: "clojure-lsp",
    displayName: "Clojure LSP",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    languageIds: { ".clj": "clojure", ".cljs": "clojure", ".cljc": "clojure", ".edn": "edn" },
    repair: { kind: "manual", hint: "Install clojure-lsp and ensure the clojure-lsp command is on PATH." },
    runtime: { command: ["clojure-lsp", "listen"], rootMarkers: ["deps.edn", "project.clj", "bb.edn"] },
  },
  {
    id: "nixd",
    displayName: "Nixd",
    extensions: [".nix"],
    languageIds: { ".nix": "nix" },
    repair: { kind: "manual", hint: "Install nixd and ensure the nixd command is on PATH." },
    runtime: { command: ["nixd"], rootMarkers: ["flake.nix", "default.nix", "shell.nix"] },
  },
  {
    id: "tinymist",
    displayName: "Tinymist Typst Language Server",
    extensions: [".typ", ".typc"],
    languageIds: { ".typ": "typst", ".typc": "typst" },
    repair: { kind: "manual", hint: "Install tinymist and ensure the tinymist command is on PATH." },
    runtime: { command: ["tinymist"], rootStrategy: "cwd" },
  },
  {
    id: "haskell-language-server",
    displayName: "Haskell Language Server",
    extensions: [".hs", ".lhs"],
    languageIds: { ".hs": "haskell", ".lhs": "haskell" },
    repair: { kind: "manual", hint: "Install Haskell Language Server and ensure haskell-language-server-wrapper is on PATH." },
    runtime: { command: ["haskell-language-server-wrapper", "--lsp"], rootMarkers: ["hie.yaml", "stack.yaml", "cabal.project", "*.cabal"] },
  },
  {
    id: "kotlin-ls",
    displayName: "Kotlin Language Server",
    extensions: [".kt", ".kts"],
    languageIds: { ".kt": "kotlin", ".kts": "kotlin" },
    repair: { kind: "manual", hint: "Install kotlin-lsp and ensure the kotlin-lsp command is on PATH." },
    runtime: { command: ["kotlin-lsp"], rootMarkers: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"] },
  },
];

export const LANGUAGE_IDS: Record<string, string> = Object.assign({}, ...LSP_REGISTRY.map((entry) => entry.languageIds));

export const AUTO_INSTALLABLE_SERVER_IDS = LSP_REGISTRY.filter((entry) => entry.repair.kind !== "manual").map((entry) => entry.id);

export function getRepairHint(serverId: string | undefined): string | undefined {
  const repair = getRegistryEntry(serverId)?.repair;
  if (!repair) return undefined;
  if (repair.kind === "manual") return repair.hint;
  if (repair.kind === "tool-cache-node-package") return `Install with /lsp-install ${serverId}`;
  return `Install with /lsp-install ${serverId}`;
}

export function getRegistryEntry(serverId: string | undefined): LspRegistryEntry | undefined {
  return serverId ? LSP_REGISTRY.find((entry) => entry.id === serverId) : undefined;
}

