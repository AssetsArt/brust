---
title: Native Interactivity
description: Behavior components and x-* directives — interactive native pages with no React on the client.
nav: { group: "Concepts", order: 3 }
---

A native page can be interactive without shipping React. A **behavior
component** is a single `.tsx` file with two exports: the JSX `default` export
is the server template (compiled to a native template like any other native
JSX), and a co-located `export const behavior` is the client logic — a plain
function, bundled react-free, bound to the rendered HTML through `x-*`
directive attributes by a small DOM runtime.

```tsx
// components/ThemeToggle.tsx
import type { BehaviorCtx } from 'brustjs/native'
import { computed, signal } from 'brustjs/store'

// → client chunk (react-free)
export const behavior = ({ effect }: BehaviorCtx) => {
  const mode = signal(document.documentElement.dataset.mode ?? 'dark')
  const label = computed(() => (mode() === 'dark' ? 'Light' : 'Dark'))

  effect(() => {
    document.documentElement.dataset.mode = mode()
  })

  function toggle() {
    mode.set(mode() === 'dark' ? 'light' : 'dark')
  }
  return { toggle, label }
}

// → server template
export default function ThemeToggle({ themeLabel }: { themeLabel: string }) {
  return (
    <button type="button" x-on-click="toggle" aria-label="Toggle theme">
      <span x-text="label">{themeLabel}</span>
    </button>
  )
}
```

The behavior returns an **instance object**; directive values name its
members. There is no inline expression evaluation (no `new Function`) —
directive values are member names or dotted paths, so all logic lives in the
typed behavior. If the instance has an `init()` method, the runtime calls it
once after binding.

## BehaviorCtx

The behavior receives one argument:

| Field | Type | Description |
|---|---|---|
| `el` | `HTMLElement` | The mounted host element. |
| `props` | `unknown` | Parsed JSON from the host's `x-props` attribute (`{}` if absent). |
| `effect` | `(fn) => dispose` | A reactive effect with React `useEffect` semantics: `fn` may return a cleanup that runs before each re-run and on unmount. Auto-disposed when the component unmounts (including SPA-nav swaps). |
| `onCleanup` | `(fn) => void` | Register a one-shot teardown for unmount (e.g. `removeEventListener` on `window`). |

```ts
export const behavior = ({ el, effect, onCleanup }: BehaviorCtx) => {
  const open = signal(false)

  effect(() => {
    el.dataset.open = String(open())
    return () => { /* runs before the next re-run and on unmount */ }
  })

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') open.set(false) }
  window.addEventListener('keydown', onKey)
  onCleanup(() => window.removeEventListener('keydown', onKey))

  return { open }
}
```

Behaviors use `signal`/`computed` from `brustjs/store` directly — the same
reactive core as [stores](/docs/store), so a behavior and a React island can
share one store and observe each other's writes.

Behaviors must stay react-free: each one is bundled into its own
`<name>.directive.js` chunk and the build **fails** if React leaks in (e.g.
via `useStore` from `brustjs/client` — use `signal`/`computed` instead). The
shared runtime (`_directives.js`) loads on every native page when the app has
any behavior; a component's chunk is dynamically imported only when its
`x-data` actually appears in the DOM, including after an SPA navigation.

## The directive set

Scheme 1, JSX-safe — hyphenated lowercase names, **no colon forms**
(`x-on:click` / `:class` are rejected by the native compiler):

| Directive | Example | Meaning |
|---|---|---|
| `x-data` | `x-data="themeToggle_1a2b3c4d"` | Marks the mount host and names the behavior. Usually **auto-injected** (below). |
| `x-props` | `x-props={items}` | Initial props for the behavior, JSON-serialized at render time. Structured loader values are serialized automatically. |
| `x-text` | `x-text="label"` | Sets `textContent` reactively. |
| `x-show` | `x-show="isOpen"` | Toggles `style.display` between `''` and `'none'`. |
| `x-if` | `x-if="isOpen"` | Conditionally **mounts/unmounts** the element (below). |
| `x-bind-<attr>` | `x-bind-disabled="busy"` | Binds an attribute/property reactively. `class` → `className`, `value` → property, boolean props (`disabled`, `checked`, …) → property + attribute presence; `null`/`false` removes the attribute. |
| `x-on-<event>` | `x-on-click="toggle"` | `addEventListener(event, instance.member)`; the member is called with the event. |
| `x-model` | `x-model="query"` | Two-way binding for form controls (below). |
| `x-for` | `x-for="item in items by item.id"` | Renders the element per list item (below). |

Deliberately absent: `x-html` (XSS by construction — render HTML on the
server instead) and an `x-effect` attribute (side-effects belong in the typed
behavior: use `ctx.effect`).

Each binding is one reactive effect; a `MutationObserver` on `document.body`
mounts added `x-data` subtrees and disposes removed ones, so directives work
on first load, SPA-nav swaps, and dynamically inserted content. A nested
`x-data` owns its own subtree — the outer instance's bindings stop at that
boundary.

### x-for

Grammar: `(item[, index]) in listPath [by keyPath, keyPath...]`. The list path
resolves on the instance; inside the loop, directive paths like
`x-text="item.name"` resolve against the item.

- **Without `by`** — the list fully re-renders on each change (fine for small
  lists).
- **With `by`** — an opt-in keyed reconcile that reuses DOM nodes (focus and
  scroll survive) and is reactive per item. Composite keys are allowed:
  `by item.type, item.id`.

