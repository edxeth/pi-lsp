# pi-lsp

Local Language Server Protocol extension for pi.

`pi-lsp` adds three pieces of functionality:

- an `lsp` tool for on-demand LSP queries
- a `/lsp` command for configuring automatic diagnostics
- a `/lsp-doctor <file>` command for inspecting root and binary detection

It is optimized for day-to-day JavaScript, TypeScript, and Go work, but also supports Python, Dart, Vue, Svelte, and Rust.

## Install

```bash
pi install git:github.com/edxeth/pi-lsp
```

## What it does

### 1. Manual LSP tool

The `lsp` tool lets the model query language servers directly for:

- definitions
- references
- hover
- signature help
- document symbols
- diagnostics
- workspace diagnostics across multiple files
- rename
- code actions
- restart

This is useful when you want the model to answer questions like:

- "Where is this symbol defined?"
- "Find all references to this function"
- "What type is this value?"
- "Check these files for diagnostics"
- "What quick fixes exist here?"

### 2. Automatic diagnostics hook

The `/lsp` command configures when diagnostics run automatically:

- **At agent end**: run once after the agent finishes its response
- **After each edit/write**: run immediately after each edit or write
- **Disabled**: turn off the automatic hook entirely

The setting can be applied to:

- **Session only**
- **Global (all sessions)**

### 3. LSP doctor

The `/lsp-doctor <file>` command shows how `pi-lsp` is interpreting a file:

- detected status
- chosen language server
- detected project root
- resolved binary path
- unsupported or missing-binary reason

Example:

```text
/lsp-doctor src/cli/args.ts

file: /path/to/project/src/cli/args.ts
status: ok
server: typescript
root: /path/to/project
binary: /home/user/.bun/bin/typescript-language-server
```

## Supported languages

`pi-lsp` currently supports:

- **JavaScript / TypeScript** via `tsgo` or `typescript-language-server`
- **Go** via `gopls`
- **Python** via `pyright-langserver`
- **Dart / Flutter** via `dart language-server`
- **Vue** via `vue-language-server`
- **Svelte** via `svelteserver`
- **Rust** via `rust-analyzer`

## Project root detection

The extension only activates LSP for files that belong to a recognized project root.

### JavaScript / TypeScript

Root markers:

- `package.json`
- `tsconfig.json`
- `jsconfig.json`

Notes:

- nearest matching config wins
- **Deno** projects are intentionally skipped if `deno.json` or `deno.jsonc` is found

### Go

Root markers:

- `go.work`
- `go.mod`

Notes:

- `go.work` is preferred when present
- this works well for Go workspaces and multi-module repos

### Python

Root markers:

- `pyproject.toml`
- `setup.py`
- `requirements.txt`
- `pyrightconfig.json`

### Dart / Flutter

Root markers:

- `pubspec.yaml`
- `analysis_options.yaml`

### Vue

Root markers:

- `package.json`
- `vite.config.ts`
- `vite.config.js`

### Svelte

Root markers:

- `package.json`
- `svelte.config.js`

### Rust

Root markers:

- `Cargo.toml`

## Binary detection

Once a root is found, `pi-lsp` looks for the language-server binary.

### JavaScript / TypeScript order

For JS/TS projects, the detection order is:

1. local `node_modules/.bin/tsgo`
2. global `tsgo`
3. local `node_modules/.bin/typescript-language-server`
4. global `typescript-language-server`

This makes local project tools win when available.

### Other languages

For the other supported languages, detection checks:

- local `node_modules/.bin/...` when applicable
- `PATH`
- additional common binary locations

Extra search locations include:

- `/usr/local/bin`
- `/opt/homebrew/bin`
- `~/.bun/bin`
- `$BUN_INSTALL/bin`
- `~/.pub-cache/bin`
- `~/fvm/default/bin`
- `~/go/bin`
- `~/.cargo/bin`

This means Bun-global installs are supported automatically for binaries such as:

- `typescript-language-server`
- `pyright-langserver`

## Commands

### `/lsp`

Opens the auto-diagnostics settings UI.

You can choose:

- `After each edit/write`
- `At agent end`
- `Disabled`

And then choose scope:

- `Session only`
- `Global (all sessions)`

### `/lsp-restart`

Restarts all running LSP servers.

Use this if:

- a language server gets stuck
- diagnostics seem stale
- you changed tool installation or environment variables and want a fresh start

