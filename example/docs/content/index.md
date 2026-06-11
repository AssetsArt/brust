---
title: Overview
description: What brust is and how these docs are organized.
nav: { order: 0 }
---

brust is a hybrid SSR framework: a Rust core and a Bun runtime in one process.
The HTTP server (hyper, HTTP/1.1 + HTTP/2), routing, response caching, and the
native template engine are Rust, loaded into Bun as a `.node` module. Your
application code — routes, loaders, actions, components — is TypeScript and
JSX running on Bun.

## Three rendering modes

A brust app mixes three ways of producing HTML, per route and per component:

| Mode | What runs | JS shipped to the browser |
|---|---|---|
| Native routes | JSX compiled at build time to templates rendered in Rust (minijinja). No React on the server. | None by default |
| React streaming SSR | Full React render in a Bun worker, streamed with Suspense support. | Hydration bundle |
| Islands | Interactive components embedded in a native page; each hydrates independently. | Only the islands you mark |

The default posture is native-first: pages are static HTML rendered by Rust,
and you opt individual components into interactivity. Every page of this
documentation site is a markdown file rendered through a native route by brust
itself.

## How these docs are organized

- **Getting Started** — install brust, write a first route, and learn the
  project layout and CLI: [Introduction](/docs/introduction),
  [Installation](/docs/installation), [Your First Route](/docs/first-route),
  [Project Structure](/docs/project-structure), [Commands](/docs/commands).
- **Concepts** — the core model: [Routing](/docs/routing),
  [Rendering Modes](/docs/rendering),
  [Native Interactivity](/docs/native-interactivity), [Store](/docs/store),
  [Actions](/docs/actions), [Styling](/docs/styling).
- **Guides** — applied walkthroughs:
  [Markdown Pages](/docs/markdown-pages) (the feature this site is built on)
  and [Deployment](/docs/deployment).
- **Reference** — the exact surface: [CLI](/docs/cli) and
  [Agents](/docs/agents) (the built-in MCP server).

If you are new, start with the [Introduction](/docs/introduction). If you
already have a project, jump to [Routing](/docs/routing).
