---
title: Commands
description: The brust CLI — dev, build, and new.
nav: { group: "Getting Started", order: 5 }
---

The CLI installs as the `brustjs` binary (scaffolded projects call it from
the `dev` and `build` scripts). Run `brust help <command>` for the same
information in your terminal.

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

## brust dev

```text
brust dev [entry] [options]
```

| Flag | Description |
|---|---|
| `[entry]` | Entry file (default `./index.ts`) |
| `--port <n>` | Port to listen on |

`--port` takes precedence over `brust.toml` and any port passed to
`brust.run()` in code — see
[configuration precedence](/docs/project-structure).

## brust build

```text
brust build [entry] [options]
```

| Flag | Description |
|---|---|
| `[entry]` | Entry file (default `./index.ts`) |
| `--out-dir <dir>` | Output directory (default `./dist`) |
| `--target <t>` | Native target(s): `auto` \| `all` \| `<platform>-<arch>[-<libc>][,…]` (default `auto`) |
| `--ssg` | Prerender static routes to HTML files after the build |
| `--ssg-out <dir>` | Output directory for prerendered HTML (default `<out-dir>/static`) |

`--target auto` builds for the machine you are on; `all` bundles every
supported platform; or list explicit targets, comma-separated, in
`<platform>-<arch>[-<libc>]` form (for example `linux-x64-musl`).

Markdown pages: routes mounted with `mdRoutes(<contentDir>)` compile to
native templates at build time and freeze into `<out-dir>/md-manifest.json`,
so the dist serves them without the markdown content directory present.

## brust new

```text
brust new <name> [--dir <path>] [--template <name>] [--yes]
```

| Flag | Description |
|---|---|
| `<name>` | Project name (lowercase letters, digits, `-` `_`) |
| `--dir <path>` | Target directory (default `./<name>`) |
| `--template, -t <name>` | Template to scaffold (`minimal` \| `pokedex`). Prompts if omitted on a TTY; defaults to `minimal` otherwise. |
| `--yes, -y` | Skip the prompt; use the default template (`minimal`). |

`bun create brustjs <name>` runs the same scaffolder — see
[Installation](/docs/installation).