### `/lsp-doctor <file>`

Shows how the extension resolves a file.

Use this when:

- a file is not getting diagnostics
- you are unsure which root was selected
- you want to confirm that the expected language-server binary is being used

## The `lsp` tool

Supported actions:

- `definition`
- `references`
- `hover`
- `symbols`
- `diagnostics`
- `workspace-diagnostics`
- `signature`
- `rename`
- `codeAction`
- `restart`

### Parameters

Common parameters:

- `file`
- `files`
- `line`
- `column`
- `endLine`
- `endColumn`
- `query`
- `newName`
- `severity`

### Notes

- position-based actions can use `line` + `column`
- for many actions, `query` can be used instead of an exact position if the symbol can be found in the file
- `workspace-diagnostics` accepts multiple files
- `severity` can filter results: `all`, `error`, `warning`, `info`, `hint`

## Automatic diagnostics behavior

The auto hook is designed to avoid bloating context unnecessarily.

### What it tracks

It only tracks files from supported LSP-backed extensions that were touched by:

- `edit`
- `write`
- manual `lsp` interactions

### What it skips

It does **not** automatically run diagnostics for unsupported files such as:

- Markdown
- plain text
- arbitrary config files with no registered LSP mapping

So unsupported files do not get added to the LSP diagnostics summary and do not generate extra LSP context noise.

### Agent-end mode

In `At agent end` mode:

- touched compatible files are collected during the response
- diagnostics run once at the end
- the result is posted as a single diagnostics message

This is usually the best default if you want less interruption.

### Edit/write mode

In `After each edit/write` mode:

- diagnostics run immediately after each edit or write
- results are appended sooner
- this is more interactive but can be noisier

## Performance characteristics

`pi-lsp` keeps LSP usage bounded.

### Reuse

- one LSP client is reused per detected project root
- clients are kept around across turns until idle shutdown

### Open file limits

- open files are managed with an LRU strategy
- maximum open files per LSP client: **30**

### Idle cleanup

- idle files are closed automatically
- all LSP servers are shut down after a period of post-agent inactivity

### Warmup

On session start, the extension can warm up an LSP client based on common root markers such as:

- `package.json`
- `tsconfig.json`
- `jsconfig.json`
- `go.work`
- `go.mod`
- `pyproject.toml`
- `pubspec.yaml`
- `Cargo.toml`

## Language-specific notes

### JavaScript / TypeScript

- prefers `tsgo` when available because it is typically faster
- otherwise uses `typescript-language-server`
- Deno roots are intentionally excluded

### Go

- supports both `go.work` and `go.mod`
- uses a slightly longer diagnostics wait window than the default to reduce false timeouts on cold starts

### Rust

- `rust-analyzer` can be noticeably slow on cold startup
- first diagnostics may take longer on larger projects

### Dart / Flutter

- if a Flutter project is detected, the extension tries to use the Dart binary associated with Flutter when possible

## Installation / packaging

This directory is a standard pi extension package.

Important files:

- `index.ts` — entry point loading both tool and hook
- `lsp-core.ts` — LSP manager, root detection, and protocol logic
- `lsp-tool.ts` — `lsp` tool implementation
- `lsp.ts` — hook commands, auto diagnostics, and `/lsp-doctor`
- `package.json` — extension metadata and dependencies

### If you copy or zip this extension

If the package is copied without `node_modules`, run:

```bash
npm install
```

inside the `pi-lsp` directory before using it.

## Examples

### Diagnose why a TypeScript file is not working

```text
/lsp-doctor src/index.ts
```

### Check diagnostics manually

```text
Use lsp action=diagnostics file=src/index.ts severity=error
```

### Check several files at once

```text
Use lsp action=workspace-diagnostics files=["src/a.ts","src/b.ts"] severity=warning
```

### Restart LSP servers

```text
/lsp-restart
```

## Caveats

- unsupported file types are ignored by the auto hook
- Deno projects are intentionally skipped by the JS/TS LSP integration
- a recognized project root is required before a server will start
- the language-server binary still has to be installed somewhere discoverable

## Summary

Use:

- `/lsp` to control auto diagnostics
- `/lsp-doctor <file>` to inspect resolution and troubleshoot detection
- `lsp` tool calls when the model needs direct language-server data

For JS/TS/Go-heavy workflows, this setup should be a solid default with low noise and useful diagnostics.
