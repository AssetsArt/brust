---
title: Dynamic Templates
description: Register, update, and remove minijinja templates at runtime — per-tenant sections and custom layouts keyed by arbitrary strings, rendered from any handler or loader.
nav: { group: "Concepts", order: 8 }
---

Route templates are compiled at build time, but some templates only exist at
runtime — a shop's custom section, a tenant's email layout, a draft a user is
editing right now. The `templates` API lets you register **minijinja**
templates while the server is running, keyed by any string you like, and
render them on demand. The registry lives in the Rust core, so a registration
is visible to **every worker immediately** — no broadcast step.

```ts
import { templates } from 'brustjs'

templates.register('shop/42/section/7@v3', '<div class="s">{{ title }}</div>')
templates.render('shop/42/section/7@v3', { title: 'Hello' })
// → '<div class="s">Hello</div>'
```

## API

| Function | Description |
|---|---|
| `templates.register(name, source)` | Register (or atomically replace) a template. Throws on jinja syntax errors — the message includes line info, and a failed replace leaves the previous body intact. |
| `templates.remove(name)` | Remove a runtime-registered template. Returns whether it existed. Boot-tier templates (compiled from your routes) are not removable. |
| `templates.has(name)` | `true` when `name` resolves in either tier — dynamic first, then boot. |
| `templates.list()` | Names of runtime-registered templates (dynamic tier only). |
| `templates.render(name, data?)` | Render a template from either tier to an HTML string. Pure `(name, data) → html` — no request or store context. |

Names are opaque keys: encode whatever your domain needs
(`shop/42/section/7@v3` is a perfectly good name) and treat versioning as
part of the key.

## Per-tenant sections

The intended shape: your database owns the template sources, boot loads them
into the registry, and handlers render fragments by key.

```ts
import { templates } from 'brustjs'

// boot: load per-shop sections from your store
for (const s of await db.sections.all()) {
  templates.register(`shop/${s.shopId}/section/${s.id}@v${s.version}`, s.compiledJinja)
}

// handler: render a fragment
const html = templates.render(`shop/${shopId}/section/${id}@v${v}`, { title: 'Hello' })
```

When a tenant saves an edited section, `templates.register` the new source
under the same (or a version-bumped) name — replacement is atomic, so
concurrent renders see the old body or the new one, never a missing template.

## Pairing with the compiler

You don't have to hand-write jinja. The NAPI `compileJsx` binding emits jinja
source from native-style JSX — the same compiler the build uses for
`native: true` routes. A section editor can accept JSX, compile it on save,
and feed the resulting jinja straight into `templates.register`.

## Caveats

- **In-memory, per process.** Registrations don't survive a restart —
  re-register from your store at boot (as in the example above).
- **Dynamic names shadow boot templates.** Registering a name that collides
  with a route's compiled template overrides it; `remove` restores the boot
  version. Override semantics, not an error.
- **Not the request fast lane.** `templates.render` allocates a JS string per
  call — it's for handlers, loaders, and tooling (draft canvases, section
  previews), not a replacement for the native render path.
- **Process-global.** The registry is shared across all workers in the
  process; there is no per-worker isolation.
