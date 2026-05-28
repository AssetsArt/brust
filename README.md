# Brust

**B**un + **Rust** — an SSR framework that bursts.

React on the server. Rust everywhere else. One Bun host process; Rust loaded as
a `.node` native module via napi-rs. The HTTP accept loop is pure Rust; renders
are dispatched into Bun Worker threads through `ThreadsafeFunction`, and HTML
flows back via per-worker `SharedArrayBuffer`.

```
127,113 RPS  GET /ping              (p50 0.13ms · p99 0.22ms)
121,013 RPS  POST server action     (p50 0.14ms · p99 0.23ms)
 16,301 RPS  GET / (SSR React)      (p50 0.58ms · p99 17.85ms)
```

Benchmarked with `oha -c 120 -z 10s` on darwin/arm64, Bun 1.4 — re-run on
2026-05-28 after the atomic-claim fix. Full table in [`bench/RESULTS.md`](./bench/RESULTS.md).
Same hardware: Bun.serve + `renderToString` does 17k RPS on `/`. The Rust HTTP
layer is where the headroom lives — `/ping` and the server-action POST path
(both bypass React but cross the napi+SAB boundary) sustain >120k RPS.

The `/` SSR number is honestly down from the pre-CSS-pipeline 54k. The drop
appears to come from features that landed between the May-24 bench and now
(CSS-link injection, dev-client injection, Tailwind v4 in the example) — not
from the atomic-claim refactor (POST through the same worker pool actually
doubled). Investigating the per-request injection overhead is a tracked
follow-up.

---

## Why

Traditional SSR frameworks make you pay three times:

1. Server renders HTML.
2. Client downloads the entire framework bundle.
3. Client re-runs everything to "hydrate".

Brust pays once. Server renders. Client resumes only the parts you mark as
islands.

Designed agent-first too: routes ship machine-readable schemas (server fns as
MCP tools, loaders as resources) so AI agents can drive the app without
scraping the DOM.

---

## Quick start

Prerequisites: [Bun](https://bun.sh) ≥ 1.4 and a Rust toolchain (the native
module is built once via napi-rs).

```bash
git clone <this-repo> brust && cd brust
bun install
cd runtime && bun run build && cd ..
bun run example/hello-world/index.ts
# → http://127.0.0.1:3000
```

Then in another terminal:

```bash
curl http://127.0.0.1:3000/ping           # → pong
curl http://127.0.0.1:3000/                # → SSR HTML with a hydrated <Counter />
curl -N http://127.0.0.1:3000/sse-counter # → 3 SSE frames
```

The example app in [`example/hello-world/`](./example/hello-world) showcases
each major feature in one route apiece — see its
[README](./example/hello-world/README.md) for the map.

---

## CLI

```
brust dev   <entry>             # boot dev mode + watcher + WS + browser auto-reload
brust build <entry> --out-dir D # emit a self-contained ./dist/
brust new   <name>              # scaffold a fresh project (see Status: partial)
```

Production deploy: `brust build`, then `bun run dist/index.js`. The dist
directory contains the bundled server, prebuilt islands, MCP manifest, the
native `.node` for the target platform, and compiled CSS — no further build
work at boot.

---

## What's in the box

**Shipped:**

- HTTP/1.1 in Rust (custom tokio/tokio-uring accept loop, prespawned worker
  tasks over a `flume` MPMC channel, per-worker SAB for zero-copy results).
- React 18 SSR via `renderToPipeableStream` + auto-detect Suspense; chunks
  stream over `Transfer-Encoding: chunked`.
- Islands (manual `<Island>` wrapper today — `"use island"` directive is
  designed, not yet built).
- Nested routes with dynamic params; per-route loaders that hand a typed `data`
  prop to the component.
- Server actions (`"use server"` directive) bundled to per-action endpoints;
  client-side helper auto-rewrites form `action` and `fetch` targets.
- Server-Sent Events and WebSockets as first-class route shapes.
- Forms + multipart, navigation interception (turns same-origin `<a>` clicks
  into JSON page-fetches and swaps `<main>`).
- Tailwind v4 + component CSS imports + CSS Modules (route-level today;
  islands wait on an upstream Bun bundler fix).
- Streaming HTML, request-scoped middleware (per-route + global set/override),
  in-process LRU cache with TTL.
- Build CLI (`brust build`) producing a self-contained `./dist/`.
- Dev CLI (`brust dev`) with file watcher, WebSocket reload channel, CSS hot
  swap, ANSI TUI, red error overlay (TS-reload partial — see below).
- MCP-style schemas: server fns and routes expose tool/resource descriptors at
  `/_brust/mcp` so AI agents can call them without scraping.

**Partial / known limitations:**

- `brust dev` TS reload — workers respawn cleanly but the Rust `WorkerPool`
  retains stale entries; small napi `clear_pool` is the unblock. CSS-only edits
  work fully.
- `brust new` end-to-end — the scaffolder creates a valid project tree, but
  `bun install` + `bun run dev`/`build` from the scaffolded project hits a
  dual-React copy because Bun's `file:` install symlinks individual source
  files back to the brust repo. Fix is a workspace restructure of this repo.
- Islands + `.module.css` — same upstream Bun bundler collision. Route-level
  components import `.module.css` freely.

**Designed, not built:** content-hashed island filenames, `"use island"`
auto-detection, React Fast Refresh, single-binary deploy
(`bun build --compile`), TOML `[cache]` + `[build]` sections, response-header
deletion channel for middleware, `brust invalidate`. See
[`architecture.md`](./architecture.md) for the full roadmap.

---

## Architecture

The full architecture document — hosting model, request lifecycle, napi IPC
layout, SAB protocol, slot-ownership invariants, every shipped subsystem —
lives in [`architecture.md`](./architecture.md). It's the source of truth for
how brust is structured; this README is the elevator pitch.

Specs and implementation plans for each subsystem are in
[`docs/superpowers/specs/`](./docs/superpowers/specs/) and
[`docs/superpowers/plans/`](./docs/superpowers/plans/).

---

## Development

```bash
cargo test --lib                # 99 pass — Rust unit tests
bun test runtime/               # 188 pass — TS unit tests
bun test tests/                 # ~100 pass — integration + CLI
bun run bench                   # regenerates bench/RESULTS.md
```

Repo layout:

```
src/             Rust crate (accept loop, worker pool, napi exports)
runtime/         Bun-side runtime: routing, render, actions, dev/build CLI
runtime/cli/     brust build | brust dev | brust new
example/         The hello-world demo app
tests/           Integration + CLI tests
bench/           Benchmark harness + last results
docs/            Specs, plans, internal notes
architecture.md  Full architecture document
```

---

## Status

Pre-publish. Solo-developed; not yet on npm. The framework runs and benchmarks
above are reproducible today, but the consumer install path (`bunx brust new`)
waits on the workspace restructure noted above. Until then, the supported flow
is "clone this repo and run the example."

---

*Brust — built to burst.*
