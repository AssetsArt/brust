---
title: Project Structure
description: The scaffold layout, brust.toml configuration, the .brust/ cache, and public/ assets.
nav: { group: "Getting Started", order: 4 }
---

A scaffolded brust project (the `minimal` template) looks like this:

```text
my-app/
├── index.ts                 # entry — brust.run({ routes, entry: import.meta.url })
├── routes.tsx               # the route table (defineRoutes)
├── pages/
│   └── Home.tsx             # a native route page (BrustPage document shell)
├── components/
│   └── Counter.tsx          # an island component
├── app.css                  # stylesheet entry (Tailwind v4: @import "tailwindcss")
├── public/
│   └── favicon.svg          # static assets, served at the site root
├── package.json
├── tsconfig.json
└── .gitignore               # ignores node_modules/, .brust/, dist/, brust.toml
```

Only `index.ts` and `routes.tsx` are structurally required; `pages/` and
`components/` are conventions. The scaffolded `package.json` wires three
scripts: `dev` (`brustjs dev`), `build` (`brustjs build`), and `preview`
(`bun run ./dist/index.js`).

## brust.toml

Server configuration lives in an optional `brust.toml` at the project root.
A missing file is fine — defaults apply.

```toml
[server]
address = "0.0.0.0"   # default "localhost"
port = 8080            # default 1337

[workers]
count = 4              # default: one per CPU (availableParallelism)

[cache]
max_entries = 2000        # L1 response-cache capacity; default 1000
page_max_entries = 2000   # L2 page-cache capacity; default 1000
```

| Key | Type | Default | Env override |
|---|---|---|---|
| `server.address` | string | `localhost` | `BRUST_ADDR` |
| `server.port` | integer 1–65535 | `1337` | `BRUST_PORT` |
| `workers.count` | positive integer | CPU count | `BRUST_WORKERS` |
| `cache.max_entries` | positive integer | `1000` | — |
| `cache.page_max_entries` | positive integer | `1000` | — |

Precedence, lowest to highest: framework defaults → values passed to
`brust.run()` in code → `brust.toml` → environment variables. So
`brust dev --port 3000` (which sets `BRUST_PORT`) always wins, and a deploy
can override everything with `BRUST_ADDR` / `BRUST_PORT` / `BRUST_WORKERS`
without touching the file. A present-but-malformed `brust.toml` is a hard
error at boot.

## `brust.run()` options

`brust.run({...})` is the entry call. Every field:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `routes` | `FlatRoute[]` | — (required) | The route table from `defineRoutes()`. |
| `entry` | `string` | — (required) | `import.meta.url` of the entry file — anchors route/island scanning. |
| `scanRoot` | `string` | dir of `entry` | Directory scanned for routes and island sources. |
| `address` | `string` | `localhost` | Host/address to bind. |
| `port` | `number` | `1337` | TCP port to bind. |
| `actions` | `ActionsBuilder` | — | Server actions from `defineActions(...)`. Omit if the app has none. |
| `actionPrefix` | `string` | `/_brust/action` | URL prefix the action router mounts under. |
| `serve` | `Partial<ServeOptions>` | — | Lower-level server overrides merged into the listener: `tuning` (worker/connection limits — see [Deployment](/docs/deployment)), TLS, and the `generator` / `X-Powered-By` controls (see [Rendering](/docs/rendering)). |
| `sabBytes` | `number` | `262144` (256 KB) | SharedArrayBuffer size per render worker. |
| `dev` | `boolean` | `false` | Dev mode — hot reload, file watcher, dev WS, TUI. Also enabled by `BRUST_DEV=1`. |

`address` and `port` are overridable at runtime; `brust.toml` and environment
variables win over what you pass here (see the precedence note above).

The scaffold gitignores `brust.toml`, treating it as per-machine
configuration; commit it if your team prefers shared settings.

## The .brust/ cache directory

`brust dev` and `brust build` write compiled artifacts into `.brust/` in the
working directory. It is gitignored and safe to delete — it is regenerated on
the next dev boot or build. Inside you will find, depending on what the app
uses:

| Path | Contents |
|---|---|
| `.brust/jinja/` | Native route components compiled to templates |
| `.brust/islands/` | Bundled island chunks and the island manifests |
| `.brust/css/` | Extracted component CSS |
| `.brust/md-manifest.json` | Frozen markdown-route manifest (when using `mdRoutes`) |
| `.brust/mcp-manifest.json` | The generated MCP tool/resource manifest |
| `.brust/ai-manifest.json` | Route map for the [AI agent runtime](/docs/agents) — served at `/_brust/ai/manifest.json` when the runtime is enabled |

If a native page renders stale markup after you change the framework or move
files around, deleting `.brust/` is the reset button.

## public/

Files under `public/` are served at the site root: `public/favicon.svg` is
available as `/favicon.svg`. The directory is detected at boot and served by
the Rust side with `Cache-Control: public, max-age=3600` in production builds
(`no-store` in dev). `brust build` copies `public/` into the output directory
so the built app is self-contained.

## Next

The full CLI surface: [Commands](/docs/commands).
