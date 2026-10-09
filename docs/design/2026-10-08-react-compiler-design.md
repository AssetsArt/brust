# brust v2 — React compiler design

Status: DRAFT v2 for review · Date: 2026-10-08 · Owner: lead (Detoro) · authority: in-loop

This is the founding design of the `v2` branch. The branch starts empty; nothing from
0.1.x is carried over unless this document names it. The first milestone is the
**compiler plus the directive runtime**. Server, routing, CLI and docs come in later
specs that build on the IR defined here.

Revision log: v1 2026-10-08 initial; v2 same day — no source directives (D3),
per-component server jobs / precompute (§3.3, §6.4), implicit islands and `cache()`
(§3.4), caching layers and what the compiler owes them (§3.5), reactive props between
native components (§7.4), §3.2 rules rewritten accordingly.

---

## 1. Goal

Write ordinary React — `import { useState, useEffect } from 'react'`, hooks, `onClick`
handlers, JSX — and get a **native page**: HTML rendered by Rust from a compiled
template, interactivity shipped as a small react-free client chunk, and zero React on
the server or the client unless the compiler proves it needs it.

The two 0.1.x asks this unifies:

- "native pages should be the default" — there is no `native: true` flag; every
  component is native unless the compiler downgrades it, and the downgrade is a
  graceful fallback, never a build error.
- "behavior should feel like React" — there is no `export const behavior` and no
  string directives (`x-on-click="toggle"`). The single default export IS the
  component; the compiler splits server and client itself.

### Non-goals (for this spec)

- The HTTP server, the worker pool, the routing table, SSG, SPA navigation, stores,
  the cache store itself, the CLI. Each gets its own spec on top of the IR. Where this
  document describes server behaviour (§3.5) it is to state what the compiler must
  guarantee, not to design the server.
- Porting 0.1.x features (view transitions, page cache, MCP, AI runtime). They come
  back only when a later spec asks for them.
- Making every React program native. The `react` tier exists because some programs
  (context, Suspense, DOM access during render) cannot be a template.

---

## 2. Decisions on record

These were settled with the human during brainstorming and are not re-opened by
implementers. Change requests go through a `task challenge` to the lead.

| # | Decision | Why |
|---|---|---|
| D1 | `v2` is an **orphan branch**; clean monorepo from day 1. | The 0.1.x compiler (19k lines of hand-rolled lowering) and runtime are not the base. |
| D2 | Authoring = **real React**: hooks are imported from `react`, JSX is React JSX, TypeScript types are React's. The only brust-specific API a component may touch is `cache()` (§3.4), which is an identity wrapper under real React. | A component that is valid React always has a working fallback (React SSR + hydrate) and migrates without edits. |
| D3 | **Native is the default tier.** A component that cannot be native **falls back** (to React) with a diagnostic; it never fails the build. **No source-level directives** (`'use react'`, `'use client'`, …): the compiler alone decides the tier. If a project ever needs to force a tier, that is an app-config knob for a later spec, never text in the component file. | Default-on only works when the fallback is safe; directives would reintroduce the `native: true` flag under another name. |
| D4 | **Server render target = Rust, minijinja templates**, rendered on every request from a JSON context. Anything the first paint needs that a template cannot compute is computed **in Bun, per component, as a cacheable job** (§3.3), never by React. | brust's identity: Rust renders, Bun computes, both cached per component. |
| D5 | **Compiler = Rust, built on Bun's own crates** (`bun_js_parser`, `bun_ast`, `bun_js_printer`, `bun_react_compiler`) linked as git dependencies at a pinned rev, on Bun's pinned nightly. Not swc. | Verified by spike 2026-10-08 (§10): Bun's parse is the one Bun runs; `bun_react_compiler` is Meta's React Compiler ported, and its HIR / reactive scopes are exactly the state–handler–JSX dependency analysis this design needs. |
| D6 | **Bundling = `bun build`**, **type gate = `bun check` / `Bun.build({ check: true })`** (requires **Bun ≥ 1.4.3**; on 1.4.2 `bun check` resolves to a package.json script — until 1.4.3 is pinned, CI runs a syntax-only `bun build --no-bundle` gate). No rspack, no biome as the primary gate. | Both are built into the Bun the user already runs. |
| D7 | Directive runtime stays **eval-free**: a directive value is only the name of a member the compiler generated. Users never write directives. | Security property of 0.1.x kept; full-JS expressions still work because the compiler emits them as members of the client chunk. |
| D8 | **Reactive props between native components go through the runtime** (parent instance → child instance link), not through compile-time inlining of the child's logic (§7.4). | One chunk per component, reusable across pages; functions can be passed as props; lists reuse the item-scope mechanism. |

---

## 3. Authoring model, tiers, and what runs where

A **component** is a module whose default export is a function returning JSX.
Routes are components too (a later routing spec binds paths to modules). Every
component is classified by the compiler into exactly one tier:

