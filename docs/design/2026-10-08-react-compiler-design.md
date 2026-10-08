# brust v2 — React compiler design

Status: DRAFT for review · Date: 2026-10-08 · Owner: lead (Detoro) · authority: in-loop

This is the founding design of the `v2` branch. The branch starts empty; nothing from
0.1.x is carried over unless this document names it. The first milestone is the
**compiler only**. Server, runtime, CLI and docs come in later specs that build on
the IR defined here.

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
  islands runtime, the CLI. Each gets its own spec on top of the IR.
- Porting 0.1.x features (view transitions, page cache, MCP, AI runtime). They come
  back only when a later spec asks for them.
- Making every React program native. The fallback tier exists because some programs
  (context, Suspense, arbitrary runtime JS in the first paint) cannot be a template.

---

## 2. Decisions on record

These were settled with the human during brainstorming and are not re-opened by
implementers. Change requests go through a `task challenge` to the lead.

| # | Decision | Why |
|---|---|---|
| D1 | `v2` is an **orphan branch**; clean monorepo from day 1. | The 0.1.x compiler (19k lines of hand-rolled lowering) and runtime are not the base. |
| D2 | Authoring = **real React**: hooks are imported from `react`, JSX is React JSX, TypeScript types are React's. | A component that is valid React always has a working fallback (React SSR + hydrate) and migrates without edits. |
| D3 | **Native is the default tier.** A component that cannot be native **falls back** (to React) with a diagnostic; it never fails the build. Users may pin a tier with a `'use react'` directive at the top of the file. | Default-on only works when the fallback is safe. |
| D4 | **Server render target = Rust, minijinja templates.** First paint never runs JS. | brust's identity and its cache-hit / no-worker fast path. The price is an expression subset for anything the server has to paint (§6). |
| D5 | **Compiler = Rust, built on Bun's own crates** (`bun_js_parser`, `bun_ast`, `bun_js_printer`, `bun_react_compiler`) linked as git dependencies at a pinned rev, on Bun's pinned nightly. Not swc. | Verified by spike 2026-10-08 (§10): Bun's parse is the one Bun runs; `bun_react_compiler` is Meta's React Compiler ported, and its HIR / reactive scopes are exactly the state–handler–JSX dependency analysis this design needs. |
| D6 | **Bundling = `bun build`**, **type gate = `bun check` / `Bun.build({ check: true })`.** No rspack, no biome as the primary gate. | Both are built into the Bun the user already runs. |
| D7 | Directive runtime stays **eval-free**: a directive value is only the name of a member the compiler generated. Users never write directives. | Security property of 0.1.x kept; full-JS expressions still work because the compiler emits them as members of the client chunk. |

---

## 3. Authoring model and tiers

A **component** is a module whose default export is a function returning JSX.
Routes are components too (a later routing spec binds paths to modules). Every
component is classified by the compiler into exactly one tier:

| Tier | Condition | Server | Client |
|---|---|---|---|
| `static` | No hooks, no handlers, no refs; every painted expression is in the server subset (§6). | Rust renders the template. | Nothing ships. |
| `native` | Only the supported hook set (§4.3) and handlers; every painted expression is in the subset; state initializers are in the subset; no server-only capture (§8.2). | Rust renders the template with initial state seeded. | A react-free **directive chunk** (signals + generated members) bound to the HTML by `x-*` attributes. |
| `react` | Everything else: `useContext`/`use`, `Suspense`, custom hooks, `useReducer`, refs used for layout reads in render, class components, a painted expression outside the subset, a child receiving reactive state as a prop (§3.2). Also any file pinned with `'use react'`. | React SSR in a worker (streaming when it is a page). | React hydrates that subtree (an island when embedded in a native page; the whole page when the page itself is `react`). |

Tier is decided **per component**, bottom-up. A `react` child inside a `native`
parent is an SSR island at the child's boundary; the parent stays native. A `react`
page is React streaming SSR exactly like a 0.1.x non-native route.

### 3.1 The sentence that defines "native"

> A native component's HTML can be produced from props alone by a template, and
> everything that changes after first paint is a function of state the client owns.

Everything in §4–§7 is machinery for proving that sentence per component.

### 3.2 Rules the author must know (documented as "the native contract")

1. **Painted expressions are a subset.** Any expression whose value appears in the
   first-paint HTML (text, attribute, condition, list source, `useState` initializer)
   must lower to the server subset (§6.2). Anything else is fine *on the client* but
   makes the component `react`.
