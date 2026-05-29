# pi-lsp

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

`pi-lsp` gives Pi a small local LSP layer: enough editor intelligence for an agent, without turning Pi into an IDE.

It does two things:

- exposes an `lsp` tool for explicit model queries like diagnostics, hover, symbols, definitions, and references
- watches files the agent edits and posts LSP diagnostics back into the session

The goal is simple: when the agent writes broken code, it should get the same kind of feedback a human gets from an editor.

## Install

```bash
pi install git:github.com/edxeth/pi-lsp
```

## Quick start

Turn automatic diagnostics on or off with:

```text
/lsp
```

Check why a file is or is not using LSP:

```text
/lsp-doctor src/index.ts
```

Install a known language server into Pi's cache:

```text
/lsp-install typescript
```

Update/reinstall a cached server:

```text
/lsp-update typescript
```

Ask the model to query LSP directly:

```text
Use lsp action=diagnostics file=src/index.ts severity=all
Use lsp action=hover file=src/index.ts query=myFunction
Use lsp action=references file=src/index.ts query=myFunction
```

## What the automatic hook does

When the agent edits or writes a supported source file, `pi-lsp` remembers that file.

Depending on `/lsp` settings, diagnostics run either:

- once at the end of the agent turn
- after each edit/write, appended to that tool result before the next model turn
- never, if disabled

Diagnostics show up as a compact block:

```text
LSP diagnostics src/example.ts
ERROR [12:7] Type 'number' is not assignable to type 'string'.
HINT [12:7] 'value' is declared but its value is never read.
```

Missing language servers are reported once per session/root/language, not on every edit. Deleted or renamed files are ignored rather than producing stale “file not found” noise.

## The `lsp` tool

The tool is for explicit queries. The hook is passive feedback; the tool is active investigation.

Supported actions:

- `diagnostics`
- `workspace-diagnostics`
- `symbols`
- `hover`
- `definition`
- `references`
- `signature`
- `rename` preview
- `codeAction` preview
- `restart`

Useful parameters:

- `file`
- `files`
- `line`
- `column`
- `query`
- `severity`
- `newName`

For many position-based actions, `query` can be used instead of an exact line/column. The extension resolves the symbol position before making the LSP request.

## Language servers

`pi-lsp` keeps a curated registry of known servers. It does not scrape npm, guess package names, or mutate your project by default.

| ID | Language/server | Install behavior |
| --- | --- | --- |
| `typescript` | TypeScript / JavaScript | Pi-cache npm package |
| `vue` | Vue | Pi-cache npm package |
| `svelte` | Svelte | Pi-cache npm package |
| `pyright` | Python / Pyright | Pi-cache npm package |
| `pyrefly` | Python / Pyrefly | manual hint |
| `bash` | Bash / shell scripts | Pi-cache npm package |
| `yaml-ls` | YAML | Pi-cache npm package |
| `dockerfile` | Dockerfile | Pi-cache npm package |
| `php-intelephense` | PHP / Intelephense | Pi-cache npm package |
| `gopls` | Go | Pi-cache `go install` |
| `prisma` | Prisma | manual hint |
| `terraform` | Terraform | manual hint |
| `clangd` | C / C++ / Objective-C | manual hint |
| `lua-ls` | Lua | manual hint |
| `rust-analyzer` | Rust | manual hint |
| `dart` | Dart / Flutter | manual hint |

“Pi-cache” means the server is installed under:

```text
~/.pi/cache/lsp
```

Binaries are linked under:

```text
~/.pi/cache/lsp/bin
```

You can override this location with:

```bash
PI_LSP_CACHE_DIR=/some/other/cache
```

Node-based installs use Pi's configured `npmCommand` from the active agent settings file. So if your Pi settings say:

```json
{
  "npmCommand": ["bun"]
}
```

then `/lsp-install typescript` uses `bun add ...` inside Pi's LSP cache.

If `PI_CODING_AGENT_DIR` is set, settings are read from:

```text
$PI_CODING_AGENT_DIR/settings.json
```

