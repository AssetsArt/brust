---
title: Rendering Modes
description: Native templates, React streaming SSR, and islands — what each does and when to use it.
nav: { group: "Concepts", order: 2 }
---

Every route in a brust app renders one of two ways — as a native template in
Rust, or as a streaming React render in a Bun worker — and either kind of page
can embed islands. This page covers all three mechanisms and when to reach for
each.

## Native routes (`native: true`)

A route flagged `native: true` is compiled **at build time**: the JSX
component is lowered to a minijinja template, and at request time Rust renders
it directly. The loader still runs in the worker with the full middleware
chain and `req`; its return value is serialized and becomes the template
context. No React executes on the server for that page, and no JavaScript
ships to the browser by default.

```tsx
// pages/Profile.tsx
export default function Profile({ user }: { user: string }) {
  return <div><h1>Hello, {user}!</h1></div>
}

// routes.tsx
{
  path: '/u/{name}',
  Component: Profile,
  native: true,
  loader: async ({ params }) => ({ user: params.name }),
}
```

Because the output is a data-driven template, the JSX is constrained:

- **Expressions are member paths** — `{user}`, `{data.post.title}`. Computed
  values belong in the loader, not the template.
- **Lists** are `.map()` over a member path, nested to any depth. The two-arg
  `(item, index)` form is rejected.
- **Conditionals** — `{cond && <X/>}` and `{cond ? <A/> : <B/>}` — lower to
  `{% if %}` blocks. They work in child (element) position, not in attribute
  position.
- **Capitalized components** inside a native page either render as SSR
  component slots (a worker `renderToString` fills them per request) or, with
  the `native` attribute (`<Badge native label={x} />`), are inlined into the
  template at compile time — provided the component body is pure.

The exact edges are catalogued in
[Native Interactivity](/docs/native-interactivity), including patterns that do
not compile. A `notFound()`/`redirect()` verdict from the loader controls the
response — see [Routing](/docs/routing).

## React streaming SSR

Routes without `native: true` render with full React on the server:
`renderToPipeableStream` in a Bun worker, streamed to the client with Suspense
support — the shell flushes first and suspended subtrees stream in as they
resolve. Use this when a page genuinely needs React on the server: heavy
composition, context providers, third-party React components, or `<Suspense>`
around slow data.

One tuning knob worth knowing: **render slots**. By default each worker holds
one render in flight; a Suspense- or loader-bound page that spends its time
awaiting I/O can overlap renders in the same worker by raising
`tuning.renderSlots` in `brust.run`'s `serve` options (or the
`BRUST_RENDER_SLOTS` environment variable). CPU-bound pages don't benefit —
they serialize in the single JavaScript isolate either way.

## Islands

An island is an interactive React component mounted explicitly inside a page
with `<Island>` (exported from `brustjs`). Only islands ship JavaScript; each
hydrates independently.

```tsx
import { Island } from 'brustjs'
import Counter from './components/Counter'

<Island component={Counter} props={{ start: 5 }} hydrate="idle" />
```

The props of `<Island>` itself:

| Prop | Type | Default | Description |
|---|---|---|---|
| `component` | `ComponentType<P>` | — | The island. Must be a stable **named** component — its name keys the client chunk and the hydration marker. |
| `props` | `P` | `{}` | Passed to the component on server and client. Must be JSON-serializable (no functions, DOM nodes, …). |
| `hydrate` | `'load' \| 'idle' \| 'visible' \| 'interaction'` | `'load'` | When to hydrate: immediately, on `requestIdleCallback`, when scrolled into view, or on first pointer/keyboard interaction. |
| `ssr` | `boolean` | `false` | **Native routes only**: render the island to HTML server-side so its markup ships in the page, then hydrate. Ignored on React routes (the whole tree already SSRs). |
| `isr` | `{ key, tags?, revalidate? }` | — | Cache the server render of an `ssr` island (below). |

### ISR — caching server-rendered islands

An `ssr` island on a native route can opt into incremental static
regeneration: its server render runs **once per `key`**, and later requests
serve the frozen markup from a Rust-side cache shared across the worker pool.

```tsx
<Island
  component={ProductCard}
  props={data.product}
  ssr
  isr={{ key: data.cacheKey, tags: ['product'], revalidate: 60 }}
/>
```

- `key` (required) — unique string identifying the cache entry; a different
  key is a different cached render. Compute it in the loader.
- `tags` (optional) — groups for bulk invalidation.
- `revalidate` (optional) — TTL in **seconds** (integer). Omit to cache until
  explicitly invalidated.

Invalidate from an action or loader:

```ts
import { cache } from 'brustjs'

cache.invalidate({ tags: ['product'] }) // evict every entry carrying the tag
cache.invalidate({ key: 'p_42' })       // evict one entry
```

The cached HTML and props are stored and served together, so hydration always
sees matching markup. `isr` is meaningless without `ssr` (there is nothing
server-rendered to cache).

## Generator tag

Every brust-rendered document carries a generator meta tag, and every response
from the brust server carries an `X-Powered-By` header — this is how technology
detectors like Wappalyzer identify brust sites:

```html
<meta name="generator" content="brust 0.1.47-alpha"/>
```

```http
X-Powered-By: brust/0.1.47-alpha
```

The tag is baked into native and Markdown templates at build time and injected
into React-streamed HTML at render time. Static export (`brust build --ssg`)
inherits the meta tag in every prerendered file.

Prefer not to advertise your framework version? Build with
`--no-generator-version` to keep the name but drop the version (the name is
always present). The decision is baked at build time — flipping it requires a
rebuild. If you hand-author your own `<meta name="generator" …>` on a buffered
route, yours wins and brust does not add a second one.

## Which mode, when

| Situation | Reach for |
|---|---|
| Content page, data known in the loader | Native route |
| Mostly-static page with a few interactive widgets | Native route + islands |
| Interactive widget whose markup matters for first paint or SEO | `ssr` island (+ `isr` if the render is expensive) |
| Light interactivity — a toggle, a filter — without React | Native route + a [behavior component](/docs/native-interactivity) |
| Page needing React context, Suspense streaming, or React-only libraries server-side | React streaming route |

The cheapest page is the one Rust renders alone; the framework is built so you
can stay on that path by default and buy back React exactly where it pays.

## Next

Make a native page interactive without React:
[Native Interactivity](/docs/native-interactivity).
