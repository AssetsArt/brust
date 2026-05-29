# Brust

**B**un + **Rust** — an SSR framework that bursts.

React on the server. Rust everywhere else. One Bun host process; Rust loaded as
a `.node` native module via napi-rs. The HTTP accept loop is pure Rust; renders
are dispatched into Bun Worker threads through `ThreadsafeFunction`, and HTML
flows back via per-worker `SharedArrayBuffer`.

```
111,819 RPS  GET /ping                     pure Rust, no JS    (range 106–113k)
 61,065 RPS  GET /native-profile/:user     native jinja        (range 60.9–61.2k)
 60,486 RPS  POST server action            crosses to a worker (range 60.3–60.6k)
 31,788 RPS  GET / (SSR React)             renderToString      (range 31.6–31.9k)
```

N=5 medians, `oha -c 120 -z 10s` with a 3s discarded JIT warm-up burst per probe
(a plain sleep warms nothing — V8 JIT-compiles the render path only after real
traffic), darwin/arm64 (M1 Pro, 10c), Bun 1.4, React 19. Last run's full latency
table in [`bench/RESULTS.md`](./bench/RESULTS.md). Same-hardware JS baselines on
the identical HelloWorld render: `Bun.serve + renderToString` does **17.6k** RPS
on `/`, **Elysia 17.8k** — the two are indistinguishable because `renderToString`
dominates and the HTTP framework barely shows. Brust's React `/` (31.8k) is
**~1.8×** both, from the Rust HTTP layer + keep-alive, not a faster React. Every
row holds <1% run-to-run spread except `/ping` (~6%), which at >100k RPS is most
sensitive to sharing cores with the load generator.

### Where the time goes

There are two performance tiers, and the boundary between them is the napi
crossing — not anything in the app:

- **Pure-Rust path (`/ping`): ~110k RPS.** No worker, no JS. This is the Rust
  HTTP layer's ceiling on this box.
- **Any route that crosses into a Bun worker: ~60k RPS floor.** A null-handler
  probe (a renderer that does *zero* JS work — no `JSON.parse`, no dispatch,
  just hands back a precomputed response) measures **60k**. So ~60k is the
  irreducible cost of one `ThreadsafeFunction` round-trip (tokio ↔ V8 isolate);
  the per-request JS work on top of it costs ~1k. Actions and native routes now
  sit *at* that floor.

Getting there took collapsing the worker→Rust hop for single-chunk responses.
Previously every response — even a tiny action — flowed back through the chunk
channel: `napi_render_chunk → mpsc → ack → resolve`, four Rust↔JS crossings.
The **single-chunk fast lane** has the worker write the framed response
`[meta_len][meta][body]` straight into the SAB and resolve its render Promise
with the byte length; Rust reads the SAB directly (two crossings, no channel).
Combined with making the jinja render a synchronous napi call and a
**lock-free worker claim** (`AtomicBool` CAS instead of a per-entry mutex —
the exclusivity gate for every render path, plus a fully channel-free,
mutex-free `dispatch_single_chunk` for actions and native routes):

| Path | before | after |
|---|---:|---:|
| POST server action | 48.7k | **60.5k** (+24%) |
| GET native jinja route | 49.6k | **61.1k** (+23%) |

The lock-free claim itself was worth only ~3% — proof that worker-pool lock
contention was never the bottleneck. To go faster than the ~60k worker floor
you have to *not cross* (render fully Rust-side) or *amortize the crossing*
(batch multiple requests per tsfn call). React SSR `/` sits at ~32k because it's
render-bound (`renderToString` time), not crossing-bound — which is also why the
JS-framework baselines (Bun.serve, Elysia) all land at the same ~17.6k. See
[`architecture.md`](./architecture.md) for the full request lifecycle and SAB
protocol.

---

## Why

Traditional SSR frameworks make you pay three times:

1. Server renders HTML.
2. Client downloads the entire framework bundle.
3. Client re-runs everything to "hydrate".

