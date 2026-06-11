---
title: Deployment
description: Shipping a brust app — the self-contained dist/, BRUST_* environment, worker sizing, and the static-export alternative.
nav: { group: "Guides", order: 8 }
---

A brust app deploys in one of two shapes: a **server** — the `brust build`
output running under Bun — or a **static export** when every route can be
prerendered. This page covers the server path and points to the
[Markdown Pages guide](/docs/markdown-pages) for static.

## What brust build produces

`brust build` compiles the app into a self-contained `dist/` (see the
[CLI reference](/docs/cli) for all flags):

| Output | What it is |
|---|---|
| `index.js` | The bundled server entry (`Bun.build`, ESM, `react`/`react-dom` external). |
| `native/brust.<target>.node` | The Rust server + compiler binary, one per selected `--target`. |
| `jinja/` | Compiled native templates (TSX pages and markdown pages alike). |
| `islands/` | Prebuilt island chunks, the hydration bootstrap, and behavior-directive chunks. |
| `css/` | Tailwind output (`app.css`) and component CSS-module chunks. |
| `public/` | Your static assets, copied verbatim. |
| `mcp-manifest.json` | The extracted [agent surface](/docs/agents). |
| `md-manifest.json` | Frozen markdown route table — only when the app has `mdRoutes`. |
| `static/` | The prerendered site, only with `--ssg`. |

## Native targets

The `.node` binary is platform-specific. `--target` controls which one(s) the
build copies in:

| Value | Meaning |
|---|---|
| `auto` *(default)* | The machine you are building on. |
| `all` | Every available platform binary. |
| explicit list | Comma-separated `<platform>-<arch>[-<libc>]` values. |

The six published targets: `darwin-x64`, `darwin-arm64`, `linux-x64-gnu`,
`linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`. Cross-building for a
target requires its `brustjs-<target>` package to be installed — build on CI
matching your deploy platform, or `--target all` from a machine that has them.

## Running the server

```bash
bun dist/index.js
```

Run from the project root with dependencies installed: `react` and
`react-dom` are deliberately **not** bundled into `index.js` (bundling a
second copy would split React across two instances and break island SSR), so
they resolve from `node_modules` at runtime. The dist bundle marks itself
prebuilt — boot skips template compilation, island bundling, and manifest
extraction and serves straight from the `dist/` artifacts.

## Configuration

Precedence, low → high: framework defaults < values passed to `brust.run()` <
`brust.toml` < environment.

| Env var | `brust.toml` | Default | Meaning |
|---|---|---|---|
| `BRUST_ADDR` | `[server] address` | `localhost` | Bind address — set `0.0.0.0` in a container. |
| `BRUST_PORT` | `[server] port` | `1337` | TCP port. |
| `BRUST_WORKERS` | `[workers] count` | one per CPU | Render worker (Bun thread) count. |
| `BRUST_RENDER_SLOTS` | — | `1` | Concurrent in-flight renders **per worker**. |
| — | `[cache] max_entries` | `1000` | Response-cache capacity (entries). |
| `BRUST_DEV` | — | off | `1` forces dev mode — never set in production. |

```toml
# brust.toml
[server]
address = "0.0.0.0"
port = 8080

[workers]
count = 4
```

### Sizing workers

The default — one worker per CPU — is right for the typical case. React
rendering is CPU-bound: raising the count above the core count oversubscribes
and amplifies p99 latency rather than adding throughput. The knob that helps
is workload-dependent:

- **Native-route-heavy apps** render in Rust; workers only run loaders, so the
  default is already generous.
- **Suspense- or loader-bound React SSR** (renders that spend their time
  awaiting I/O) benefits from `BRUST_RENDER_SLOTS > 1` — multiple renders
  interleave on one worker while each waits — before it benefits from more
  workers.

## Static deploys

If every route is statically renderable, skip the server entirely:
`brust build --ssg` crawls the built app into plain HTML + assets that any
static host serves — including per-route SPA payloads, so client-side
navigation keeps working without a server. Dynamic-param, wildcard, SSE, and WebSocket routes are
excluded, any non-200 fails the build, and the export must live at a domain
root. The full walkthrough, including Cloudflare Pages settings, is in
[Markdown Pages → Static export](/docs/markdown-pages#static-export---ssg).

## Next

Every command and flag, verbatim: [CLI](/docs/cli).