2. **Props captured by client code must be JSON.** A handler/effect that reads a prop
   makes that prop travel to the client as `x-props`; functions, class instances and
   DOM nodes cannot.
3. **Client code cannot touch server-only modules.** A handler/effect/initializer that
   references an import marked server-only (§8.2) is a **compile error** with the
   offending line, not a fallback — leaking server code into the browser is a
   security bug, not a performance one.
4. **Reactive state does not cross component boundaries as props** in milestone 1.
   `<Child n={count}/>` where `count` is state makes `Child` `react`. Share through a
   store (later spec) or lift the markup into the parent.
5. **Keys are required on lists** (`key={…}`) exactly as React warns; the compiler
   uses the key as the `x-for` identity.

---

## 4. Pipeline

```
 source.tsx ──► parse ──► analyze ──► IR ──► lower ──► artifacts
                (Bun)     (HIR +       (§5)   ├─ template backend → <name>.jinja
                          brust rules)        ├─ client backend   → <name>.client.js (ESM, react-free)
                                              └─ react backend    → unchanged module, marked `react`
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
- painted-expression check: for every place that reaches the first paint, try to
  lower to `ServerExpr` (§6.2); failure records a `Fallback` diagnostic with the span;
- capture analysis: for every handler/effect/initializer, the set of captured
  identifiers → props to serialize, module imports to bundle, server-only leaks (§8.2);
- list analysis: `.map` callbacks with `key`, nested depth, per-item handlers;
- child components: tier of each `<Capitalized/>` child and whether any prop it
  receives is reactive.

The analyzer never mutates the AST. It produces the IR (§5) plus diagnostics.

### 4.3 Hook set and their client meaning

| Hook | Client lowering | Server meaning |
|---|---|---|
| `useState(init)` | `signal(init)`; setter is `.set` (functional updates supported) | `init` evaluated by the template as the seed; must be in the subset |
| derived `const x = f(state…)` | `computed(() => …)` (full JS) | painted only if in the subset |
| `useMemo(fn, deps)` | `computed(fn)` (deps ignored; signals track) | same as derived |
| `useCallback(fn, deps)` | plain member | — |
| `useEffect(fn, deps)` | `ctx.effect(fn)` (cleanup return honored; deps ignored) | none |
| `useLayoutEffect` | same as `useEffect` but scheduled before paint of the chunk's first mutation | none |
| `useRef(init)` | `{ current: init }`; when passed as `ref={r}` to an element, bound to the node via `x-ref` after mount | none |
| `useId()` | server generates, client reads it from the DOM | deterministic per component instance |
| anything else (`useContext`, `use`, `useReducer`, `useTransition`, `useSyncExternalStore`, custom `useX`) | → tier `react` | — |

Hooks must be called unconditionally at the top level of the component (React's own
rule); the HIR already rejects violations.

### 4.4 Lower

Backends consume only the IR. They never see `bun_ast`.

- **template backend** → minijinja source (§6).
- **client backend** → builds a `bun_ast` module for the chunk and prints it with
  `bun_js_printer` (§7). The chunk imports only `brust/runtime-dom` and the user's
  client-safe imports; it must contain no `react` import (asserted by a test).
- **react backend** → the original module untouched; the build pipeline (later spec)
  feeds it to `bun build` with React.

---

## 5. The IR

One `ComponentIR` per component. Serializable to JSON (that is what golden tests
assert against). Rust types live in `crates/brust-compiler/src/ir/`.

```rust
struct ComponentIR {
    id: ComponentId,            // stable: camelCase(file stem) + 8-hex hash(path)
    source: SourcePath,
    tier: Tier,                 // Static | Native | React { reason: Diagnostic }
    props: Vec<PropDecl>,       // name, ts type text, json_serializable: bool
    state: Vec<StateDecl>,      // name, setter, init: Expr (both forms, §5.1)
    derived: Vec<DerivedDecl>,  // name, expr: Expr, deps: Vec<Dep>
    effects: Vec<EffectDecl>,   // body: JsFn, deps: Vec<Dep>, layout: bool
    handlers: Vec<HandlerDecl>, // generated name `_hN`, body: JsFn, captures: Vec<Capture>
    refs: Vec<RefDecl>,         // name, bound_to: Option<NodeId>
    template: Node,             // §5.2
    client_props: Vec<PropName>,// props the client chunk reads (→ x-props)
    client_imports: Vec<Import>,// imports the chunk needs bundled
    diagnostics: Vec<Diagnostic>,
}
```

### 5.1 Expressions have two forms

```rust
enum Expr {
    Server(ServerExpr),         // in the subset: lowers to jinja AND to JS
    ClientOnly(JsFn),           // arbitrary JS: lowers to a computed in the chunk only
}
```

A painted slot whose expression is `ClientOnly` is a tier violation (→ `react`);
a non-painted slot (used only inside handlers/effects) may be `ClientOnly`.

`ServerExpr` (§6.2) is closed and small on purpose. It carries enough structure to
print as a minijinja expression and as a JS expression, so the first paint and the
client's initial computation are the same program and cannot disagree.

### 5.2 Template tree

```rust
enum Node {
    Element { tag, attrs: Vec<Attr>, children: Vec<Node>, host: bool, ref_: Option<RefName> },
    Text(String),
    Slot(Expr),                                   // {expr} → text
    If { cond: Expr, then: Vec<Node>, else_: Vec<Node> },
    For { source: Expr, item: Binding, index: Option<Binding>, key: Expr, body: Vec<Node> },
    Component { id: ComponentId, props: Vec<(PropName, Expr)>, tier: Tier, children: Vec<Node> },
    Fragment(Vec<Node>),
}
enum Attr {
    Static(String, String),
    Dynamic(String, Expr),                        // attr={expr}
    Event(String, HandlerName, Option<ItemBinding>), // onClick={…}; item-scoped inside For
}
```

`host: bool` marks the single element that carries `x-data` (the mount host): the
root element when the component returns one element; otherwise the compiler wraps
the fragment in a `<brust-host style="display:contents">` and warns. Every `Node`
records which identifiers it depends on (from the HIR), which is what decides
whether it gets a directive.

---

## 6. Server lowering (minijinja)

### 6.1 Template shape

- Props and loader data are the template context, exactly as 0.1.x (`{{ user.name | e }}`;
  autoescape stays `None` with explicit `| e` on every dynamic output — the 0.1.x XSS
  lesson is kept).
- State seeds: for each `StateDecl`, the template computes the seed once at the top
  (`{% set mode = 'dark' %}`) from the initializer's `ServerExpr`; every painted slot
  that depends on state reads the seed.
- Directive attributes are emitted alongside the static HTML: `x-data` on the host,
  `x-text="_c3"` on a text slot that depends on state, `x-if`, `x-bind-*`, `x-on-*`,
  `x-for`, `x-ref` (§7.2). Static-tier components emit no directives at all.
- `x-props` on the host carries `client_props` JSON-serialized with the `json_attr`
  filter (0.1.x rule: never `tojson` into an attribute).
- Child `Component` nodes: `static`/`native` children are **inlined** at compile time
  (their template body spliced, their own host and directives kept, names hashed per
  component so two instances do not collide); `react` children become an SSR island
  slot `{{ island("Child_8f1e", props) }}` the server spec will define.

### 6.2 The server subset (`ServerExpr`)

Closed grammar. Anything outside it is `ClientOnly`.

```
e := literal (string | number | boolean | null | undefined)
   | ident                      -- prop, loader field, state seed, loop binding
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

