# Native inline components (`<Comp native />`) — design

Date: 2026-05-31 · Status: approved (brainstorm) · Base: `28b26d7`

Feature A from the post-v0.1.9-alpha handoff. Deferred sibling of the shipped
SSR-component + ISR work (Feature B).

## Goal

Let a capitalized component opt into **compile-time inline expansion** with
`<Comp native />`. Instead of rendering through the JS-worker factory (the
default SSR-component path → `{{ comp_N_html | safe }}` slot), the compiler reads
the component's source, expands its returned JSX **at the call site** into the
route's Jinja template, substituting call-site props/children. No JS worker, no
per-request render — the fastest path for static/presentational components.

This crosses the napi floor zero extra times at request-time (see memory
`napi-crossing-floor`): an inlined component contributes pure Jinja, served by
the Rust render path with no per-component JS bridge.

## Non-goals

- **Not** a replacement for SSR components. Anything that can't inline falls back
  to the existing SSR-slot path. SSR components stay the default.
- **Not** client interactivity. `<Island>` remains the only hydration primitive.
  An inlined component may *contain* an `<Island>`, but `native` itself produces
  static markup.
- **Not** a general JS→Jinja transpiler. The supported expression/control-flow
  surface is bounded (below); anything outside it falls back to SSR.
- **No** runtime behavior change for routes that do not enter the native/Jinja
  compiler. Imported components inside a native route are attempted natively by
  default as described below.

## Surface API + semantics

### Annotation
- Imported components inside a native route are attempted automatically; the
  ordinary call site is `<Comp />`.
- `<Comp native />` remains supported for backward compatibility. The bare
  attribute is consumed by the lowerer and MUST NOT leak as a prop. It selects
  explicit mode, retaining the historical hard-cycle and `isr`-ignore semantics.
- Automatic attempts recurse through imported child components whose source is
  available. A failed imported-child attempt warns and falls back locally to its
  ordinary resolvable SSR slot; it does not discard a successfully inlined
  parent.
- **Private same-file helper exception (2026-07-17):** while expanding an
  imported component, an unexported top-level function declaration in that same
  source module may be inlined without its own `native` marker. Private-helper
  expansion is all-or-nothing under the containing imported component: an
  unsupported private helper never becomes an SSR slot (same-file locals cannot
  be resolved by the SSR factory import map), so the containing component
  soft-falls back instead. Full contract:
  `docs/superpowers/specs/2026-07-17-native-static-evaluation-design.md`.

### What inlines (ALL must hold)
1. **Source resolves** — the component's source file is reachable via the
   recursive `scanImports` walk and supplied to the compiler.
2. **Pure** — the function body contains no hook call (callee matching
   `/^use[A-Z]/`), no `await`, no `throw`, no `console.*`, and no other call
   that isn't a translatable expression (below).
3. **Every expression translates** to a minijinja equivalent (below).

### Fallback (warn + downgrade to SSR slot — NOT a hard error)
Triggered when ANY inline precondition fails:
- has a hook call,
- source unresolvable (npm dep, dynamic import, unresolved re-export),
- has a side effect / is not pure,
- contains an expression that cannot be translated to minijinja.

The component reverts to the existing SSR path (`{{ comp_N_html | safe }}` +
generated factory). Both automatic and explicit attempts emit a build warning
to **stderr** during `brust build`, naming the component and the reason.
Rationale (user decision):
"ไม่อยาก compile error และ dev ไม่งง" — a native attempt that cannot be honored
degrades gracefully rather than breaking the build.

### Hard error (NOT fallback)
- **Explicit circular inline**: `A native → B native → A native`. Preserve the
  historical compile error (`CircularInline`) naming the cycle.
- An all-implicit cycle warns and falls back locally to an SSR slot instead of
  turning previously valid recursive React composition into a build failure.

### `isr` interaction
- `native` + `isr` that **inlines** → `isr` is meaningless (static, no
  per-request render) → **warn + ignore `isr`**.
- `native` + `isr` that **falls back** to SSR → `isr` honored normally (Feature B
  path, unchanged).
- An automatic attempt on `<Comp isr={...} />` warns, skips inline, and preserves
  the existing SSR/ISR behavior. Automatic inlining must never silently discard
  cache semantics.

## High-level architecture

