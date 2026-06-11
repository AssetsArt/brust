---
title: Installation
description: Scaffold a brust project with bun create, or add brustjs to an existing app.
nav: { group: "Getting Started", order: 2 }
---

brust is published on npm as `brustjs` (the `brust` name was taken). The
current version is `0.1.40-alpha`.

## Requirements

- **Bun ≥ 1.4** — brust is a Bun framework; it does not run on Node.js.
- **macOS or Linux** (glibc or musl). Prebuilt native binaries ship as
  platform packages, so you do not need a Rust toolchain.
- **React 19** — `react` and `react-dom` `^19.2.6` are peer dependencies.
  The scaffold includes them.

## Scaffold a new project

```bash
bun create brustjs my-app
cd my-app
bun install
bun run dev          # → http://localhost:1337
```

`bun create brustjs` forwards to brust's own scaffolder, so the templates and
the pinned `brustjs` version are owned by the framework package.

### Templates

Two templates are available:

| Template | Description |
|---|---|
| `minimal` | One native route with a client island and an ISR-cached server island. The default. |
| `pokedex` | A larger example app: actions, zod schemas, lucide icons, Tailwind styling. |

On an interactive terminal the scaffolder prompts you to pick one; pass
`--template <name>` (or `-t`) to choose explicitly, or `--yes` (`-y`) to skip
the prompt and take `minimal`.

### `brust new`

The same scaffolder is available as a CLI command if you install `brustjs`
globally:

```bash
bun add --global brustjs
brustjs new my-app --template minimal
```

`brust new <name>` accepts:

| Flag | Description |
|---|---|
| `<name>` | Project name — lowercase letters, digits, `-`, `_` |
| `--dir <path>` | Target directory (default `./<name>`) |
| `--template, -t <name>` | Template: `minimal` or `pokedex` |
| `--yes, -y` | Skip the prompt; use the default template |

The target directory must be empty (or not exist yet).

## Add to an existing project

```bash
bun add brustjs react react-dom
```

Then create an `index.ts` entry and a `routes.tsx` — see
[Your First Route](/docs/first-route) for the minimum viable app.

## A note on versions

brust is in alpha. During the alpha period the npm `latest` dist-tag tracks
the newest alpha release, so plain `bun add brustjs` and `bun create brustjs`
get the current prerelease without a version suffix. If you want to stay on
the alpha channel explicitly once a stable version ships, pin it:

```bash
bun add brustjs@alpha
```

## Next

Write and run a route: [Your First Route](/docs/first-route).