Deliberately absent: calls to user functions, `new`, regex, Date/Math (except as
`ClientOnly`), spread, optional chaining beyond `?.member` (lowered to `and` chains),
destructuring in the template. The list is extended only by adding a lowering to BOTH
printers and a golden test; never by special-casing a backend.

### 6.3 Seeding guarantee

The seed of each state and the initial value of each painted slot are computed by the
template from props using `ServerExpr`. The client chunk evaluates the **same**
`ServerExpr` printed as JS on mount, so its signals start equal to what was painted;
the directive runtime then only writes to the DOM when a signal changes. There is no
hydration diff and no mismatch class of bug — if the two printers disagree, that is a
compiler bug caught by the golden test that renders both and compares.

---

## 7. Client lowering (directive chunk)

### 7.1 Chunk shape

```js
// ThemeToggle.client.js — generated, react-free
import { signal, computed, defineBehavior } from 'brust/runtime-dom'
export default defineBehavior('themeToggle_1a2b3c4d', ({ el, props, effect, onCleanup, ref }) => {
  const mode = signal('dark')                                  // useState
  const label = computed(() => mode() === 'dark' ? 'Light' : 'Dark')   // derived
  effect(() => { document.documentElement.dataset.mode = mode() })     // useEffect
  const _h1 = () => mode.set(m => m === 'dark' ? 'light' : 'dark')     // onClick arrow, hoisted
  return { mode, label, _h1 }
})
```