Inline is a **new lowering pass** that runs while lowering the route, BEFORE the
island/component numbering passes. Pipeline (in `lib.rs::compile_full`):

```
parse(route source)                       [existing]
  → lower(route)                           [existing, extended]
      ├─ lower_element hits imported <Comp> [branch in lower_ssr_component]
      │     → resolve Comp source from component_sources map
      │     → parse(Comp source) (SWC)     [reuse parser::parse]
      │     → inlinability check           [NEW: analyze.rs]
      │     → if inlinable: expand         [NEW: inline.rs]
      │         · lower Comp's returned JSX with a substitution scope
      │           {prop ident → call-site Expr/nodes, children → call-site nodes}
      │         · splice resulting JsxNodes in place of the SsrComponent
      │         · recurse for imported descendants (cycle-guarded)
      │     → else: emit SsrComponent (existing), push warning
  → number_islands / number_ssr_components [existing — sees inlined Islands]
  → collect_islands / collect_components    [existing]
  → emit_jinja / emit_factory               [existing, emit_jinja extended for {% if %}]
```

Because inline produces ordinary `JsxNode`s spliced into the route IR, the
existing island collection/numbering/hydration passes pick up any `<Island>`
inside an inlined component for free — inline just has to run first.

#### IR-walker impact (spec-review correction)
`JsxNode::Cond` is produced **only** by the inline expansion path (lowering a
`native` component body); it lives on the **route/Jinja side** and is NEVER a
child of an `SsrComponent` (so `emit_factory` never *emits* it). But it CAN
contain an `<Island>` or an (unannotated) SSR-slot component in its branches, so
every route-IR **walker** must recurse into both `consequent` and `alternate`:
- `number_islands`, `collect_islands` (`lib.rs`)
- `number_ssr_components`, `collect_components` (`lib.rs`)
- `collect_factories` (`emit_factory.rs`) — recurse to FIND nested SsrComponents;
  it does not emit the Cond itself.
- `emit_jinja::emit_node` — EMITS `Cond` as `{% if %}…{% else %}…{% endif %}`.

`JsxNode::ChildrenSlot` is a **transient** lowering placeholder: it is fully
substituted with the call-site children before `lower` returns, so it never
reaches numbering/collection/emit. All post-lower consumers (`emit_jinja`,
`emit_factory`, the walkers) add a defensive `unreachable!()` arm for it to keep
matches exhaustive and assert the invariant.

`JsxNode` currently derives only `Debug, Default` — **add `Clone`** so a
`ChildrenSlot` referenced multiple times in a component body can splice the
call-site subtree into each position.

### Expression translation surface
Inlined expressions are lowered to the route's existing `Expr` IR, extended to
cover the translatable set. Anything outside → inline fails → SSR fallback.

**Interpolation position (`{{ … }}`):**
- member paths (`x`, `x.y.z`) → existing `Expr::Field`/`MemberAccess` (already
  emitted)
- string/number literals → `Expr::StaticText`/`StaticNum`
- arithmetic (`+ - * / %`) → minijinja arithmetic
- template literals → minijinja `~` concatenation
- a bounded **method→filter** map: `.toUpperCase()`→`|upper`,
  `.toLowerCase()`→`|lower`, `.trim()`→`|trim`, `.length`→`|length`,
  `.slice(a,b)`→`|slice(...)`, `.join(s)`→`|join(s)`. (Final list pinned at
  plan-time; unmapped methods → fallback.)

**Conditional position (Model B — full Jinja lowering):**
- `cond && <X/>` → `{% if cond %}…{% endif %}`
- `cond ? <A/> : <B/>` → `{% if cond %}…{% else %}…{% endif %}`
- `if (cond) return <A/>; return <B/>;` (and `else`) → same
- test operands: member-path truthiness, comparison (`=== !== > < >= <=`,
  mapped to minijinja `== != > < >= <=`), logical (`&& || !`)
- JS→minijinja truthiness mapping pinned at plan-time. minijinja falsy:
  `none`, `false`, `0`, `""`, empty seq/map. JS falsy adds `undefined`/`NaN` —
  handled by treating an absent member path as `none` (minijinja-falsy). Strict
  equality maps to minijinja `==`/`!=` on the translated operands.

