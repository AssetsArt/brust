<div align="center">

# Brust

### The unified framework for the web.

[![npm](https://img.shields.io/npm/v/brustjs/alpha?logo=npm&logoColor=white&label=brustjs&color=cb3837)](https://www.npmjs.com/package/brustjs)
[![CI](https://github.com/AssetsArt/brust/actions/workflows/ci.yml/badge.svg)](https://github.com/AssetsArt/brust/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-3da639)](#status)
[![platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20(glibc%20%7C%20musl)-1f6feb)](#status)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](https://react.dev)

**[brust.assetsart.com](https://brust.assetsart.com/)** — docs, guides, and a live demo of everything below.

</div>

Brust serves compiled pages with **zero JavaScript by default** — and gives
server templates, React islands, and native interactions **one shared store**
the moment you add interactivity. Like unified memory: a single state substrate
every kind of component addresses directly. No bridges, no event buses, no
syncing two worlds. The [home page demo](https://brust.assetsart.com/) is real —
a hydrated React island and a zero-React native component move together through
the same store.

> Published on npm as [`brustjs`](https://www.npmjs.com/package/brustjs) (the
> `brust` name is taken). Alpha — see **Status**.

## Quick start

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

Full walkthrough: [Getting started](https://brust.assetsart.com/docs/introduction).

## One store. Every paradigm reads it live.

The center of Brust is a store that resolves to a **single instance** wherever
it's read — a hydrated React island, a zero-React native behavior, or the
server during render. Components from different worlds share state with no
bridge code:

```ts
// lib/counter.ts — one definition
import { defineStore, signal } from 'brustjs/store'
export const counter = defineStore('counter', () => ({ count: signal(0) }))
```

```tsx
// A React island reads and writes it…
import { useStore } from 'brustjs/client'
const { count } = useStore(counter)
```

```tsx
// …and a native behavior component (no React shipped) reads the SAME instance
export const behavior = () => ({
  count: computed(() => String(counter.count())),
  bump() { counter.count.set(counter.count() + 1) },
})
```

Click either one — both update. [See it live](https://brust.assetsart.com/) ·
[Store docs](https://brust.assetsart.com/docs/store).

## Built in, not bolted on

- **Native rendering** — pages compile ahead of time and are served as plain
  HTML: no hydration pass, no framework runtime in the response. One compiled
  page sustains **84,119 req/s** versus 28,938 for the same page through a
  JavaScript pipeline — about 2.9× ([bench/RESULTS.md](./bench/RESULTS.md)).
  → [Rendering](https://brust.assetsart.com/docs/rendering)
- **React islands** — hydrate one component, not the page. React 19 streaming
  SSR with auto-Suspense; SSR islands can opt into **ISR caching**
  (`isr={{ key, tags, revalidate }}`).
  → [Islands](https://brust.assetsart.com/docs/rendering#islands)
- **Native interactivity** — counters, toggles, live text: `x-*` DOM directives
  bound to the store by a small react-free runtime, with logic in a co-located
  `export const behavior`. Each component's JS is a separate on-demand chunk.
  → [Native interactivity](https://brust.assetsart.com/docs/native-interactivity)
- **Typed actions end-to-end** — `defineActions()` on the server; the treaty
  client infers the whole API from server types (no codegen) and returns
  `{ data, error, status, headers }` — it never throws. Standard Schema (zod)
  validation; JSON / urlencoded / multipart.
  → [Actions](https://brust.assetsart.com/docs/actions)
- **Markdown pages + SSG** — drop `.md` files in a folder for routed pages with
  nav, embed islands and behaviors straight from markdown, and prerender the
  whole site to static HTML with `brust build --ssg`. The
  [docs site](https://brust.assetsart.com/) is built this way.
  → [Markdown pages](https://brust.assetsart.com/docs/markdown-pages)
- **MCP for agents** — actions double as MCP **tools** and loaders as
  **resources** at `/_brust/mcp`; `tools/call` runs through the same validation
  and middleware as HTTP, so agents drive the app without scraping.
  → [Agents](https://brust.assetsart.com/docs/agents)
- Plus: nested routes + dynamic params, typed loaders, request-scoped
  middleware, SPA-style navigation, SSE & WebSockets as first-class route
  shapes, response + ISR caches, Tailwind v4 + CSS Modules, static
  `lucide-react` icons compiled to inline SVG on native routes.

## Markdown pages

Mount a content directory as routes — each `.md` file becomes a compiled page
(no markdown parsing at request time):

```tsx
// routes.tsx
import { defineRoutes, mdRoutes } from 'brustjs/routes'
import DocsLayout from './components/DocsLayout' // owns <BrustPage> + <main><Outlet/></main>
import Counter from './components/Counter'

export const routes = defineRoutes([
  ...mdRoutes('content/docs', {
    prefix: '/docs',                  // content/docs/query/where.md → /docs/query/where
    layout: DocsLayout,               // optional; head comes from frontmatter via `__md`
    components: { Counter },          // usable as `<Counter start={5} />` in markdown
  }),
])
```

Frontmatter (`title`, `description`, `nav: { group, order }`) drives `<title>`
and the `mdNav('content/docs')` sidebar tree. Component tags on their own line
embed islands (`<Counter start={5} />`, `csr` / `hydrate="visible"` supported)
or native behavior components. Code fences are highlighted server-side when the
optional `shiki` peer dependency is installed. `brust build` freezes the pages
into the dist (`md-manifest.json` — the content dir isn't needed at runtime),
and `brust build --ssg` prerenders them to static HTML.

## CLI

```
brustjs dev   <entry>             # dev mode: watcher + WS reload + browser auto-reload
brustjs build <entry> --out-dir D # prebuilt ./dist/ — run from the project (bun run dist/index.js)
                  --target <auto|all|TARGET[,…]> # which native binary to bundle (default: auto = host platform)
                  --ssg [--ssg-out D]   # prerender static routes (incl. markdown pages) to HTML
                                        # + per-route SPA payloads — client-side nav works statically
brustjs new   <name>              # scaffold a project (partial — see Status)
```

Full reference: [CLI](https://brust.assetsart.com/docs/cli).

## Under the hood

A detail you mostly never have to think about: Brust runs as one Bun host
process whose HTTP server (hyper 1.x, HTTP/1.1 + HTTP/2, optional in-process
TLS), routing, caches, and native-template rendering are pure Rust, loaded as a
napi `.node` module. React renders cross into Bun Worker threads and return
over a per-worker `SharedArrayBuffer`; a worker can hold several renders
in-flight (`renderSlots`) to overlap Suspense-bound requests. `native: true`
routes compile JSX to templates at build time and never touch React on the
server. Multi-thread tokio runtime — runs the same everywhere (no io_uring /
seccomp caveat). The full request lifecycle and protocol live in
[`architecture.md`](./architecture.md); numbers and methodology in
[`bench/RESULTS.md`](./bench/RESULTS.md).

## Run from source

```bash
git clone https://github.com/AssetsArt/brust && cd brust
bun install
cd runtime && bun run build && cd ..                          # release addon; NOT build:debug (~2× slower)
bun run runtime/cli/index.ts build example/pokedex/index.ts  # compile native routes → .brust/jinja
BRUST_PORT=3100 bun run example/pokedex/index.ts             # → http://127.0.0.1:3100
```

The [`example/pokedex/`](./example/pokedex) app dogfoods `native: true` across
every route, and [`example/docs/`](./example/docs) is the documentation site
itself — markdown pages, SSG, and the unified-store demo, deployed to
[brust.assetsart.com](https://brust.assetsart.com/).

## Development

```bash
cargo test --workspace          # Rust unit tests
bun test runtime/               # TS unit tests
bun test tests/integration.test.ts   # integration (real server)
```

```
crates/brust-core/        Rust core (pure, zero napi): hyper server, worker pool, routing, cache
crates/brust/             Thin napi cdylib over brust-core (the .node)
crates/jsx-rust-compiler/ JSX → jinja compiler for native: true routes
runtime/                  Bun-side: routing, render, actions, store, native directives, CLI
example/                  pokedex (native-first demo) · docs (the documentation site)
bench/ · docs/ · architecture.md
```

## Status

Alpha, solo-developed. Linux is tier-1 (glibc + musl, 6 prebuilt platform
binaries) and runs under default container seccomp. Known partials:
`brustjs dev` reload is a full worker-respawn (not state-preserving HMR) — TS,
islands, and `.module.css` all reload that way. Tailwind is opt-in — the
scaffold adds it as a project dependency; `@import "tailwindcss"` resolves from
your own `node_modules`. Roadmap and limitations in
[`architecture.md`](./architecture.md).

MIT.

---

*Brust — built to brust.*