- `useState('dark')` → `signal(<ServerExpr as JS>)` with props read from `props`.
- Derived values → `computed`. Handlers → members named `_hN` in source order.
- `useEffect` → `effect` (React semantics: cleanup before re-run and on unmount).
- `useRef` → `const r = ref('r')`; the runtime fills `r.current` from the `x-ref="r"`
  node after mount.
- State setters are rewritten: `setMode(x)` → `mode.set(x)`; `setMode(fn)` →
  `mode.set(fn)`. Reads `mode` → `mode()` **only inside the chunk**; the author never
  sees signals.
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
`x-ref="<name>"`, item-scoped handler syntax `member:binding`, `ctx.ref`. Removed:
nothing user-facing — users no longer write any of these; they are an output format.
The runtime remains eval-free (D7) and has its own unit tests independent of the
compiler.

### 7.3 Imports in client code

An import referenced from client code is bundled into the chunk by `bun build`
(later spec) if it is client-safe; the compiler only records `client_imports`. A
module is **server-only** if it matches §8.2; referencing it from client code is a
compile error.

---

## 8. Fallback and diagnostics

### 8.1 Diagnostic classes

| Class | Effect | Example |
|---|---|---|
| `Fallback` | tier → `react`; build continues; printed once per component in build output | "painted expression `formatPrice(x)` is not in the server subset (line 12) — component renders with React" |
| `Error` | build fails | server-only import captured by a handler; duplicate host markers; `key` missing on a list |
| `Warning` | informational | fragment root wrapped in `<brust-host>`; `useEffect` deps ignored |

Every diagnostic has: component id, file, 1-based line/column from the HIR
`SourceLocation` (start-only today — §12), the rule name, and a one-line remediation.
The React Compiler's own `CompilerError` is forwarded as a `Fallback` with its
category.

### 8.2 Server-only detection

An import is server-only when any of: it resolves to a Node/Bun builtin (`node:*`,
`bun:*`, `fs`, `path`, …); its package.json has `"browser": false` for the resolved
file; it is under a path listed in the app config `serverOnly: [...]`; or the module
itself has `'use server'`. The check is on the import path, not on usage shape, so it
is cheap and conservative. (`'use client'` is accepted and means "pin to `react`",
same as `'use react'`, for people arriving from Next.)

### 8.3 Pinning

`'use react'` as the first statement pins the file to the `react` tier (no analysis).
`'use native'` pins to native-or-error: any `Fallback` becomes an `Error`, for
authors who want the guarantee.

---

## 9. Repository layout (v2)

```
brust/                                   # orphan branch v2
├─ Cargo.toml                            # workspace; pins Bun crates by git rev (§10)
├─ rust-toolchain.toml                   # Bun's nightly, copied verbatim from the pinned rev
├─ .cargo/config.toml                    # BUN_CODEGEN_DIR → bun-codegen/
├─ bun-codegen/                          # build_options.rs + byte-class tables (generated, committed)
├─ crates/
│  ├─ brust-compiler/                    # pure Rust lib; the only crate that sees bun_ast
│  │   src/
│  │   ├─ lib.rs                         # compile(source, opts) -> CompileOutput
│  │   ├─ parse/                         # bun_js_parser setup, stubs module (native.rs + extra)
│  │   ├─ analyze/
│  │   │   ├─ hir.rs                     # analyze_fn bridge, AstHost
│  │   │   ├─ hooks.rs                   # §4.3 classification
│  │   │   ├─ painted.rs                 # ServerExpr lowering attempts
│  │   │   ├─ capture.rs                 # props / imports / server-only
│  │   │   └─ tier.rs                    # the decision
│  │   ├─ ir/                            # §5 types + serde
│  │   ├─ lower/
│  │   │   ├─ template.rs                # IR → minijinja source
│  │   │   ├─ client.rs                  # IR → bun_ast module → bun_js_printer
│  │   │   └─ server_expr.rs             # the two printers for ServerExpr (one file, side by side)
│  │   └─ diagnostics/
│  ├─ brust-compiler-cli/                # `brustc <file.tsx> --emit ir|template|client|diag`
│  └─ brust-compiler-napi/               # thin binding for the Bun side (milestone 2)
├─ packages/
│  └─ runtime-dom/                       # directive runtime, TS, react-free, own tests
├─ tests/
│  ├─ fixtures/<case>/input.tsx           # + expected.ir.json, expected.jinja, expected.client.js, expected.diag.txt
│  └─ battery/                           # the react-coverage style sweep, re-targeted at v2 (§11)
└─ docs/design/                          # this file and its successors
```