### Children
- `{children}` inside the component body → a new `JsxNode::ChildrenSlot`
  placeholder during the component's own lowering, filled at splice time with
  the **call-site lowered children** (which may themselves contain Islands or
  further `native` components).
- A component with no `{children}` reference but given children at the call site:
  children are dropped (matches React — unused children), no warning.

## CLI / API surface changes

### NAPI `compile_jsx` (`crates/brust/src/jsx_compile.rs`)
```rust
// before: compile_jsx(source: String, path: String) -> Result<NapiCompiledJsx>
// after:
compile_jsx(
  source: String,
  path: String,
  component_sources: Option<HashMap<String, String>>, // resolvedPath → source
) -> Result<NapiCompiledJsx>
```
`NapiCompiledJsx` gains `warnings: Vec<String>`. Existing callers passing no map
get `None` → behaves exactly as today (no inline attempted; every capitalized
tag is an SSR component or hard error as before).

Identifier→path resolution: the route source imports `Comp` from a specifier;
TS resolves that to an absolute path and the `component_sources` map is keyed by
that resolved path. The Rust lowerer needs ident→path; supplied via the same map
keyed additionally by the local import identifier as written in the route. (Exact
keying — by-ident vs by-path + an ident→path side map — pinned at plan-time;
see Open questions.)

### Rust core `compile_full` / `compile_with_path`
Gain an optional `component_sources: &ComponentSources` argument threaded to the
lowerer. Internal-only signature; default empty for existing test callers.

### TS build wiring (`runtime/islands/build.ts`, `runtime/cli/native-routes-emit.ts`)
- `scanImports` already returns `Map<string,string>` (import ident → resolved
  path). Extend the build to **recursively** gather sources: for each page, read
  the source of every imported component referenced with `native`, transitively,
  and read their file contents into the `component_sources` map passed to
  `compileJsx`.
- Build warnings returned in `warnings` are printed to stderr (one line each).

#### BLOCKER (spec-review): transitive imports for reconcile
`reconcileIslandManifest` and `emitComponentArtifacts` look up
`pageImports.get(entry.component)` and **throw** when a manifest entry has no
matching import in the page source (`native-routes-emit.ts:84-87`). An `<Island>`
(or an unannotated SSR-slot component) imported INSIDE an inlined component file
is not in the page route's `scanImports` → the build would throw. **Fix:** build
a merged import map = page imports ∪ transitive imports from every inlined
component file (the recursive source walk already visits these files), and pass
the merged map to `reconcileIslandManifest` / `emitComponentArtifacts`. On an
ident collision across files, the page's own import wins; if two inlined files
import different paths under the same ident, that is a `CircularInline`-adjacent
ambiguity — error with a clear message.

## File structure

New Rust files in `crates/jsx-rust-compiler/src/`:
- `analyze.rs` — inlinability analysis: hook scan, purity scan, expression
  translatability check over a parsed component body. Pure functions over SWC
  AST + the route's `Expr` translator. Returns `Inlinable | Fallback(reason)`.
- `inline.rs` — the expansion: given a parsed component, a substitution scope
  (prop ident → call-site value, `children` → nodes), and a cycle set, produce
  `Vec<JsxNode>`. Recurses for imported descendants.

Extended Rust files:
- `ir.rs` — add `JsxNode::ChildrenSlot`; extend `Expr` (arithmetic, template
  concat, method-filter, comparison, logical, unary-not) OR a sibling `CondExpr`
  type for test positions (pinned at plan-time). Add `JsxNode::Cond { test,
  consequent, alternate: Option<Box<JsxNode>> }`.
- `emit_jinja.rs` — emit `JsxNode::Cond` as `{% if %}…{% else %}…{% endif %}`;
  extend `emit_expr_path` for the new `Expr` variants.
- `lower.rs` — `lower_ssr_component` gains the `native` branch; new helpers for
  parsing the `native` bare attr and driving inline.
- `lib.rs` — thread `component_sources`; collect warnings; new `CircularInline`
  error kind; teach `number_islands`/`collect_islands`/`number_ssr_components`/
  `collect_components` to recurse into `JsxNode::Cond` branches (an Island or
  SSR-slot component can live in a conditional branch of an inlined component).
  `ComponentMeta` shape unchanged.