The idiomatic form is **`.map()` sugar**: write a normal React `.map()` with a
`key`, add a bare `x-for` attribute, and the compiler emits both the
server-rendered `{% for %}` seed and the keyed `x-for` expression — the
runtime then *adopts* the server-rendered nodes by key instead of re-creating
them:

```tsx
export default function DexFilter({ items }: { items: Card[] }) {
  return (
    <section x-props={items}>
      <input type="search" x-on-input="onInput" />
      <div>
        {items.map((c) => (
          <a x-for key={c.id} href={c.detailHref}>
            <img src={c.artwork} alt={c.displayName} />
            {c.displayName}
          </a>
        ))}
      </div>
    </section>
  )
}
```

Here `items` feeds both the SSR list and (via `x-props`) the behavior, whose
own `items` signal drives filtering after hydration. If the behavior exposes
no matching list member, the server-rendered nodes are simply left as static
HTML.

### x-if

Where `x-show` toggles `display`, `x-if` **mounts and unmounts**: the element
is removed from the DOM while the path is falsy and re-inserted as a **fresh
clone with fresh bindings** when it turns truthy — listeners and effects of
the removed subtree are disposed, and no stale state survives a toggle. Use it
for expensive or stateful branches (an accordion panel, a modal); use `x-show`
when flipping visibility cheaply.

```tsx
// components/Accordion.tsx
export const behavior = () => {
  const open = signal(false)
  return { open, toggle: () => open.set((v) => !v) }
}

export default function Accordion({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <button type="button" x-on-click="toggle">{title}</button>
      <div x-if="open">{body}</div>
    </section>
  )
}
```

Server-rendered markup is adopted in place when the initial value is truthy
(no flash, no re-clone); a falsy initial value removes it on mount. The
runtime does not emit a server-side `{% if %}` for `x-if` — if the markup must
be conditional in the HTML itself, keep using inline conditionals in child
position. `x-if` and `x-for` on the **same** element are rejected (warn; the
`x-for` wins) — nest the `x-if` inside the loop item instead.

### x-model

Two-way binding for form controls: the element writes into the signal at the
path on input, and signal changes reflect back to the element.

```tsx
// components/Search.tsx
export const behavior = ({ props }: BehaviorCtx) => {
  const query = signal('')
  const hits = computed(() =>
    (props as { items: string[] }).items.filter((s) => s.includes(query())),
  )
  return { query, hits, clear: () => query.set('') }
}

export default function Search({ items }: { items: string[] }) {
  return (
    <div x-props={items}>
      <input type="search" x-model="query" placeholder="Filter…" />
      <button type="button" x-on-click="clear">Clear</button>
      <ul>
        <li x-for="h in hits" x-text="h"></li>
      </ul>
    </div>
  )
}
```

Element kinds: checkboxes bind a **boolean** `checked` (on `change`); radios
write their `value` when checked and a per-radio effect keeps the group
consistent against the signal; single `select` and text-like inputs bind the
string `value` (on `input`). `select[multiple]` is not supported (warns at
bind time). The path must resolve to a **signal** — intermediate signal hops
are unwrapped like every other directive read.

## Auto x-data injection

You normally never write `x-data`. When a behavior component is used inline in
a native route (`<ThemeToggle native themeLabel={label} />`), the compiler
injects `x-data="<name>"` automatically with a deterministic, app-unique name
(camelCased filename + a short hash of the file path — the same name the
`.directive.js` chunk registers under). Host resolution, in order:

1. A literal `x-data` already in the template wins — no injection.
2. Exactly one element carrying a bare `x-behavior` marker attribute becomes
   the host (the marker is stripped).
3. Otherwise the component's root element must be a single element — it
   becomes the host.

A valued `x-behavior` or more than one marker is a compile error.

## What does not compile

Native templates bind data; they do not run arbitrary JavaScript. The positive
space: member-path expressions, `.map()` over member paths (nested OK), inline
conditionals in child position, template literals and a small allowlist of
string methods inside inlined components, local `const` bindings inside
inlined components (`const rootStyle = {…}` — substituted at compile time;
`let`/`var` and destructuring declarations are rejected), and component-map
dispatch (`const Comp = SECTIONS[key]; return <Comp …/>` with the map defined
in the same file — lowers to an if-chain inlining every mapped component; a
key miss renders empty; if any mapped component can't be inlined the whole
dispatch degrades to an SSR slot). Notable negatives, from building
this docs site (see also [Rendering Modes](/docs/rendering)):

- **No conditional attributes.** `aria-current={item.active ? 'page' : undefined}`
  is rejected — ternaries don't compile in attribute position. The supported
  shape is a per-item ternary in child position, duplicating the element:
  `{item.active ? <a aria-current="page" …>…</a> : <a …>…</a>}` emits an
  `{% if %}` around the two variants.
- **Don't test an object member you also read into.** `{pager.prev && <a
  href={pager.prev.path}>…</a>}` fails with a prop type conflict: the
  condition infers `pager.prev` as a scalar while `pager.prev.path` infers it
  as a struct. Precompute a sibling boolean in the loader
  (`pager.hasPrev`) and test that instead.
- The two-arg `(item, index)` form of `.map()` and bare-fragment map bodies
  are rejected.

When a `native`-marked component can't be inlined (impure body, untranslatable
expression), the build degrades it to an SSR-component slot with a warning
rather than failing — the page still renders, via a worker `renderToString`.

## Next

The reactive core both behaviors and islands share: [Store](/docs/store).