Rule: `ir/` and `lower/` must compile without `bun_ast` in scope (enforced by a
`cargo check -p brust-compiler --no-default-features` job that stubs `parse/` and
`analyze/`). That is the seam that would let the front end be swapped if Bun's crates
ever stop being linkable.

---

## 10. Linking Bun's crates (recipe from the spike)

Spike: 2026-10-08, task `spike-bun-crate-link`, verdict GO. Full numbers in `2026-10-08-bun-crate-link-spike.md`; the parts that bind this design:

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

- **Golden fixtures** (`tests/fixtures`): each case is one `input.tsx` plus the four
  expected artifacts. `brustc --update` rewrites them; CI diffs. Start with: static
  text, props, conditional, list with keys, nested list, `useState` toggle,
  derived value, effect with cleanup, handler capturing a prop, per-item handler,
  `useRef`, fragment root, child static inline, child react island, each Fallback
  reason, each Error.
- **Dual-print equivalence**: for every fixture with state, render the jinja (via
  minijinja in the test) with sample props and evaluate the chunk's initial
  computations (via `bun` in the test) and assert the painted values are identical
  (§6.3).
- **React-freedom**: assert no `react`/`react/jsx-runtime` import in any
  `.client.js`.
- **Battery**: the 0.1.x `scripts/react-coverage.ts` idea re-targeted: ~60 React
  constructs compiled through the real compiler, with expected tier per row, output
  as `docs/react-coverage.md`. The number of `native` rows is the metric the milestone
  reports.
- **Runtime-dom**: `bun test` unit tests against a DOM (happy-dom) for every
  directive, including item-scoped handlers and `x-ref`.
- **Gates**: `cargo test`, `cargo clippy -D warnings`, `bun check`, `bun test`,
  fixture diff. `bun build --check` for the runtime package.

---

## 12. Milestone 1 scope ("compiler only")

In: §4–§11 for a **single file** input with its directly imported components
resolvable on disk; `brustc` CLI; `runtime-dom` package; fixtures + battery; the
Bun-rev bump checklist; this document kept current.

Out (next specs): the server (Rust HTTP + minijinja host + worker pool), routing and
loaders, `bun build` orchestration and island hydration, stores shared between
components, SSG, SPA navigation, dev server/HMR, CLI `brust build/dev`, docs site.

Exit criteria: battery shows every row that this design says is `native` compiling
as `native`; every other row is `react` with a diagnostic and no build error; dual-print
equivalence passes; the three example components from this doc (`ThemeToggle`, a
keyed list with per-item handlers, a form with `x-model`-style two-way input) produce
HTML + chunk that work in a browser against a hand-written static HTML harness.

---

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| Bun crates have no API stability; AST / `Host` trait can change per release. | Pinned rev; bump is a checklist; `ir/`+`lower/` isolated from `bun_ast` (§9 rule). |
| Nightly toolchain pinned to Bun's. | Same file copied verbatim; CI installs from it. |
| `SourceLocation` from the HIR is start-only. | Diagnostics quote the line; column ranges come from the AST span when available. |
| JSX runtime imports (`jsxDEV_…`) are added by Bun's bundler, not the parser. | The client backend does not print JSX at all; the react backend ships the original source to `bun build`. |
| Two printers for `ServerExpr` drifting. | One file, side by side, dual-print equivalence test on every fixture. |
| The subset is too small for real apps. | The battery measures it; growing the subset is the planned work, not a surprise. |
| Reactive props to children (§3.2 rule 4) are a common React pattern. | Explicit M2 item: a child native component receiving a parent signal becomes a nested scope sharing the parent's chunk. |

Open: (a) whether `useId` needs server-side support in M1 or can be deferred;
(b) naming of the host custom element for fragment roots; (c) whether `'use client'`
should mean "pin react" or be rejected to avoid Next confusion. Lead rules on these
when the first fixture hits them.