- `emit_factory.rs` — `collect_factories` recurses into `Cond` branches to find
  nested SsrComponents; `emit_child` gains a defensive `unreachable!()` arm for
  `Cond`/`ChildrenSlot` (neither is a factory child).

Extended TS:
- `runtime/islands/build.ts`, `runtime/cli/native-routes-emit.ts` — recursive
  source gathering + pass `componentSources` + print `warnings`.
- `runtime/index.d.ts` — `compileJsx` signature + `warnings` field.

## Behavior invariants

- A route with no `native` attr compiles byte-identically to today (golden
  fixtures must not move).
- Inline runs before numbering ⇒ an `<Island>` inside an inlined component is
  numbered/collected/hydrated exactly as a top-level island.
- `native` never appears as a prop in factory output or as an HTML attribute.
- Fallback is warn-only; a fallen-back component is indistinguishable at runtime
  from a plain SSR component (same `{{ comp_N_html | safe }}` + factory).
- Circular inline is the ONLY hard error new to this feature.
- Inlined output escapes text/attributes identically to host-element lowering
  (reuse `emit_jinja` escaping — no new escape path).

## Tests

Run files SEPARATELY (memory `bun-mock-module-leaks-suite`,
`native-island-integration-flake`); rebuild addon after Rust changes
(`cd runtime && bun run build`).

**Rust unit (`crates/jsx-rust-compiler`):**
- `analyze`: pure props→JSX → Inlinable; hook call → Fallback(hook); `await`/
  `throw`/`console` → Fallback(side-effect); untranslatable expr → Fallback(expr).
- `inline`: prop substitution (member path, literal); `{children}` splice;
  nested `native` recursion; arithmetic/template-literal/method-filter
  translation; `&&`/ternary/if-else → `Cond`.
- `emit_jinja`: `Cond` → `{% if %}{% else %}{% endif %}` golden; new `Expr`
  variants render correctly.
- `lib`: circular inline → `CircularInline` error; warnings collected for each
  fallback reason; `native` not in props.
- **Regression**: every existing golden fixture + island/component test passes
  unchanged.

**TS unit:** `compileJsx` accepts `componentSources` + returns `warnings`;
recursive `scanImports` gathering resolves transitive component sources.

**Integration (`tests/native-island-ssr.test.ts` harness — `brust build` +
cwd=FIXTURE_DIR):**
- native route with an inlinable imported `<Layout>` → output contains the
  expanded markup, NO `comp_N_html` slot, NO factory entry for it.
- imported `<Comp>` with a hook → falls back: warning on stderr + `comp_N_html`
  slot present (renders correctly).
- inlined component containing `<Island>` → island still hydrates.
- conditional on a dynamic prop → correct `{% if %}` output renders both
  branches per data.

## Acceptance criteria

- An imported pure presentational `<Comp/>` inlines to Jinja with no
  factory entry and no request-time JS bridge; output renders identically to the
  SSR version for the same data.
- All four fallback reasons degrade to SSR with a stderr warning, not a build
  failure.
- An explicit circular inline fails the build with a clear cycle message;
  an all-implicit cycle warns and SSR-fallbacks locally.
- Inlined `<Island>` hydrates.
- Full baselines green (`cargo test --workspace`, `bun test runtime/`, each
  `tests/*.test.ts` separately, `cargo fmt --check`,
  `cargo clippy --workspace --all-targets --locked -D warnings`, `bun run ci`).
- Routes outside the native/Jinja compiler remain byte-identical.

## Known limitations (v1)

- Method→filter map is a fixed allowlist; unmapped methods fall back (not an
  error, just SSR).
- Default param values, rest props (`{...rest}`), and computed prop keys: pinned
  at plan-time — if not in v1, they fall back.
- No partial inline: a component is fully inlined or fully SSR; we don't inline
  the static parts and SSR the dynamic parts of one component.

## Open questions resolved at plan-time

1. `component_sources` map keying: by local ident, by resolved path, or both
   (ident→path side map). Decide when wiring `scanImports`.
2. Exact method→filter allowlist.
3. `Expr` extension vs a separate `CondExpr` for test-position operators.
4. Default param / rest-prop / spread-at-call-site support in v1 (else fallback).
5. JS→minijinja truthiness edge mapping (absent path = `none`; `NaN`).