## Resolution order

When a file has a recognized project root, `pi-lsp` looks for the server in this order:

```text
project-local binary
Pi LSP cache
global/PATH/common locations
```

This is intentional.

Project-local binaries are the project contract. Pi-cache binaries are what `/lsp-install` and `/lsp-update` manage. Global binaries are a fallback.

For TypeScript/JavaScript, the order is a little more specific:

```text
node_modules/.bin/tsgo
node_modules/.bin/typescript-language-server
~/.pi/cache/lsp/bin/tsgo
~/.pi/cache/lsp/bin/typescript-language-server
global tsgo
global typescript-language-server
```

Deno projects are skipped intentionally when `deno.json` or `deno.jsonc` is found.

## Root detection

`pi-lsp` only starts a server when it can find a reasonable root. A few examples:

| Server | Root markers |
| --- | --- |
| TypeScript / JavaScript | `package.json`, `tsconfig.json`, `jsconfig.json` |
| Vue | `package.json`, `vite.config.ts`, `vite.config.js` |
| Svelte | `package.json`, `svelte.config.js` |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt`, `pyrightconfig.json` |
| Python / Pyrefly | `pyrefly.toml` |
| Go | `go.work`, `go.mod` |
| Rust | `Cargo.toml` |
| Dart / Flutter | `pubspec.yaml`, `analysis_options.yaml` |
| PHP | `composer.json`, `composer.lock`, `.php-version` |
| Lua | `.luarc.json`, `.luarc.jsonc`, `.luacheckrc`, `.stylua.toml`, `stylua.toml`, `selene.toml`, `selene.yml` |
| clangd | `compile_commands.json`, `compile_flags.txt`, `.clangd` |

Some lightweight servers use the current working directory as root, for example shell scripts and Dockerfiles.

## Commands

### `/lsp`

Opens the diagnostics settings UI.

Modes:

- `At agent end`
- `After each edit/write`
- `Disabled`

Scope:

- session only
- global

### `/lsp-doctor <file>`

Shows what `pi-lsp` sees for one file:

```text
/lsp-doctor src/index.ts
```

Example output:

```text
file: /repo/src/index.ts
status: ok
server: typescript
root: /repo
binary: /repo/node_modules/.bin/typescript-language-server
```

If the server is missing and the registry knows how to repair it, doctor shows the exact install command and offers to run it.

### `/lsp-install <server>`

Installs a known server into Pi's LSP cache. It does not add dependencies to the current project.

```text
/lsp-install pyright
/lsp-install gopls
/lsp-install yaml-ls
```

Manual-only servers print a hint instead of trying to install toolchains or SDKs behind your back.

### `/lsp-update <server>`

Runs the same install plan again. This is the update path for Pi-managed servers.

```text
/lsp-update typescript
```

If you already have a global server and then run `/lsp-update`, the Pi-cache version wins afterward. That is the point: update means “use the Pi-managed one from now on.”

### `/lsp-restart`

Restarts all running LSP clients.

Use it after installing a server, changing environment variables, or when diagnostics feel stale.

## Behavior notes

- Unsupported files stay quiet.
- Missing servers produce one deduped notice per root/language.
- The edit/write hook blocks the next model turn, but it cannot serialize sibling tool calls that the runtime already launched in the same assistant message.
- The hook does not interrupt the agent mid-edit with install prompts.
- Install/update commands are explicit and confirmed in the TUI.
- `rename` and `codeAction` are preview-only today.
- Bash command path detection is best-effort. It only tracks obvious supported source paths mentioned in the command.
- Large TypeScript/Rust/Go projects may need a longer cold-start window; `pi-lsp` already gives these languages more time than the default.

## Development

```bash
bun test
bun run check
```

For live extension checks, load this package explicitly:

```bash
pi --no-extensions -e ./src/index.ts --no-session
```

Use a temporary cache when testing installs:

```bash
PI_LSP_CACHE_DIR=/tmp/pi-lsp-test-cache pi --no-extensions -e ./src/index.ts --no-session
```
