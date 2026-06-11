---
title: Introduction
description: The philosophy behind brust — native-first rendering, islands, and when it fits.
nav: { group: "Getting Started", order: 1 }
---

brust starts from one observation: most pages on most sites are content. They
do not need a client-side framework to display HTML, and they do not need to
re-run the application on the client to become interactive in two or three
places. brust is built so that the default cost of a page is the cost of
serving HTML — and interactivity is something you add back deliberately,
component by component.

## Native-first rendering

A route marked `native: true` is compiled ahead of time: the JSX component
becomes a template that the Rust side of the server renders directly with
minijinja. At request time the route's `loader` runs in a Bun worker to
produce the data, and the HTML is produced in Rust — no React executes on the
server for that page, and no JavaScript is shipped to the browser by default.

```tsx
{
  path: '/posts/{slug}',
  Component: Post,        // compiled to a template at build time
  native: true,
  loader: async ({ params }) => ({ post: await getPost(params.slug) }),
}
```

Because the template is data-driven, native routes trade some JSX expressive
power for that speed: values you bind must be precomputed in the loader rather
than computed inline. The [native route pages](/docs/routing) cover the exact
constraints.

Routes without `native: true` render with full React streaming SSR in a Bun
worker — the escape hatch is always there, per route, when a page genuinely
needs React on the server.

## Islands for interactivity

Inside a native page, interactivity comes from islands: components you mount
explicitly with `<Island component={Counter} props={...} />`. Only those
components ship JavaScript, and each hydrates on its own schedule (`load`,
`idle`, and so on). A server island (`ssr`) is rendered to HTML in a worker
first, so it appears instantly and can even be cached incrementally.

For lighter interactivity — a theme toggle, a dropdown — brust also has
native behavior components: plain functions with `x-*` directives that run a
small framework runtime instead of React. No virtual DOM, no hydration of
markup that was already correct.

The result is a hydration budget you control line by line: the page is HTML,
and the JavaScript bill is exactly the sum of the islands you placed.

## When brust fits

brust is a good match when:

- **Content-heavy sites** — documentation, blogs, marketing pages, listings.
  Most of the page is HTML; brust renders it in Rust and ships no JS for it.
- **Performance-sensitive server rendering** — native routes and cache hits
  are served without waking a JavaScript worker at all.
- **Mixed pages** — a product page that is 95% static with a cart button:
  native route + one island.

It is a weaker match when:

- **Your app is mostly interactive** — if nearly every component needs
  client state (an editor, a dashboard of live widgets), the native-first
  advantage shrinks. You can build it with React streaming routes, but a
  client-first framework may serve you just as well.
- **You need a stable, battle-tested stack today** — brust is alpha software
  (currently `0.1.x-alpha`). APIs can change between releases.
- **You are not on Bun** — brust is a Bun framework; there is no Node.js
  runtime support. Prebuilt native binaries cover macOS and Linux
  (glibc and musl).

## Next

Install brust and scaffold a project: [Installation](/docs/installation).