| Tier | Condition | Server | Client |
|---|---|---|---|
| `static` | No hooks, no handlers, no refs. | Rust renders the template; first-paint values outside the template subset come from a per-component **precompute job** (§3.3). | Nothing ships. |
| `native` | Only the supported hook set (§4.3) and handlers; no DOM/window access during render; no server-only code reachable from client code (§8.2). | Same as `static`, with state seeds in the template. | A react-free **directive chunk** (signals + generated members) bound to the HTML by `x-*` attributes. |
| `react` | Everything else: `useContext`/`use`, `Suspense`, custom hooks, `useReducer`, class components, `window`/`document` read during render, refs read during render. | A per-component **SSR job** renders it with React in Bun (or a client-only placeholder when render touches the DOM). | React hydrates that subtree (an island when embedded in a native page; the whole page when the page itself is `react`). |

Tier is decided **per component**, bottom-up. A `react` child inside a `native`
parent is an island at the child's boundary; the parent stays native. A `react`
page is React streaming SSR like a 0.1.x non-native route.

### 3.1 The sentence that defines "native"

> A native component's HTML can be produced by a template from props plus values
> that a pure function of those props computed on the server, and everything that
> changes after first paint is a function of state the client owns.

Everything in §4–§7 is machinery for proving that sentence per component.

### 3.2 Rules the author must know ("the native contract")

1. **Render is pure and server-safe.** The component body may call any function and
   import anything, as long as rendering does not read `window`/`document`/
   `navigator` or any other browser global, and does not read request state
   (cookies, headers, `req`) directly — request-dependent values arrive through the
   loader as props. Breaking the first makes the component `react` (client-only
   island); breaking the second is an `Error` (§3.5 explains why: it would poison the
   per-component cache).
2. **State-dependent values must be client-computable.** Any expression that depends
   on state (so the client must recompute it) may only call code that can run in the
   browser. A server-only module (§8.2) reached from such an expression, a handler or
   an effect is an `Error` with the offending line — not a fallback, because React on
   the client could not run it either.
3. **Props that reach the client must be JSON** *when they are needed for the first
   paint seed*: a prop read by a state initializer or a painted state-dependent
   expression is serialized into `x-props`. Props that are only passed on to a native
   child, including functions, travel in memory (§7.4) and have no such restriction.
   Props passed to a `react` island must be JSON (it hydrates from JSON).
4. **Parent state flows into native children**, including as functions
   (`<Counter n={count} onReset={() => setCount(0)} />`), through the runtime link of
   §7.4. Only a `react` child cannot receive a function or a reactive value as a prop;
   it receives the value at SSR time and hydrates with it.
5. **Keys are required on lists** (`key={…}`) exactly as React warns; the compiler
   uses the key as the `x-for` identity.

### 3.3 Server jobs: the unit of work and of caching is the component

For one page the server does at most two round-trips to Bun: the route **loader**
(unchanged from 0.1.x; out of scope here) and **one batched call for the
component jobs** that are not in cache. The compiler emits, per component, zero or
more jobs:

| Job | Emitted when | Input | Output |
|---|---|---|---|
| `precompute` | a first-paint value (text, attribute, condition, list source, state seed) is not in the template subset (§6.2) | the props the job actually reads (from capture analysis) | JSON object of named slots `_sN` |
| `ssr` | tier is `react` | the component's props (JSON) | HTML string (plus, for client-only islands, nothing but a placeholder marker) |

Jobs are **pure functions of their declared inputs**. That is what lets Rust cache
them per component: key = `(componentId, hash(inputs the job reads))`, so a
`ProductCard` whose precompute reads only `item.price` stays cached when `item.name`
changes. Rust evaluates each job's inputs from the loader context with template-subset
expressions, checks its cache, batches the misses into one Bun call, merges every
result into one **JSON context**, and renders the page template from that context.
A page whose jobs all hit — or that has no jobs and no loader — renders without
waking Bun at all.

The compiler's two obligations to this scheme: emit each job's exact input set, and
reject anything that would make a job impure (§3.2 rule 1).

### 3.4 Islands are implicit; `cache()` replaces island ISR

`<Island>` is gone. A `react`-tier child used from a native parent is an island
automatically:

| 0.1.x | v2 |
|---|---|
| `<Island component={Counter} props={…}/>` | `<Counter …/>`; the compiler knows `Counter` is `react`. |
| `ssr` (default off) | **Default on**: the `ssr` job renders HTML in Bun. A component whose render reads browser globals becomes a **client-only island**: the server emits a placeholder, the browser renders it. Decided by the compiler. |
| `hydrate="load/idle/visible/interaction"` | Default `idle`; overridable per component path in build config (later spec), never in source. |
| `isr={{ key, tags, revalidate }}` | `export default cache(ProductCard, { key: p => p.id, tags: p => [...], revalidate: 60 })` from `@brust/brust` (the bare `brust` specifier is accepted for the M1 fixtures). Identity function under real React. Overrides the automatic job key / adds tags and TTL. Works for every tier (for `native`/`static` it caches the precompute output; for `react` the SSR HTML). |

`cache.invalidate({ tags | key | path })` keeps its 0.1.x meaning.

### 3.5 Caching layers and what the compiler owes them

