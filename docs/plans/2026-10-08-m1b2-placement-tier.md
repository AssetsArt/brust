# M1b-2 — Dependency classification, placement, jobs, captures, children, `cache()`, tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the analyzer: every `Expr::Raw` in a `ComponentIR` becomes `Server`, `Precomputed` or `ClientOnly`; precompute/ssr **jobs** with exact inputs are emitted; captures yield `client_props`/`client_imports` and the server-only check; child components are resolved, compiled and linked (`ChildLink`); `cache()` is read; and `tier` is decided with the diagnostics the spec names. After this plan `brustc --emit ir` is complete and M1c can lower.

**Architecture:** Pure passes over the bun-free IR (`analyze/passes/*.rs`), each a function `fn(&mut ComponentIR, &Ctx) -> ()` run in a fixed order by `analyze/component.rs`: `deps` → `server_expr` → `placement` → `captures` → `children` → `cache` → `tier`. Multi-file resolution lives in `analyze/modules.rs` (resolve relative import → path, compile with a per-run cache). Nothing here touches `bun_ast` except `modules.rs`, which calls `parse_tsx` + `analyze_component` on the child file.

**Tech Stack:** Rust; no new crates (file resolution by `std::path`).

**Spec:** §3.2 (rules 1–5), §3.3 (jobs), §3.4 (`cache()`), §3.5 (`needs_worker`), §4.2(b), §5 (`Expr`, `JobDecl`, `ChildLink`), §6.2 (grammar), §6.4 (precompute, per-item slots), §7.4 (links), §8 (diagnostics), `docs/plans/m1a-followups.md`.

## Global Constraints

- Passes are deterministic: slots are numbered `_s1…` in template document order; handlers `_hN` keep M1b-1 numbering; child links `_p1…` in document order; jobs list `inputs` sorted and deduplicated as dotted prop paths (`item.price`).
- The §6.2 grammar is the **only** thing that decides `Server`; it is one table in `server_expr.rs` with one golden test per production. Growing it means adding a row + a fixture, never a special case elsewhere.
- Browser globals that make a component `react { client_only: true }` when read during render: `window document navigator location history localStorage sessionStorage screen matchMedia requestAnimationFrame`.
- Server-only import sources (`Error` when reachable from client code): any `node:*`, `bun:*`, and the bare names `fs path os crypto child_process net http https stream zlib worker_threads cluster dns tls readline sqlite`, plus the config list `serverOnly` (a `Vec<String>` of path prefixes passed in `AnalyzeOptions`; default empty). `package.json` `browser: false` is **not** implemented in M1b-2 (ledger item).
- Request-state rule (§3.2 rule 1 / §3.5): a prop named `req`, `request`, `cookies` or `headers` read anywhere in render or in a job → `Error("request-state-in-render")`.
- A child is resolved only from a **relative** import (`./`, `../`) with `.tsx`/`.ts`/`/index.tsx`; a package import that is used as a component → `Fallback("external-component")` (the child becomes a `react` island).
- `cache()` is recognised only as `export default cache(Comp, { … })` with `cache` imported from `brust`.
- Golden fixtures are the contract (`BRUSTC_UPDATE=1`, diff reviewed).

## Review Focus

