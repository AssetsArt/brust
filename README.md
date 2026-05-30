<div align="center">

# Brust

### **B**un + **Rust** — an SSR framework that bursts.

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
bun run dev          # → http://127.0.0.1:3000
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
cd runtime && bun run build && cd ..   # release addon; NOT build:debug (~2× slower)
bun run example/hello-world/index.ts   # → http://127.0.0.1:3000
```

```bash
curl 127.0.0.1:3000/ping                  # → pong               (pure Rust)
curl 127.0.0.1:3000/                       # → SSR HTML + island
curl 127.0.0.1:3000/native-profile/World   # → Rust jinja, no React
curl -N 127.0.0.1:3000/sse-counter         # → SSE frames
```

The [`example/hello-world/`](./example/hello-world) app shows each feature in one
route apiece.

## CLI

```
brustjs dev   <entry>             # dev mode: watcher + WS reload + browser auto-reload
brustjs build <entry> --out-dir D # self-contained ./dist/ (bun run dist/index.js)
brustjs new   <name>              # scaffold a project (partial — see Status)
```

## Features

- **React 19 SSR** via `renderToPipeableStream` (auto-Suspense → chunked streaming).
- **Islands** — opt-in client hydration with `<Island>`; the rest ships zero JS.
- **`native: true` routes** — JSX compiled to a jinja template at build time and
  rendered Rust-side (`minijinja`), skipping React on the server entirely.
- **Server actions** (`"use server"`) → per-action endpoints; client helper rewrites
  form/`fetch` targets.
- **SSE & WebSockets** as first-class route shapes.
- Nested routes + dynamic params, per-route typed loaders, request-scoped middleware,
  forms/multipart, SPA-style navigation, in-process LRU cache, Tailwind v4 + CSS Modules.
- **Agent-first** — server fns and routes expose MCP tool/resource schemas at
  `/_brust/mcp` so agents drive the app without scraping.

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
runtime/                  Bun-side: routing, render, actions, CLI
example/                  hello-world demo
bench/ · docs/ · architecture.md
```

## Status

Alpha, solo-developed. Linux is tier-1 (io_uring; glibc + musl, 6 prebuilt platform
binaries). Known partials: `brustjs dev` TS reload, islands + `.module.css`. Tailwind
is opt-in — the scaffold adds it as a project dependency; `@import "tailwindcss"`
resolves from your own `node_modules`. Deployment note: the io_uring server needs `io_uring_*`
syscalls permitted — a default-seccomp container (Docker/k8s) must allow them or run
`--security-opt seccomp=unconfined`. Roadmap and limitations in
[`architecture.md`](./architecture.md).

MIT.

---

*Brust — built to burst.*