Brust pays once. Server renders. Client resumes only the parts you mark as
islands.

For pages that need no client JS at all, mark the route `native: true` — brust
compiles its JSX to a jinja template at build time and renders it entirely
Rust-side (`minijinja`), skipping React on the server while still running your
loader. That's the `/native-profile/:user` row above.

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
cd runtime && bun run build && cd ..   # release; NOT build:debug (~2× slower)
bun run example/hello-world/index.ts
# → http://127.0.0.1:3000
```

Then in another terminal:

```bash
curl http://127.0.0.1:3000/ping                   # → pong
curl http://127.0.0.1:3000/                        # → SSR HTML with a hydrated <Counter />
curl http://127.0.0.1:3000/native-profile/World    # → Rust-rendered jinja, no React
curl -N http://127.0.0.1:3000/sse-counter          # → 3 SSE frames
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
native `.node` for the target platform, compiled CSS, and emitted jinja
templates — no further build work at boot.

---

## What's in the box

**Shipped:**

- HTTP/1.1 in Rust (custom tokio accept loop, `tokio-uring` on Linux; per-worker
  SAB for zero-copy results; lock-free `AtomicBool`-CAS worker claim).
- React 18 SSR via `renderToPipeableStream` + auto-detect Suspense; chunks
  stream over `Transfer-Encoding: chunked`.
- Single-chunk **fast lane**: actions, native routes, and no-Suspense renders
  return their framed response through the render Promise (one tsfn round-trip,
  no chunk-channel hop).
- `native: true` routes — JSX compiled to jinja at build time
  (`crates/jsx-rust-compiler`), rendered Rust-side via `minijinja` with the
  loader's return value as the template context. No React on the server.
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
- `native: true` — loader + middleware short-circuits are supported; middleware
  that calls `next()` then mutates status/headers is not yet forwarded to the
  jinja render (hardcodes 200). Nested children and `cache` are deferred.

**Designed, not built:** content-hashed island filenames, `"use island"`
auto-detection, React Fast Refresh, single-binary deploy
(`bun build --compile`), TOML `[cache]` + `[build]` sections, response-header
deletion channel for middleware, `brust invalidate`, tsfn request batching /
worker-per-core to push past the ~60k crossing floor. See
[`architecture.md`](./architecture.md) for the full roadmap.

---

## Architecture

The full architecture document — hosting model, request lifecycle, napi IPC
layout, SAB protocol (including the single-chunk fast lane), slot-ownership
invariants, every shipped subsystem — lives in
[`architecture.md`](./architecture.md). It's the source of truth for how brust
is structured; this README is the elevator pitch.

Specs and implementation plans for each subsystem are in
[`docs/superpowers/specs/`](./docs/superpowers/specs/) and
[`docs/superpowers/plans/`](./docs/superpowers/plans/).

---

## Development

```bash
cargo test --workspace --lib    # 111 pass (brust) + jsx-rust-compiler — Rust unit tests
bun test runtime/               # 197 pass — TS unit tests
bun test tests/                 # 102 pass — integration + CLI
bun run bench                   # regenerates bench/RESULTS.md (needs release addon)
```

Repo layout (Cargo workspace):

```
crates/brust/             Rust crate: accept loop, worker pool, napi exports, SAB
crates/jsx-rust-compiler/ JSX → jinja compiler for native: true routes (+ jsx-rustc bin)
runtime/                  Bun-side runtime: routing, render, actions
runtime/cli/              brust build | brust dev | brust new
example/                  The hello-world demo app
tests/                    Integration + CLI tests
bench/                    Benchmark harness + last results
docs/                     Specs, plans, post-mortems
architecture.md           Full architecture document
```

---

## Status

Pre-publish. Solo-developed; not yet on npm. The framework runs and the
benchmarks above are reproducible today, but the consumer install path
(`bunx brust new`) waits on the workspace restructure noted above. Until then,
the supported flow is "clone this repo and run the example."

---

*Brust — built to burst.*
