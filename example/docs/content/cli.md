---
title: CLI
description: The complete brust command reference — every command, flag, and default, verbatim from brust help.
nav: { group: "Reference", order: 9 }
---

The exact CLI surface — what `brust help` and `brust help <command>` print.
For a guided tour see [Commands](/docs/commands); this page is the verbatim
reference.

```text
Usage: brust <command> [options]
```

| Command | Summary |
|---|---|
| `build` | Compile a brust app to a self-contained `dist/` |
| `dev` | Run the dev server with hot reload |
| `new` | Scaffold a new brust project |

Global flags:

| Flag | Description |
|---|---|
| `-h, --help` | Show help (`brust help <command>` for details) |
| `-v, --version` | Show the brustjs version |

## brust build

```text
brust build [entry] [options]
```

Compile a brust app to a self-contained `dist/`.

| Flag | Description |
|---|---|
| `[entry]` | Entry file (default `./index.ts`) |
| `--out-dir <dir>` | Output directory (default `./dist`) |
| `--target <t>` | Native target(s): `auto` \| `all` \| `<platform>-<arch>[-<libc>][,…]` (default `auto`) |
| `--ssg` | Prerender static routes to HTML files after the build |
| `--ssg-out <dir>` | Output directory for prerendered HTML (default `<out-dir>/static`) |
| `--no-generator-version` | Drop the version from the generator tag + `X-Powered-By` header (name `brust` always stays) |
| `--ai` | Enable the `window.Brust` runtime chunk and route manifest in production builds |

Markdown pages: routes mounted with `mdRoutes(<contentDir>)` compile to
native jinja templates at build time and freeze into
`<out-dir>/md-manifest.json`, so the dist serves them without the markdown
content directory present.

Notes on the flags:

- `--target` accepts `auto` (the host platform), `all` (every available
  binary), or an explicit comma-separated list. `auto`/`all` cannot be
  combined with explicit targets, and an unknown or uninstalled target fails
  the build. Valid values: `darwin-x64`, `darwin-arm64`, `linux-x64-gnu`,
  `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`.
- `--ssg-out` requires `--ssg`.
- `--ai` emits the browser runtime and AI manifest, injects the runtime script,
  and writes `BRUST_AI=1` as the dist's default. An explicit `BRUST_AI`
  environment value remains authoritative when the dist starts.
- brust identifies itself with `<meta name="generator" content="brust <version>">` and an `X-Powered-By: brust/<version>` header. `--no-generator-version` keeps the name but drops the version — the decision is baked at build time, so flipping it requires a rebuild. See [Rendering](/docs/rendering) for details.

## brust dev

```text
brust dev [entry] [options]
```

Run the dev server with hot reload.

| Flag | Description |
|---|---|
| `[entry]` | Entry file (default `./index.ts`) |
| `--port <n>` | Port to listen on |
| `--no-generator-version` | Drop the version from the generator tag + `X-Powered-By` header (name `brust` always stays) |
| `--ai` | Enable the AI runtime explicitly (development already enables it) |

`--port` overrides `brust.toml` and any port passed to `brust.run()` in code
— the full precedence chain is in [Deployment](/docs/deployment).

## brust new

```text
brust new <name> [--dir <path>] [--template <name>] [--yes]
```

Scaffold a new brust project.

| Flag | Description |
|---|---|
| `<name>` | Project name (lowercase letters, digits, `-` `_`) |
| `--dir <path>` | Target directory (default `./<name>`) |
| `--template, -t <name>` | Template to scaffold (`minimal` \| `pokedex`). Prompts if omitted on a TTY; defaults to `minimal` otherwise. |
| `--yes, -y` | Skip the prompt; use the default template (`minimal`). |

`bun create brustjs <name>` runs the same scaffolder.

## Next

The other machine-facing surface — MCP tools and resources:
[Agents](/docs/agents).