Kept from 0.1.x by reference (see the 0.1.x caching docs): **L1** (Rust, per route,
`prefix`/`bypass`/`tags`/`ttl_seconds`), **L2** (Bun `key(ctx)` per request, native
pages only), the per-component job cache of §3.3, `cache.invalidate`, cross-process
sync, and the storage rules (status 200, no `Set-Cookie`, single chunk). None of
them live in component source, so they are unaffected by D3.

What changes because the compiler now exists:

- L1 caches **Bun output (JSON), not HTML**; Rust re-renders the template on every
  request. Precompute output and SSR island HTML are part of that JSON, so they are
  cached by L1 with no extra rules.
- L2 was "native routes only" by flag; now the page's tier is a compiler output, so a
  route with `key` whose page compiled as `react` (streaming) gets a **build-time
  warning** instead of silently not caching.
- The compiler emits `needs_worker` per page: false when there is no loader, no job
  and no island — Rust may render from props alone even on a cache miss.
- Jobs must be pure(inputs) (§3.3) and must not read request state; otherwise the
  per-component cache returns wrong data to a different user. This is why §3.2
  rule 1's second half is an `Error`.
- What L2 stores (JSON vs HTML) is not specified here; the server spec reads it off
  the 0.1.x code.

---

## 4. Pipeline

```
 source.tsx ──► parse ──► analyze ──► IR ──► lower ──► artifacts
                (Bun)     (HIR +       (§5)   ├─ template backend → <name>.jinja
                          brust rules)        ├─ server backend   → <name>.server.ts   (precompute job; only if needed)
                                              ├─ client backend   → <name>.client.js   (ESM, react-free; native tier only)
                                              └─ react backend    → unchanged module + ssr job descriptor (react tier)
```

### 4.1 Parse

`bun_js_parser` with `Loader::Tsx`, macros disabled, React Compiler **disabled** (we
want the plain visited AST, not the memoised rewrite). Output: `bun_ast::Ast` with
resolved `Ref`s, scopes, import records. JSX is already lowered to
`E::Call { was_jsx_element: true }` by the parser; the analyzer reads JSX structure
from those calls through `Host::jsx_import_kind`.

### 4.2 Analyze

Two analyses run on the default-export function; both are pure functions of the AST.

**(a) React Compiler HIR** — `bun_react_compiler::pipeline::analyze_fn` (our patch,
§10.3) returns `(ReactiveFunction, Environment)`. From it we read:

- reactive scopes: which generated values depend on which identifiers, and whether
  a dependency is reactive (`*`) — this is the state→effect, state→JSX, prop→JSX map;
- the instruction stream: every `useState`/`useEffect`/… call with its operands,
  every JSX call with its props and children places, every function expression
  (handler) with its captured places;
- `CompilerError::Unsupported` — anything the React Compiler itself cannot lower is
  by definition not something we can make native; it becomes `react` with that
  diagnostic verbatim.

**(b) brust rules** (own code, walks the same HIR):

- hook classification (§4.3);
- **dependency classification** of every value: `props-only`, `state-dependent`, or
  `browser` (reads a browser global during render);
- **placement** of every first-paint value: template subset (§6.2) → `Server`;
  props-only but outside the subset → `Precomputed` slot; state-dependent outside the
  subset → `Precomputed` seed for first paint plus a client computed;
- capture analysis: for every job, handler, effect and initializer, the identifiers
  it reads → job inputs, props to serialize, modules to bundle, server-only leaks
  (§8.2);
- list analysis: `.map` callbacks with `key`, nested depth, per-item handlers and
  per-item child props;
- child components: tier of each `<Capitalized/>` child, which of its props are
  reactive or functions, and whether that is allowed for the child's tier (§3.2 rule 4).

The analyzer never mutates the AST. It produces the IR (§5) plus diagnostics.

### 4.3 Hook set and their client meaning

| Hook | Client lowering | Server meaning |
|---|---|---|
| `useState(init)` | `signal(init)`; setter is `.set` (functional updates supported) | `init` is the seed: template subset, or a precompute slot |
| derived `const x = f(state…)` | `computed(() => …)` (full JS) | painted via subset or precompute seed |
| `useMemo(fn, deps)` | `computed(fn)` (deps ignored; signals track) | same as derived |
| `useCallback(fn, deps)` | plain member | — |
| `useEffect(fn, deps)` | `ctx.effect(fn)` (cleanup return honored; deps ignored) | none |
| `useLayoutEffect` | same as `useEffect` but runs before the chunk's first DOM write | none |
| `useRef(init)` | `{ current: init }`; when passed as `ref={r}` to an element, bound to the node via `x-ref` after mount | none |
| `useId()` | server generates, client reads it from the DOM | deterministic per component instance |
| anything else (`useContext`, `use`, `useReducer`, `useTransition`, `useSyncExternalStore`, custom `useX`) | → tier `react` | — |

Hooks must be called unconditionally at the top level of the component (React's own
rule); the HIR already rejects violations.

### 4.4 Lower

Backends consume only the IR. They never see `bun_ast`.

