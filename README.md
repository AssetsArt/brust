<div align="center">

# Brust

### **B**un + **Rust** — an SSR framework that brusts.

[![npm](https://img.shields.io/npm/v/brustjs/alpha?logo=npm&logoColor=white&label=brustjs&color=cb3837)](https://www.npmjs.com/package/brustjs)
[![CI](https://github.com/AssetsArt/brust/actions/workflows/ci.yml/badge.svg)](https://github.com/AssetsArt/brust/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-3da639)](#status)
[![platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20(glibc%20%7C%20musl)-1f6feb)](#status)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](https://react.dev)

</div>

React on the server, Rust everywhere else. One Bun host process; the HTTP accept
loop and worker pool are pure Rust, loaded as a `.node` native module (napi-rs).
Renders cross into Bun Worker threads via `ThreadsafeFunction` and return over
per-worker `SharedArrayBuffer`. `tokio-uring` (io_uring) on Linux, `tokio` on macOS.

> Published on npm as [`brustjs`](https://www.npmjs.com/package/brustjs) (the
> `brust` name is taken). Alpha — see **Status**.

## Quick start

**Scaffold a new project** (prebuilt native binary per platform — no Rust toolchain):

```bash
bun create brustjs my-app
cd my-app
bun install
bun run dev          # → http://127.0.0.1:1337
```

**Or, with the CLI on your PATH:**

```bash
bun add --global brustjs
brustjs new my-app
```

**Or add to an existing project:**

```bash
bun add brustjs
```

> During alpha, `latest` tracks the newest alpha, so the commands above need no
> version. Pin the prerelease channel explicitly with `@alpha`
> (`bun add brustjs@alpha`) if you want to stay on alpha once a stable ships.

**Or run from source:**

```bash
git clone https://github.com/AssetsArt/brust && cd brust
bun install
cd runtime && bun run build && cd ..                          # release addon; NOT build:debug (~2× slower)
bun run runtime/cli/index.ts build example/pokedex/index.ts  # compile native routes → .brust/jinja
BRUST_PORT=3100 bun run example/pokedex/index.ts             # → http://127.0.0.1:3100
```

```bash
curl 127.0.0.1:3100/ping                  # → pong                    (pure Rust)
curl 127.0.0.1:3100/                       # → native list page, no server React
curl 127.0.0.1:3100/pokemon/pikachu        # → native detail, dynamic param
curl 127.0.0.1:3100/type-chart             # → native 18×18 effectiveness grid
```

The [`example/pokedex/`](./example/pokedex) app dogfoods `native: true` across
every route; see its [`FRAMEWORK-GAPS.md`](./example/pokedex/FRAMEWORK-GAPS.md) for
the empirically-found limits.

## CLI

```
brustjs dev   <entry>             # dev mode: watcher + WS reload + browser auto-reload
brustjs build <entry> --out-dir D # prebuilt ./dist/ — run from the project (bun run dist/index.js)
                  --target <auto|all|TARGET[,…]> # which native binary to bundle (default: auto = host platform)
brustjs new   <name>              # scaffold a project (partial — see Status)
```

## Features

- **React 19 SSR** via `renderToPipeableStream` (auto-Suspense → chunked streaming).
- **Islands** — opt-in client hydration with `<Island>`; the rest ships zero JS.
  SSR islands can opt into **ISR caching** (`isr={{ key, tags, revalidate }}`) so
  `renderToString` runs once per key, then serves a frozen pair from Rust.
- **`native: true` routes** — JSX compiled to a jinja template at build time and
  rendered Rust-side (`minijinja`), skipping React on the server entirely.
- **Native interactivity without islands** — Alpine.js-style `x-*` DOM directives
  (`x-data`/`x-text`/`x-show`/`x-bind-*`/`x-on-*`/`x-for`) on a `native` page,
  bound to the store by a small react-free runtime. Logic lives in a co-located
  `export const behavior` (single-file component); each component's JS is a
  separate chunk loaded **on demand** — a page never downloads a component it
  doesn't render.
- **Isomorphic store** — `brustjs/store`: `signal`/`computed`/`effect` +
  `defineStore(name, factory)`. One `window` singleton per name on the client (so
  separate island/directive chunks share state), a per-request `AsyncLocalStorage`
  instance on the server. `useStore` adapter for React islands; a native directive
  button and a React island reactively share the same store.
- **Typed actions** — `defineActions().get/post/put/patch/delete/head(path, ctx => R, { body, query })`
  on the server; `client<typeof actions>()` is an Eden-Treaty-style proxy that
  infers the whole API from the server types (no codegen) and returns
  `{ data, error, status, headers }` (never throws). Standard Schema (zod)
  validation, JSON / urlencoded / multipart bodies.
- **SSE & WebSockets** as first-class route shapes.
- Nested routes + dynamic params, per-route typed loaders, request-scoped middleware,
  SPA-style navigation, in-process LRU response cache + island ISR cache, Tailwind v4 + CSS Modules.
- **Agent-first** — `defineActions` endpoints become MCP **tools** and route
  loaders become **resources** at `/_brust/mcp`; `tools/call` runs through the
  same validation + middleware as an HTTP request, so agents drive the app
  without scraping.

## Performance

Two tiers, split by the napi crossing: pure-Rust paths (`/ping`, native jinja
routes) run far faster than routes that cross into a Bun worker for React SSR.
Full numbers, methodology, and the latency table are in
[`bench/RESULTS.md`](./bench/RESULTS.md) (`bun run bench`); the request lifecycle
and SAB protocol are in [`architecture.md`](./architecture.md).

## Development

```bash
cargo test --workspace          # Rust unit tests
bun test runtime/               # TS unit tests
bun test tests/integration.test.ts   # integration (real server)
```

```
crates/brust/             Rust: accept loop, worker pool, napi exports, SAB
crates/jsx-rust-compiler/ JSX → jinja compiler for native: true routes
runtime/                  Bun-side: routing, render, actions, store, native directives, CLI
example/                  pokedex native-first demo
bench/ · docs/ · architecture.md
```

## Status

Alpha, solo-developed. Linux is tier-1 (io_uring; glibc + musl, 6 prebuilt platform
binaries). Known partials: `brustjs dev` reload is a full worker-respawn (not
state-preserving HMR) — TS, islands, and `.module.css` all reload that way.
Tailwind is opt-in — the scaffold adds it as a project dependency; `@import "tailwindcss"`
resolves from your own `node_modules`. Deployment note: the io_uring server needs `io_uring_*`
syscalls permitted — a default-seccomp container (Docker/k8s) must allow them or run
`--security-opt seccomp=unconfined`. Roadmap and limitations in
[`architecture.md`](./architecture.md).

MIT.

---

*Brust — built to brust.*
