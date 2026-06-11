---
title: Your First Route
description: A defineRoutes walkthrough — Component, loader, params, and the native variant.
nav: { group: "Getting Started", order: 3 }
---

A brust app has two required files: an entry that starts the server, and a
route table. Everything on this page works in a fresh
[scaffolded project](/docs/installation) or an empty directory with `brustjs`
installed.

## The entry

```ts
// index.ts
import { brust } from 'brustjs'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
```

## A route

Routes are plain objects passed to `defineRoutes`. The smallest useful route
has a `path` and a `Component`:

```tsx
// routes.tsx
import { defineRoutes } from 'brustjs/routes'

function Hello() {
  return <h1>Hello from brust</h1>
}

export const routes = defineRoutes([
  { path: '/', Component: Hello },
])
```

Run it:

```bash
brustjs dev          # or `bun run dev` in a scaffolded project
```

`brust dev` compiles native templates, starts the server with hot reload, and
serves on port 1337 by default (override with `--port`, `BRUST_PORT`, or
`brust.toml` — see [Project Structure](/docs/project-structure)).

## Adding a loader

A `loader` is an async function that runs in the worker before the render.
It receives a context with three fields:

| Field | Type | Description |
|---|---|---|
| `params` | `Record<string, string>` | Path parameters extracted by the router |
| `path` | `string` | The matched request path |
| `req` | `BrustRequest` | Structured request: `method`, `url`, `headers`, `cookies`, `search`, `signal` |

The loader's return value becomes the component's `data` prop. The component
also receives `params`, `path`, `req`, and `workerId`:

```tsx
import { defineRoutes, type RouteContext } from 'brustjs/routes'

function BlogPost({ params, data }: RouteContext<{ slug: string }, { title: string }>) {
  return <h1>{data.title}</h1>
}

export const routes = defineRoutes([
  {
    path: '/blog/{slug}',
    Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }),
  },
])
```

## Path parameters

Paths use matchit syntax: a segment written `{name}` matches one segment and
lands in `params.name` as a string.

```text
/blog/{slug}        →  /blog/hello-world   →  params.slug === 'hello-world'
/admin/users/{id}   →  /admin/users/42     →  params.id === '42'
```

## The native variant

Add `native: true` and the same route stops rendering with React on the
server: at build time the component is compiled to a template, and at request
time Rust renders it with the loader's return value as the template context.

```tsx
export const routes = defineRoutes([
  {
    path: '/blog/{slug}',
    Component: BlogPost,
    native: true,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }),
  },
])
```

Two rules to know up front:

- `Component` is required and must be a **named** function — the build keys
  the compiled template on the function's name.
- Anything the template displays should be **precomputed in the loader**.
  Native templates bind data; they do not run arbitrary JavaScript at render
  time.

Native loaders can also short-circuit the render by returning
`notFound(data?)` (renders the route's own template with HTTP 404) or
`redirect(location, status?)` — both imported from `brustjs/routes`.

## Next

See how a project fits together: [Project Structure](/docs/project-structure),
or go deeper on the route tree in [Routing](/docs/routing).