- **template backend** → minijinja source (§6).
- **server backend** → `<name>.server.ts`: the precompute job as an exported function
  of its declared inputs, printed with `bun_js_printer` from the original expressions
  (so it keeps the user's imports and helper calls verbatim).
- **client backend** → prints the chunk as JavaScript text from the IR (`RawExpr`
  JS printer plus the captured source of opaque function bodies) — *amended 2026-10-08:
  it does not build a `bun_ast` module, because `lower/` may not see Bun types (§9 rule)*.
  The chunk imports only `brust/runtime-dom` and the user's client-safe imports; it must
  contain no `react` import (asserted by a test).
- **react backend** → the original module untouched plus an `ssr` job descriptor
  (component id, props schema, client-only flag).

*Amended 2026-10-09 (M2a, S9):* a document root (`<html>`) is a host like any other; the
runtime mounts from `document.documentElement`.

---

## 5. The IR

One `ComponentIR` per component. Serializable to JSON (that is what golden tests
assert against). Rust types live in `crates/brust-compiler/src/ir/`.

```rust
struct ComponentIR {
    id: ComponentId,            // stable: camelCase(file stem) + 8-hex hash(path)
    source: SourcePath,
    tier: Tier,                 // Static | Native | React { reason: Diagnostic, client_only: bool }
    props: Vec<PropDecl>,       // name, ts type text, json_serializable: bool
    state: Vec<StateDecl>,      // name, setter, init: Expr
    derived: Vec<DerivedDecl>,  // name, expr: Expr, deps: Vec<Dep>
    effects: Vec<EffectDecl>,   // body: JsFn, deps: Vec<Dep>, layout: bool
    handlers: Vec<HandlerDecl>, // generated name `_hN`, body: JsFn, captures: Vec<Capture>
    refs: Vec<RefDecl>,         // name, bound_to: Option<NodeId>
    template: Node,             // §5.2
    jobs: Vec<JobDecl>,         // §5.3 — precompute / ssr, with exact inputs
    child_links: Vec<ChildLink>,// §7.4 — child instance, props computed `_pN`, item scope
    client_props: Vec<PropName>,// props the client chunk reads for seeds (→ x-props)
    client_imports: Vec<Import>,// imports the chunk needs bundled
    needs_worker: bool,         // jobs.is_empty() && no react child (loader is a route fact, added by the server)
    cache: Option<CacheDecl>,   // from cache(): key/tags/ttl expressions over props
    diagnostics: Vec<Diagnostic>,
}
```

### 5.1 Expressions have three placements

```rust
enum Expr {
    Server(ServerExpr),         // template subset: lowers to jinja AND to JS
    Precomputed { slot: SlotId, js: JsFn, inputs: Vec<Capture> }, // computed in Bun from props; client gets `js` too if state-dependent
    ClientOnly(JsFn),           // used only after first paint (handlers/effects)
}
```

A first-paint value is `Server` when it fits the subset and `Precomputed` otherwise;
it is never `ClientOnly`. A `Precomputed` value that is state-dependent carries the
same `js` into the client chunk as a computed, and its first-paint evaluation in Bun
uses the state seeds (§6.4).

`ServerExpr` (§6.2) is closed and small on purpose. It carries enough structure to
print as a minijinja expression and as a JS expression, so a subset first paint and
the client's initial computation are the same program and cannot disagree.

### 5.2 Template tree

```rust
enum Node {
    Element { tag, attrs: Vec<Attr>, children: Vec<Node>, host: bool, ref_: Option<RefName> },
    Text(String),
    Slot(Expr),                                   // {expr} → text
    If { cond: Expr, then: Vec<Node>, else_: Vec<Node> },
    For { source: Expr, item: Binding, index: Option<Binding>, key: Expr, body: Vec<Node> },
    Component { id: ComponentId, tier: Tier, props: Vec<(PropName, Expr)>, link: Option<ChildLinkId>, children: Vec<Node> },
    Fragment(Vec<Node>),
}
enum Attr {
    Static(String, String),
    Dynamic(String, Expr),                        // attr={expr}
    Event(String, HandlerName, Option<ItemBinding>), // onClick={…}; item-scoped inside For
    Model(StateName),                             // value={s} + onChange={e => setS(e.target.value)} pair
}
```

`host: bool` marks the single element that carries `x-data` (the mount host): the
root element when the component returns one element; otherwise the compiler wraps
the fragment in a `<brust-host style="display:contents">` and warns. Every `Node`
records which identifiers it depends on (from the HIR), which is what decides
whether it gets a directive.

### 5.3 Jobs

```rust
struct JobDecl {
    kind: JobKind,              // Precompute | Ssr { client_only: bool }
    inputs: Vec<Capture>,       // props paths the job reads: the cache key material
    outputs: Vec<SlotId>,       // precompute only
}
```

---

## 6. Server lowering (minijinja)

### 6.1 Template shape

- Props, loader data and job outputs form the template context, exactly as 0.1.x
  (`{{ user.name | e }}`; autoescape stays `None` with explicit `| e` on every dynamic
  output — the 0.1.x XSS lesson is kept).
- State seeds: for each `StateDecl`, the template reads the seed once at the top
  (`{% set mode = 'dark' %}` for a subset initializer, `{% set qty = _s0 %}` for a
  precomputed one); every painted slot that depends on state reads the seed.
- Directive attributes are emitted alongside the static HTML: `x-data` on the host,
  `x-text="_c3"` on a text slot that depends on state, `x-if`, `x-bind-*`, `x-on-*`,
  `x-model`, `x-for`, `x-ref`, `x-props-bind` (§7.2). Static-tier components emit no
  directives at all. A precomputed slot that is props-only emits plain text with no
  directive: it never changes on the client.
- `x-props` on the host carries `client_props` JSON-serialized with the `json_attr`
  filter (0.1.x rule: never `tojson` into an attribute).
- Child `Component` nodes: `static`/`native` children are **inlined** at compile time
  (their template body spliced, their own host and directives kept, names hashed per
  component so two instances do not collide; a child's prop expressions are
  substituted with the parent's expressions, so the child's first paint comes from the
  same seeds). `react` children become a slot `{{ _ssr_reviews_9f2a | safe }}` filled
  from the `ssr` job's output in the JSON context, or a placeholder element for
  client-only islands.

### 6.2 The template subset (`ServerExpr`) — the no-worker fast path

Closed grammar. Anything outside it is `Precomputed` (first paint) or `ClientOnly`.
The subset is a **performance boundary**, not a correctness one: a component whose
first-paint values all fit here needs no precompute job and renders in Rust without
Bun.

```
e := literal (string | number | boolean | null | undefined)
   | ident                      -- prop, loader field, state seed, loop binding, slot
   | e.member | e[literal]
   | !e | e && e | e || e | e ?? e
   | e == e | e != e | e === e | e !== e | e < e | e <= e | e > e | e >= e
   | e + e | e - e | e * e | e / e | e % e        -- numbers only; + on strings
   | e ? e : e
   | `template ${e} literal`
   | e.length
   | String methods on e: toUpperCase toLowerCase trim slice startsWith endsWith includes
   | Array methods on e: length, join(literal), includes(e)
   | e.map((item, index?) => <jsx>)              -- only as a For node source
   | Array.from({ length: N }).map(…)           -- N literal ≤ 1024 (0.1.x rule)
   | Object.keys(e) / Object.entries(e)          -- as a For source
```

Deliberately absent: calls to user functions, `new`, regex, Date/Math, spread,
optional chaining beyond `?.member` (lowered to `and` chains), destructuring in the
template. The list is extended only by adding a lowering to BOTH printers and a
golden test; never by special-casing a backend.

### 6.3 Seeding guarantee

The seed of each state and the initial value of each painted slot are computed once
on the server (template subset or precompute, §6.4) and the client chunk evaluates the
**same** expression (subset printed as JS, or the identical `js` of the precomputed
slot) on mount, so its signals start equal to what was painted; the directive runtime
then only writes to the DOM when a signal changes. There is no hydration diff and no
mismatch class of bug — if the two evaluations disagree, that is a compiler bug
caught by the golden test that renders both and compares.

### 6.4 Precompute

For every `Precomputed` first-paint value the server backend emits one slot in the
component's precompute job:

```ts
// ProductCard.server.ts — generated
import { formatPrice } from './money'
export function precompute({ item }) {          // only the inputs it reads
  const qty = 1                                 // state seeds, in declaration order
  return { _s1: formatPrice(item.price), _s2: formatPrice(item.price * qty) }
}
```

- Slots inside a `For` body are computed per item: the job returns an array aligned
  with the list source and the template indexes it with `loop.index0`.
- Seeds that are themselves precomputed are evaluated first, in declaration order, so
  later slots may read them (same order as the React body).
- The job runs in Bun after the loader, in the same batched call as every other job
  of the page (§3.3); its output is merged into the JSON context and cached per
  component by `inputs`.
- `cache()` on the component overrides the key and adds tags/TTL (§3.4).

---

## 7. Client lowering (directive chunk)

### 7.1 Chunk shape

```js
// ProductCard.client.js — generated, react-free
import { signal, computed, defineBehavior } from 'brust/runtime-dom'
import { formatPrice } from './money'            // bundled because `total` needs it on the client
export default defineBehavior('productCard_1a2b', ({ el, props, effect, onCleanup, ref }) => {
  const qty = signal(1)                                                  // useState
  const total = computed(() => formatPrice(props().item.price * qty())) // state-dependent precomputed slot
  const _h1 = () => qty.set(qty() + 1)                                   // onClick arrow, hoisted
  return { total, _h1 }
})
```

- `useState(init)` → `signal(<init as JS>)`; props read from `props()` (a signal,
  §7.4) — the author never sees signals.
- Derived values → `computed`. Handlers → members named `_hN` in source order.
- `useEffect` → `effect` (React semantics: cleanup before re-run and on unmount).
- `useRef` → `const r = ref('r')`; the runtime fills `r.current` from the `x-ref="r"`
  node after mount.
- State setters are rewritten: `setMode(x)` → `mode.set(x)`; `setMode(fn)` →
  `mode.set(fn)`. Reads `mode` → `mode()` **only inside the chunk**.
- A props-only precomputed slot never appears in the chunk.
- Per-item handlers inside `For`: the arrow `onClick={() => pick(item)}` becomes
  `_h2 = (item) => pick(item)` and the directive is `x-on-click="_h2:item"`; the
  runtime passes the loop binding then the event.
- Controlled inputs: the React idiom `value={q} onChange={e => setQ(e.target.value)}`
  (and `checked=` for checkboxes/radios) is recognized as a pair and lowered to
  `x-model="q"` instead of a bind + handler; any other `onChange` stays a handler.

### 7.2 Directive runtime contract (`packages/runtime-dom`)

Kept from 0.1.x by reference, not by code: `x-data`, `x-props`, `x-text`, `x-show`,
`x-if`, `x-bind-<attr>`, `x-on-<event>`, `x-model`, `x-for … by key`, mount via
`MutationObserver`, per-component lazy chunk import, SPA-swap disposal. Added:
`x-ref="<name>"`, item-scoped syntax `member:binding` (handlers and props),
`x-props-bind="<member>"` (§7.4), `ctx.ref`, and `props` as a signal. Removed:
nothing user-facing — users no longer write any of these; they are an output format.
The runtime remains eval-free (D7) and has its own unit tests independent of the
compiler.

### 7.3 Imports in client code

An import referenced from client code is bundled into the chunk by `bun build`
(later spec) if it is client-safe; the compiler only records `client_imports`. A
module is **server-only** if it matches §8.2; referencing it from client code is a
compile error.

### 7.4 Reactive props between native components (D8)

```tsx
function Parent() {
  const [count, setCount] = useState(0)
  return <Counter n={count} onReset={() => setCount(0)} />
}
function Counter({ n, onReset }) {
  return <button onClick={onReset}>{n}</button>
}
```

- **Template**: `Counter` is inlined as in §6.1; its host gets
  `x-data="counter_8c2d" x-props-bind="_p1"`; its first paint uses the parent's seed
  (`{{ count }}` → `0`). SSR is unchanged by this feature.
- **Parent chunk**: `_p1 = computed(() => ({ n: count(), onReset: _h1 }))` — one
  computed per child instance, holding whatever the parent passes, functions included.
- **Child chunk**: `props` is a signal; `n` in JSX becomes `x-text="_c1"` with
  `_c1 = computed(() => props().n)`; `onClick={onReset}` becomes
  `_h1 = (e) => props().onReset(e)`.
- **Runtime**: on mounting a host that carries `x-props-bind`, find the nearest
  ancestor `x-data` instance, read the named member, and bind an effect that writes
  the child's `props` signal whenever it changes. Initial value comes from the parent's
  computed (in memory), which equals the SSR seed by §6.3. In a `For`, the syntax
  `x-props-bind="_p1:item"` passes the loop binding, exactly like item handlers.
- **Nothing re-renders on mount**: the DOM already holds the seeds; only later
  changes write.
- A child's own `useState(props.n)` initializes once from the first value, as React
  does.
- A `react` child never gets `x-props-bind`; it hydrates from JSON, and passing it a
  function or a reactive value is an `Error` naming the prop.

---

## 8. Fallback and diagnostics

### 8.1 Diagnostic classes

| Class | Effect | Example |
|---|---|---|
| `Fallback` | tier → `react`; build continues; printed once per component in build output | "render reads `window.innerWidth` (line 7) — component renders with React on the client" |
| `Error` | build fails | server-only import reached from a state-dependent value / handler / effect; render reads request state; function prop passed to a `react` island; duplicate host markers; `key` missing on a list |
| `Warning` | informational | fragment root wrapped in `<brust-host>`; `useEffect` deps ignored; `'use client'`/`'use server'` leftover ignored; route `key` on a `react` page |

Every diagnostic has: component id, file, 1-based line/column from the HIR
`SourceLocation` (start-only today — §13), the rule name, and a one-line remediation.
The React Compiler's own `CompilerError` is forwarded as a `Fallback` with its
category.

### 8.2 Server-only detection

An import is server-only when any of: it resolves to a Node/Bun builtin (`node:*`,
`bun:*`, `fs`, `path`, …); its package.json has `"browser": false` for the resolved
file; or it is under a path listed in the app config `serverOnly: [...]`. The check
is on the import path, not on usage shape, so it is cheap and conservative.
Server-only code is **allowed** in precompute jobs and in props-only render
expressions (they run in Bun); it is an `Error` only when reachable from client code.

### 8.3 No directives

There is no `'use react'`, `'use native'`, `'use client'` or `'use server'` (D3).
A `'use client'` / `'use server'` string left over from a Next.js codebase is ignored
with a `Warning` so migrated files do not silently change meaning. Forcing a tier or
treating a Fallback as an Error (for authors who want the native guarantee) is an
app-config concern for the build spec, keyed by file path, never by source text.

---

## 9. Repository layout (v2)

```
brust/                                   # orphan branch v2
├─ Cargo.toml                            # workspace; pins Bun crates by git rev (§10)
├─ rust-toolchain.toml                   # Bun's nightly, copied verbatim from the pinned rev
├─ .cargo/config.toml                    # BUN_CODEGEN_DIR → bun-codegen/
├─ bun-codegen/                          # build_options.rs + byte-class tables (generated, committed)
├─ vendor/bun_react_compiler/            # patched copy of one Bun crate (§10.3)
├─ crates/
│  ├─ brust-compiler/                    # pure Rust lib; the only crate that sees bun_ast
│  │   src/
│  │   ├─ lib.rs                         # compile(source, opts) -> CompileOutput
│  │   ├─ parse/                         # bun_js_parser setup, stubs module (native.rs + extra)
│  │   ├─ analyze/
│  │   │   ├─ hir.rs                     # analyze_fn bridge, AstHost
│  │   │   ├─ hooks.rs                   # §4.3 classification
│  │   │   ├─ placement.rs               # Server / Precomputed / ClientOnly per value
│  │   │   ├─ capture.rs                 # job inputs, props, imports, server-only, browser globals
│  │   │   ├─ children.rs                # child tiers, reactive props, links
│  │   │   └─ tier.rs                    # the decision
│  │   ├─ ir/                            # §5 types + serde
│  │   ├─ lower/
│  │   │   ├─ template.rs                # IR → minijinja source
│  │   │   ├─ server.rs                  # IR → precompute job module
│  │   │   ├─ client.rs                  # IR → bun_ast module → bun_js_printer
│  │   │   └─ server_expr.rs             # the two printers for ServerExpr (one file, side by side)
│  │   └─ diagnostics/
│  ├─ brust-compiler-cli/                # `brustc <file.tsx> --emit ir|template|server|client|diag`
│  └─ brust-compiler-napi/               # thin binding for the Bun side (milestone 2)
├─ packages/
│  └─ runtime-dom/                       # directive runtime, TS, react-free, own tests
├─ tests/
│  ├─ fixtures/<case>/input.tsx           # + expected.ir.json, .jinja, .server.ts, .client.js, .diag.txt
│  └─ battery/                           # the react-coverage style sweep, re-targeted at v2 (§11)
└─ docs/design/                          # this file and its successors
```

Rule: `ir/` and `lower/` must compile without `bun_ast` in scope (enforced by a
`cargo check -p brust-compiler --no-default-features` job that stubs `parse/` and
`analyze/`). That is the seam that would let the front end be swapped if Bun's crates
ever stop being linkable.

---

## 10. Linking Bun's crates (recipe from the spike)

Spike: 2026-10-08, task `spike-bun-crate-link`, verdict GO. Full numbers in
`2026-10-08-bun-crate-link-spike.md`; the parts that bind this design:

### 10.1 Dependencies

```toml
[workspace.dependencies]
bun_js_parser      = { git = "https://github.com/oven-sh/bun", rev = "620b50f6abea3413a30235c5885bfe8cbffd592d" }
bun_ast            = { git = "…", rev = "…" }
bun_js_printer     = { git = "…", rev = "…" }
bun_react_compiler = { git = "…", rev = "…" }
bun_alloc / bun_core / bun_threading = { git = "…", rev = "…" }
```

- Pin a **rev on main at or after 620b50f6**; tag `bun-v1.4.2` lacks
  `src/sema/standalone/native.rs`.
- Toolchain: the `rust-toolchain.toml` of the pinned rev (`nightly-2026-09-15` today).
- Cold cost on a laptop: fetch ≈ 1m15s (440 MB git db), build ≈ 1m15s. CI caches
  `~/.cargo/git` and `target/`.

### 10.2 Inputs the crates expect from Bun's build

- `BUN_CODEGEN_DIR/build_options.rs`: hand-written (16 consts; `SHA` must be 40
  hex chars or `bun_core` fails const-eval). Committed under `bun-codegen/`.
- `BUN_CODEGEN_DIR/{json,xml}_byte_class.rs`: generated by Bun's own
  `scripts/build/{json,xml}ByteClass.ts`; regenerated by `bun scripts/bun-codegen.ts`
  whenever the rev moves. Committed.
- Native symbols: `src/sema/standalone/native.rs` copied verbatim plus 8 extra stubs
  (`Bun__JSC__operationMathPow`, `JSC__jsToNumber`, `Bun__WTFStringImpl__destroy`,
  `simdutf__convert_utf8_to_utf16le_with_errors`, `URL__getFileURLString`,
  `__bun_macro_context_call`, and the `TranspilerCacheImpl` Jsc dispatch via
  `bun_ast::link_impl_TranspilerCacheImpl!`). Macros stay disabled
  (`features.no_macros = true`), so the macro stub is unreachable.

### 10.3 The patch

`bun_react_compiler` keeps its pipeline `pub(crate)`. We carry a 44-line patch
(visibility of `FunctionNode`, `ProgramContext::new`, `lowering::lower`; plus
`pipeline::analyze_fn` that runs lowering + all HIR passes and returns
`(ReactiveFunction, Environment)` without codegen). Applied via `[patch]` to a
vendored copy of that one crate directory inside our workspace
(`vendor/bun_react_compiler/`, with its `../ast` path dep rewritten to the git dep).
Policy: the patch is kept upstreamable (no brust-specific logic inside Bun's crate)
and offered as a PR to Bun; while it is not merged, bumping the rev means re-applying
it, which is a documented step of the rev-bump checklist.

### 10.4 Bump checklist (`docs/design/bun-rev-bump.md`, to be written with M1)

1. pick rev → update `[workspace.dependencies]` + `rust-toolchain.toml`;
2. refresh `vendor/bun_react_compiler` and re-apply the patch;
3. regenerate `bun-codegen/`; update `SHA`;
4. re-copy `native.rs`; link; add stubs for any new undefined symbol;
5. run fixtures + battery; commit with the rev in the message.

---

## 11. Testing

- **Golden fixtures** (`tests/fixtures`): each case is one `input.tsx` plus the
  expected artifacts (ir, jinja, server.ts if any, client.js if any, diag).
  `brustc --update` rewrites them; CI diffs. Start with: static text, props,
  conditional, list with keys, nested list, `useState` toggle, derived value, effect
  with cleanup, handler capturing a prop, per-item handler, `useRef`, controlled input,
  fragment root, props-only precompute, state-dependent precompute, precompute inside
  a list, child static inline, child native with reactive props, child native inside
  a list with reactive props, child passing a function, child react island, client-only
  island, `cache()` override, each Fallback reason, each Error.
- **Dual-evaluation equivalence**: for every fixture with state, render the jinja (via
  minijinja in the test, with precompute slots produced by running `*.server.ts` under
  `bun`) with sample props, evaluate the chunk's initial computations (via `bun`), and
  assert the painted values are identical (§6.3).
- **Job purity**: a lint over `*.server.ts` that fails on any browser global or
  request accessor; plus the capture-analysis fixture asserting the exact `inputs`.
- **React-freedom**: assert no `react`/`react/jsx-runtime` import in any
  `.client.js`.
- **Battery**: the 0.1.x `scripts/react-coverage.ts` idea re-targeted: ~60 React
  constructs compiled through the real compiler, with expected tier and job count per
  row, output as `docs/react-coverage.md`. The number of `native`/`static` rows is the
  metric the milestone reports.
- **Runtime-dom**: `bun test` unit tests against a DOM (happy-dom) for every
  directive, including item-scoped handlers, `x-ref`, `x-props-bind` (plain and item
  scoped), and parent→child function props.
- **Gates**: `cargo test`, `cargo clippy -D warnings`, `bun check`, `bun test`,
  fixture diff. `bun build --check` for the runtime package.

---

## 12. Milestone 1 scope ("compiler + runtime-dom")

In: §4–§11 for a **single file** input with its directly imported components
resolvable on disk; `brustc` CLI; `runtime-dom` package including reactive props;
fixtures + battery; the Bun-rev bump checklist; this document kept current.

Out (next specs): the server (Rust HTTP + minijinja host + worker pool + the
per-component job cache and L1/L2), routing and loaders, `bun build` orchestration and
island hydration scheduling, stores shared between components, SSG, SPA navigation,
dev server/HMR, CLI `brust build/dev`, docs site.

Exit criteria: battery shows every row that this design says is `native`/`static`
compiling so, with the expected job count; every other row is `react` with a
diagnostic and no build error; dual-evaluation equivalence passes; the example
components of this doc (`ThemeToggle`, `ProductCard` with precompute, `Parent`/`Counter`
with reactive props, a keyed list with per-item handlers and child props, a form with a
controlled input) produce HTML + chunk that work in a browser against a hand-written
static HTML harness that fakes the job outputs.

---

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| Bun crates have no API stability; AST / `Host` trait can change per release. | Pinned rev; bump is a checklist; `ir/`+`lower/` isolated from `bun_ast` (§9 rule). |
| Nightly toolchain pinned to Bun's. | Same file copied verbatim; CI installs from it. |
| `SourceLocation` from the HIR is start-only. | Diagnostics quote the line; column ranges come from the AST span when available. |
| JSX runtime imports (`jsxDEV_…`) are added by Bun's bundler, not the parser. | The client backend does not print JSX at all; the react backend ships the original source to `bun build`. |
| Two printers for `ServerExpr` drifting; precompute `js` vs client `js` drifting. | One file for the two printers; the precomputed `js` is printed once and reused for both targets; dual-evaluation test on every fixture. |
| Precompute widens what runs in Bun, eroding the no-worker fast path. | Jobs are per component and cached by exact inputs; the battery reports job counts so growth of the template subset is measurable work. |
| Impure job (reads request state) returns another user's data from the per-component cache. | `Error` at compile time for request accessors in render (§3.2 rule 1); job-purity lint in CI. |
| Parent→child runtime link finds the wrong ancestor (portals, custom elements). | Link resolution is by nearest `x-data` ancestor only; portals are `react` tier. |

Open: (a) whether `useId` needs server-side support in M1 or can be deferred;
(b) naming of the host custom element for fragment roots. Lead rules on these when
the first fixture hits them.