1. **A derived value chain** (`const a = props.x + 1; const b = a * 2; <p>{b}</p>`) must classify `b` as props-only through `a`, not as `Opaque`/client — Task 1 pins it.
2. **A state-dependent precomputed slot whose helper is server-only** (`total = db.price(qty)`) must be an `Error` naming the line, not a Fallback (spec §3.2 rule 2) — Task 4 pins it.
3. **Precompute slots inside a list** (`items.map(i => <li>{fmt(i.price)}</li>)`) must become one per-item job output aligned with the list, with `inputs = ["items"]` (the whole list is the input because the per-item function reads it) — Task 3 pins it.
4. **A child that imports the parent** (import cycle) must not recurse forever: the module cache returns an in-progress marker → `Fallback("import-cycle")` — Task 5 pins it.
5. **A component that is `static` but has a `react` child** must have `needs_worker = true` and `tier: Static` (the island is the child's job, the parent stays a template) — Task 7 pins it.

---

## File structure

```
crates/brust-compiler/src/analyze/
├─ passes/mod.rs            run_passes(&mut ComponentIR, &PassCtx)
├─ passes/deps.rs           Deps, deps_of(&RawExpr, &ComponentIR) -> Deps          (Task 1)
├─ passes/server_expr.rs    try_server(&RawExpr) -> Result<ServerExpr, &'static str> (Task 2)
├─ passes/placement.rs      placement pass: Server / Precomputed / ClientOnly, jobs  (Task 3)
├─ passes/captures.rs       client_props, client_imports, server-only + request-state (Task 4)
├─ passes/children.rs       resolve children, tiers, ChildLink, island prop checks    (Task 5)
├─ passes/cache.rs          cache() recognition                                        (Task 6)
├─ passes/tier.rs           tier + needs_worker + diagnostics ordering                 (Task 7)
├─ modules.rs               ModuleCache: path -> ComponentIR (in-progress marker)       (Task 5)
└─ component.rs             AnalyzeOptions { server_only: Vec<String>, root: PathBuf }; analyze_file(path, opts)
```

Frozen additions to the IR (fields added, nothing renamed):

```rust
// ir/expr.rs
pub enum Expr {
    Raw(RawExpr),
    Server(ServerExpr),
    Precomputed { slot: String, js: String, inputs: Vec<String>, state_dependent: bool, per_item: Option<String> },
    ClientOnly { js: String },
}
// ir/decls.rs
pub enum JobKind { Precompute, Ssr { client_only: bool } }
pub struct JobDecl { pub kind: JobKind, pub inputs: Vec<String>, pub outputs: Vec<String> }
pub struct ChildLink { pub id: u32, pub child: String /* component id */, pub props_member: String /* _pN */, pub item_scoped: Vec<String>, pub props: Vec<(String, Expr)> }
// ir/mod.rs
pub struct ComponentIR { …, pub children: Vec<ChildRef> }   // ChildRef { name, id: Option<String>, path: Option<String>, tier: Tier }
```

Printing JS from a `RawExpr` (`ir/expr.rs::RawExpr::to_js(&self) -> String`) is needed by Task 3 for `Precomputed.js` and `ClientOnly.js`: literals, idents (by name), members, index, calls, binary/unary (JS spelling), cond, template, array, object, arrow (`(params) => expr` or the captured block source), `Opaque.source` verbatim. Task 3 adds it with a table test (it is also the client half of the dual printer M1c needs).

---

### Task 1: Dependency classification

**Files:** `passes/deps.rs`, `passes/mod.rs`; test `tests/deps.rs`

**Interfaces:**
```rust
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Deps { pub props: BTreeSet<String> /* dotted paths */, pub state: BTreeSet<String>, pub setters: BTreeSet<String>, pub imports: BTreeSet<(String, String)>, pub globals: BTreeSet<String>, pub browser: bool, pub loop_bindings: BTreeSet<String>, pub opaque: bool }
pub fn deps_of(e: &RawExpr, ir: &ComponentIR, loop_scope: &[String]) -> Deps
```
Rules: `Ident{Prop}` → props (a `Member` chain rooted at a prop becomes the dotted path `item.price`; an `Index` or call on it truncates the path at the last static member); `Ident{State}`/`Setter`; `Ident{Local}` → look up `ir.derived` by name and union its deps (memoised; cycle → stop); `Ident{Import}`; `Ident{Global}` → globals, and `browser = true` if in the browser list; `Ident{LoopBinding}` or a name in `loop_scope` → loop_bindings; `Arrow` → deps of its captures (params excluded); `Opaque` → `opaque = true` plus deps of nothing (we cannot see inside; captures of an opaque arrow come from M1b-1's `captures` field); `Jsx` → union over the node's exprs.

- [ ] **Step 1: Failing tests** — build IRs with `analyze_component` on small sources and assert: `derived chain` (Review Focus 1) gives `props == {"x"}` and `state` empty for `b`; `label` in theme-toggle gives `state == {"mode"}`; `fmt(a.price)` gives `props == {"a.price"}` and `imports == {("./money","fmt")}`; `window.innerWidth` sets `browser`.
- [ ] **Step 2–5:** implement, pass, commit `feat(analyze): dependency classification over RawExpr`.

---

### Task 2: The template subset (`try_server`)

**Files:** `passes/server_expr.rs`; test `tests/server_expr.rs` (table-driven)

**Interfaces:** `pub fn try_server(e: &RawExpr) -> Result<ServerExpr, &'static str>` — `Ok` iff every node is in the §6.2 grammar:

| RawKind | accepted when |
|---|---|
| `Lit` | always |
| `Ident` | kind ∈ {Prop, Local-that-is-Server-derived (checked by the placement pass, here any Local), State, LoopBinding}; `Import`/`Global`/`Setter` → `Err("identifier kind")` |
| `Member` | target accepted; `optional` allowed (lowers to `and` chains) |
| `Index` | index is a `Lit` |
| `Unary` | `Not`, `Neg` |
| `Binary` | all `BinOp` variants (M1c prints `+` as string concat when either side is a string literal/template, else numeric) |
| `Cond` | all three accepted |
| `Template` | all parts accepted |
| `Call` | callee `Member{target,name}` with name ∈ `toUpperCase toLowerCase trim slice startsWith endsWith includes join` and literal-only args (`join` requires a `Lit(Str)`); callee `Member{target: Ident Global "Object", name: keys|entries}` with one accepted arg; callee `Member{target: Call(Array.from({length: Lit N})), name: map}` with `N ≤ 1024`; **`map` elsewhere is not a ServerExpr** (it is a `For` node) → `Err("map outside list")`; anything else → `Err("call")` |
| `Array`/`Object` | elements accepted (used for `includes([…])` args and style objects) |
| `Arrow`, `Jsx`, `Opaque` | `Err` |

- [ ] **Step 1: Failing table test** — ≥ 20 rows: one accepted example per production, one rejected per deliberate absence (`fmt(x)`, `new Date()`, regex, spread, `a ** b`, `x.map(...)`, `window.x`).
- [ ] **Steps 2–5:** implement, pass, commit `feat(analyze): try_server — the §6.2 template subset as one table`.

---

### Task 3: Placement + precompute jobs + `RawExpr::to_js`

**Files:** `passes/placement.rs`, `ir/expr.rs` (`to_js`), `passes/mod.rs`; tests `tests/placement.rs`, `tests/to_js.rs`; goldens updated

**Algorithm** (one walk of the template in document order, then state inits and derived values):

1. For every painted `Expr::Raw(e)` at: `Slot`, `Attr::Dynamic`, `If.cond`, `For.source`, `For.key`, `Component.props` values of **react** children (their SSR job inputs), `StateDecl.init`, and every `DerivedDecl` reachable from a painted slot:
   - `d = deps_of(e)`; if `d.browser` → mark `react_client_only` (Task 7 decides tier) and leave `Raw`.
   - if `try_server(e)` is `Ok` **and** every `Local` it reads is itself placed `Server` → `Expr::Server`.
   - else if `d.state.is_empty()` → `Expr::Precomputed { slot: "_sN", js: e.to_js(), inputs: d.props (as paths), state_dependent: false, per_item }`.
   - else → `Expr::Precomputed { …, state_dependent: true }` — the job evaluates it with state **seeds** (Task 3 emits the seed order: state inits first, in declaration order) and the client chunk recomputes it (M1c).
   - `per_item = Some(binding)` when the slot sits inside a `For` body and reads a loop binding; the job then returns an array aligned with the list and `inputs` include the list source's prop path.
2. Non-painted `Raw` (handler bodies, effect bodies, props to native children) → `Expr::ClientOnly { js }` (handlers/effects are already `RawExpr` in decls; the pass leaves them and the client backend prints them).
3. Collect one `JobDecl { kind: Precompute, inputs: union, outputs: all slots }` if any slot was precomputed.

`RawExpr::to_js` table test: `a.b` → `a.b`; `a === 1 ? 'x' : b` → `a === 1 ? "x" : b`; template → backticks; `Ident{Prop}` prints `props.<name>` **only when** `to_js_with(ctx)` is asked for client context — add `pub fn to_js_in(&self, ctx: JsCtx) -> String` with `JsCtx::Server` (props destructured: bare names) and `JsCtx::Client` (`props().name`, state `name()`); `to_js()` = server.

- [ ] **Tests:** `product-card` fixture: `item.name` → `Server`; `fmt(item.price)` → `Precomputed{_s1, inputs:["item.price"], state_dependent:false}`; `fmt(item.price * qty)` → `Precomputed{_s2, state_dependent:true}`; job inputs `["item.price"]`; keyed list with `fmt(i.price)` in the body → `per_item: Some("i")`, inputs `["items"]` (Review Focus 3); `theme-toggle`: `label` → `Server` (ternary over state), `mode` init → `Server(Lit)`, no jobs.
- [ ] Commit `feat(analyze): placement pass — Server / Precomputed / ClientOnly and precompute jobs`.

---

### Task 4: Captures, client props/imports, server-only and request-state errors

**Files:** `passes/captures.rs`; tests `tests/captures.rs`; fixture `server-leak` golden gains the Error

Rules: union `deps_of` over every handler body, effect body, state init (client needs the seed expression too), state-dependent precomputed `js`, and props passed to native children: `client_props` = sorted prop **root names** (M1c serialises whole props; paths are for cache keys only); `client_imports` = sorted `(source, imported)`. For each import in that set: server-only (Global Constraints list or `serverOnly` prefixes) → `Diagnostic::error("server-only-in-client", "<imported> from <source> is server-only but is used by <handler|effect|state init|state-dependent value> at line N", loc, "move the computation into the loader or make the module browser-safe")`. Request-state: any prop root in `{req, request, cookies, headers}` read anywhere (render, jobs, client) → `Error("request-state-in-render")`.

- [ ] **Tests:** theme-toggle → `client_props == []`, `client_imports == []`; product-card → `client_props == ["item"]`, `client_imports == [("./money","fmt")]`; server-leak fixture (`import { readFileSync } from 'node:fs'` used in `onClick`) → one Error with the line; a props-only precomputed slot using `node:fs` → **no** error (it runs in the job); Review Focus 2 → Error.
- [ ] Commit `feat(analyze): captures — client props/imports, server-only and request-state checks`.

---

### Task 5: Children — resolution, compilation cache, tiers, links

**Files:** `analyze/modules.rs`, `passes/children.rs`, `component.rs` (`AnalyzeOptions`, `analyze_file`); tests `tests/children.rs`; fixtures `parent-counter/{input,Counter}.tsx`, `react-child/{input,Reviews}.tsx`, `import-cycle/{input,A}.tsx`

Rules:
- `ModuleCache { map: HashMap<PathBuf, Entry> }` with `Entry::{InProgress, Done(Rc<ComponentIR>)}`; `analyze_file(path)` inserts `InProgress`, parses (inside the compiler thread the caller already provides), runs passes, stores `Done`. A hit on `InProgress` → `Fallback("import-cycle")` for the requesting parent and the child is treated as `react`.
- For each `Node::Component{name, source: Some(rel)}`: resolve against the parent's directory; compile; record `ChildRef{name, id, path, tier}`; set the node's `tier`.
- Native/static child: for each prop value `v`: if `deps_of(v)` has state or loop bindings, or `v` is an `Arrow`/`Ident{Local}` naming a handler → the child needs a link: create `ChildLink{id, child: child_id, props_member: "_pN", item_scoped: loop scope, props: all props as ClientOnly/Server}` and set `node.link = Some(id)`; static JSON props stay on the node (for the SSR seed) — M1c prints both `x-props` (seed) and `x-props-bind`.
- React child: any prop that is an `Arrow`/function or state-dependent → `Error("island-prop", …)`; otherwise props are job inputs of an `Ssr` job (`JobDecl{kind: Ssr{client_only: child.tier.client_only}, inputs: prop paths, outputs: ["_ssr_<childId>"]}`).
- `source: None` (local component in the same file) → compile the local function via the same reader (M1b-1's `analyze_component` on a named function — add `analyze_local_component(parsed, name)`), tier it; unsupported → `Fallback("local-component")`.
- External package component → `Fallback("external-component")`, treated as a `react` child with an Ssr job.

- [ ] **Tests:** parent-counter: `children[0].tier == Native`, one `ChildLink{props_member:"_p1"}`, `Counter` node `link == Some(1)`; keyed list of native children with `item` props → `item_scoped == ["item"]`; react-child → `jobs` contains `Ssr`, `needs_worker` pending Task 7; passing `onReset={() => …}` to the react child → `Error("island-prop")`; import-cycle → Fallback, no stack overflow.
- [ ] Commit `feat(analyze): child components — module cache, tiers, reactive-prop links, island prop checks`.

---

### Task 6: `cache()` recognition

**Files:** `passes/cache.rs`; test in `tests/cache.rs`; fixture `cached-card/input.tsx`

`export default cache(ProductCard, { key: (p) => p.item.id, tags: (p) => ['product', p.item.id], revalidate: 60 })` where `cache` is `Import{source:"brust", imported:"cache"}` → `ir.cache = Some(CacheDecl{key, tags, revalidate})` and the component analysed is `ProductCard` (a local function or an import). A `cache()` call with a non-object second argument → `Error("cache-shape")`. Also recognise the function-declaration form `export default function X(){}` unchanged (no cache).

- [ ] Commit `feat(analyze): cache() wrapper recognition`.

---

### Task 7: Tier decision, `needs_worker`, diagnostics order, goldens

**Files:** `passes/tier.rs`; update `component.rs` run order; regenerate all `expected.ir.json`/`expected.diag.txt`; `README.md` fixtures section

Rules (spec §3): 
- `React{client_only:true}` if any painted expression read a browser global; `React{client_only:false, reason}` if any `Fallback` diagnostic was recorded (hook-unsupported, control-flow, member-tag, default-export-shape, local-component, external-component only affects the child, import-cycle, precompute of an `Opaque` arrow in render…); 
- else `Static` if `state`, `handlers`, `effects`, `refs`, `child_links` are all empty and no `Precomputed{state_dependent:true}`; else `Native`.
- `needs_worker = !jobs.is_empty()` (Ssr jobs included).
- Diagnostics sorted by `(class severity, line, col)`; `--emit diag` exits 1 on any `Error`.
- Every fixture gets a one-line `expected.tier.txt`? No — the tier is in `expected.ir.json`; the battery (M1e) reads it from there.

- [ ] **Tests:** static-text → `Static`, `needs_worker false`; theme-toggle → `Native`, no jobs; product-card → `Native`, 1 precompute job, `needs_worker true`; parent-counter → `Native` with link; react-child parent → `Static` + `needs_worker true` (Review Focus 5); client-only → `React{client_only:true}`; server-leak → tier `Native` but diag has an Error and `brustc --emit diag` exits 1.
- [ ] `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`, review, commit `feat(analyze): tier decision and needs_worker; complete --emit ir goldens`.

---

## Rulings carried over from the M1b-1 handoff (lead, 2026-10-09)

Dew's READY note on `m1b1-ir-readers` listed five open points. Rulings, binding for this plan:

1. **JSX inside `Opaque` / `ArrowBody::Block` sources** (handler, effect or block-arrow bodies that build JSX) is not a native pattern. Task 7 adds the check: the expr reader's `Opaque`/`Block` printer already knows the lowered jsx runtime symbol (NameTable); when the printed subtree contains a call to it, set `why = "contains-jsx"` on the `Opaque` (or `captures_only = false` plus a `why`-style marker is NOT enough — the marker must be on the `Opaque`). Tier decision: any `Opaque { why: "contains-jsx" }` reachable from handlers/effects/state inits → `Tier::React` with `Diagnostic::info("jsx-outside-render", "<handler|effect> at line N builds JSX; the component renders as a React island", loc, "return data and render it in the component body")`. M1c therefore never prints a chunk containing generated `jsx_*` calls; it may `debug_assert!` on that.
2. **`component_id` from the file stem** (`input_<hash>`) is as specified in §5; fixtures keep it. No change.
3. **Handlers named `_hN` directly by the JSX reader** and `read_expr` taking a printer callback are accepted implementation details; this plan's `deps_of`/`to_js_in` consume the IR as merged, not the plan's earlier sketch.
4. **Imports read from `SImport` statements** (not `ast.named_imports`) is the correct source; Task 4's `client_imports` uses the NameTable, never `named_imports`.
5. **`window` / `node:fs` fixtures carry no diagnostic after M1b-1** — expected; Task 4 (server-only-in-client) and Task 7 (browser-global → client-only island) add them and their goldens change in this lane.

## Self-review notes

- **Spec coverage:** §3.2 rules 1 (browser → client-only; request-state → Error), 2 (server-only in client → Error), 3 (`client_props`), 4 (links / island-prop Error), 5 (list-key from M1b-1) → Tasks 1, 4, 5; §3.3 jobs with exact inputs → Task 3/5; §3.4 `cache()` → Task 6; §3.5 `needs_worker` → Task 7; §6.2 → Task 2; §6.4 per-item slots and seed order → Task 3; §7.4 link shape → Task 5; §8.1 classes and ordering → Task 7.
- **Deferred (ledger):** `package.json` `browser:false` detection; `'use client'`/`'use server'` leftover warning (trivial — add to Task 7 if time allows: scan the module's directive prologue, `Warning("next-directive-ignored")`); `useId` server support.
- **Type consistency:** `Deps`, `deps_of`, `try_server`, `Expr::Precomputed{slot, js, inputs, state_dependent, per_item}`, `JobDecl/JobKind`, `ChildLink{props_member, item_scoped, props}`, `ChildRef`, `ModuleCache`, `AnalyzeOptions`, `analyze_file` consistent across tasks.
- **Review Focus → tests:** 1 → Task 1; 2 → Task 4; 3 → Task 3; 4 → Task 5; 5 → Task 7.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1b2-placement-tier` | 1–7 | complex | Implementer (Complex) | `m1b1-ir-readers` merged | complex | all `cargo test --workspace --exclude bun_react_compiler` green with per-file counts (deps, server_expr, placement, to_js, captures, children, cache, fixtures); clippy/fmt clean; `brustc tests/fixtures/product-card/input.tsx --emit ir` and `--emit diag` outputs pasted; `brustc tests/fixtures/server-leak/input.tsx --emit diag` exits 1; PR -> v2 CI green; lane HEAD sha. |

Gate commands as in M1a.
