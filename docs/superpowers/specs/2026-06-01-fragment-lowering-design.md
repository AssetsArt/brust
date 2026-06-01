# Fragment lowering for native routes — design

Date: 2026-06-01 · Crate: `crates/jsx-rust-compiler` · Status: spec

## Goal

Make the JSX→minijinja compiler accept JSX fragments (`<>…</>`) on native
(jinja) routes. Today every fragment — at the route root, as a child, or returned
by an inlinable component — is rejected with `ErrorKind::FragmentNotSupported`.
After this change, a fragment lowers to a new IR node that emits its children
concatenated, with **no wrapper element** (matching React's `<>…</>` /
`React.Fragment` semantics).

Concretely, all of these must compile and render on a native route:

```tsx
// 1. Root fragment (a "bare-fragment page" — partial / HTMX-style route)
export default function Row({ a, b }: { a: string; b: string }) {
  return <><td>{a}</td><td>{b}</td></>;
}

// 2. Fragment as a child of a host element
export default function C({ x }: { x: string }) {
  return <ul><><li>one</li><li>{x}</li></></ul>;
}

// 3. Inlinable component whose body is a fragment, expanded via `<Comp native/>`
//    (composes with the native-inline feature shipped in 0.1.10-alpha)
```

## Non-goals (explicit — these stay rejected)

The fragment work is deliberately bounded to the positions reachable through the
**generic** `lower_child` path and the route root. The following remain
**unsupported and must keep producing a clear compile error** (not a panic, not
silently-wrong output):

1. **Fragment as a `.map(...)` arrow body** — `xs.map(x => <>…</>)`. The map
   arrow-body extractor (`arrow_jsx_body`) returns `&JSXElement` by contract;
   widening it is a separate change. Keeps producing `MapShapeNotSupported`.
2. **Fragment as a ternary / `&&` branch** — `{cond ? <>…</> : <b/>}` or
   `{cond && <>…</>}`. The inline-mode `Cond` recognizers in `lower_child`
   pattern-match `SwcExpr::JSXElement` specifically; a fragment branch there
   falls through to the generic `Expr` path and then errors. Out of scope.
3. **Keyed fragments** — `<React.Fragment key={…}>`. Native routes are static
   templates; fragment keys are meaningless here. The long-form
   `<React.Fragment>` tag is a member-expression element name and already
   rejected by `lower_element_name` (`MemberComponentNotSupported`); only the
   shorthand `<>…</>` is in scope.
4. **`<BrustPage>` inside a fragment** — `<><BrustPage>…</BrustPage></>`.
   `<BrustPage>` is recognized ONLY as the sole route root (in `lower` /
   `lower_with_sources`, before `lower_element`). Inside a fragment it reaches
   `lower_element` and is rejected with `BrustPageMustBeRoot`. Unchanged — a
   fragment root and `<BrustPage>` are mutually exclusive by construction.
5. **Fragment returned from a *conditional* branch of an inlinable component** —
   `if (cond) return <X/>; return <>…</>;` inside a `<Comp native/>` body. The
   two-statement inline path (`try_lower_if_return_body` /
   `extract_return_jsx_from_stmt`) pattern-matches `SwcExpr::JSXElement` for each
   branch; a fragment branch is not recognized, so the body fails the
   two-statement shape and the component **softly falls back to the SSR
   (JS-worker) path** — same soft-fallback behavior as an untranslatable inline
   body today (no hard error, no panic). These two helpers are deliberately NOT
   widened in this change. Only the *single-return* inline body
   (`return <>…</>;`, site 3 below) gains fragment support.

## High-level architecture

Add one IR variant and thread it through every existing `JsxNode` consumer. The
crate's walkers are all **exhaustive matches with no `_ =>` catch-all**, so the
Rust compiler enumerates every site that must handle the new variant — that
exhaustiveness is the safety mechanism this design leans on.

### New IR node (`ir.rs`)

```rust
/// JSX fragment (`<>…</>`). Emits its children concatenated with NO wrapping
/// element. The framework owns no markup here — a fragment is a pure grouping
/// node. Children are lowered through the same `lower_child` path as any host
/// element's children, so islands / SSR components / Cond / Map / nested
/// fragments are all valid inside one.
Fragment {
    children: Vec<JsxNode>,
},
```

`children` is `Vec<JsxNode>` — identical shape to `Element.children`,
`Document.body`, and `SsrComponent.children`, so it composes with every existing
walker pattern.

### Lowering (`lower.rs`)

Add one helper:

```rust
/// Lower a `<>…</>` fragment by lowering each child through `lower_child`
/// (whitespace-only JSXText and empty `{}` containers are dropped exactly as for
/// host-element children). `in_map` flows through unchanged.
fn lower_fragment(frag: &JSXFragment, scope: &Scope, in_map: bool)
    -> Result<JsxNode, LowerError>
```

Then route the **four** current `FragmentNotSupported` sites to it:

| Site | File:line (current) | New behavior |
|---|---|---|
| Route root (`lower`) | `lower.rs:113` | `lower_fragment(f, &scope, false)` |
| Route root (`lower_with_sources`) | `lower.rs:181` | `lower_fragment(f, &scope, false)` |
| Inline component root (`lower_component_inline`) | `lower.rs:251` | `vec![lower_fragment(f, &scope, false)?]` |
| Child position (`lower_child`) | `lower.rs:1830` | `Ok(Some(lower_fragment(f, scope, in_map)?))` |

`JSXFragment` must be added to the `swc_core::ecma::ast` import list in `lower.rs`.

### Emit — jinja (`emit_jinja.rs`)

```rust
JsxNode::Fragment { children } => {
    for c in children {
        emit_node(c, out);
    }
}
```

No wrapper bytes — just the concatenated children. A root fragment therefore
emits a "bare-fragment page" (no `<html>` shell), which the TS reconcile step in
`runtime/cli/native-routes-emit.ts` already handles (it appends the islands
bootstrap for non-shell pages — see its line ~94 comment).

### Emit — factory (`emit_factory.rs`) — fragment-as-SSR-child REJECTED in v1

A fragment could reach the factory path only as a direct child of an SSR
component (`<Layout><>…</></Layout>`), because `lower_ssr_component` lowers its
children through the shared `lower_child` (`lower.rs:700–704`). Supporting it
there would require emitting `h(Fragment, null, …)` and plumbing a per-factory
`uses_fragment` flag (`FactoryOutput` → `ComponentMeta` → compile JSON →
`native-routes-emit.ts` import line, lint-safe so `Fragment` is imported only
when used). That is real surface for a **secondary, JS-bridged** case.

**Decision: reject it in v1.** The jinja path is the goal; the factory path is a
deferred follow-up. Concretely:

- New `ErrorKind::FragmentInSsrComponentNotSupported` (`lib.rs`).
- In `lower_ssr_component`'s child loop, after lowering each child via
  `lower_child`, reject if the child's **subtree contains a fragment anywhere**
  (`subtree_contains_fragment`), not just a direct fragment child. The factory
  emitter walks the whole child subtree, so a fragment nested inside a host
  element (`<Layout><div><>x</></div></Layout>`) would otherwise reach
  `emit_child` and panic. This needs NO SSR-context flag on `lower_child` — the
  generic path stays fragment-friendly for the jinja side; only the
  SSR-component child subtree rejects.
- Because of that rejection, an `SsrComponent.children` vec never contains a
  `Fragment` at runtime. The two factory match sites still need compile-time
  arms (exhaustiveness):
  - `collect_factories` — **recurse** into `Fragment.children` (a fragment is
    reachable elsewhere in the tree — e.g. a root fragment or a fragment nested
    in a host element wrapping an SSR component — so this walk must descend to
    find those SSR components).
  - `emit_child` — `JsxNode::Fragment { .. } => unreachable!("fragment rejected
    as SSR-component child in lower_ssr_component")` (genuinely unreachable, like
    the existing `Cond`/`ChildrenSlot` arms).

No TS, JSON, or `FactoryOutput`/`ComponentMeta` changes. `native-routes-emit.ts`
is untouched.

> Deferred follow-up: full `h(Fragment, …)` factory support via the
> `uses_fragment` plumbing described above, to allow fragments as SSR-component
> children.

### Walkers (`lib.rs`, `lower.rs`)

Add a recursing `Fragment { children }` arm to each (all iterate children in
source order, preserving island/SSR-component numbering):

- `lib.rs::number_islands` — recurse
- `lib.rs::collect_islands` — recurse
- `lib.rs::number_ssr_components` — recurse
- `lib.rs::collect_components` — recurse
- `lower.rs::splice_children_slots` — the `Fragment` arm must use the **same
  `while i < children.len()` in-place splice loop** that the `Element.children`
  and `Document.body` arms use (remove each `ChildrenSlot` entry and insert the
  call-site children at that index; recurse into non-slot children). A plain
  per-child recursive call is INSUFFICIENT — it would leave a top-level
  `{children}` inside the fragment un-expanded. This matters because an inlinable
  component returning `<>{children}</>` is a natural shape.
- `lower.rs::infer_props_types` — recurse
- `lower.rs::collect_map_member_fields` — recurse

`analyze.rs` operates on the SWC AST (`BlockStmt`), not on `JsxNode`, so it is
unaffected.

### JSX attribute type augmentation

None. Fragments introduce no new pseudo-prop; the React 19 JSX attribute
augmentation (`isr`, `native`) is untouched.

## Data flow

```
<>…</>  (SwcExpr::JSXFragment / JSXElementChild::JSXFragment)
   │  lower_fragment → lower_child per child
   ▼
JsxNode::Fragment { children }
   │  number_islands / number_ssr_components  (assign instance indices)
   │  collect_islands / collect_components    (manifest entries)
   │  splice_children_slots                   (inline expansion only)
   ▼
emit_jinja::emit_node  → children concatenated, no wrapper   (template path)
(fragment as a DIRECT SSR-component child → rejected in lower_ssr_component)
```

## Tests

Rust unit tests live in-module (`#[cfg(test)] mod tests`) in `lower.rs`,
`emit_jinja.rs`, `lib.rs`, `emit_factory.rs`. The existing
`lower.rs::rejects_fragment` test (asserts `FragmentNotSupported` on a root
fragment) is now WRONG and must be **replaced** with a positive test.

Required new/changed tests:

1. **`lower.rs`** — root `<><a/><b/></>` lowers to `JsxNode::Fragment` with two
   `Element` children (replaces `rejects_fragment`).
2. **`lower.rs`** — fragment as a child: `<ul><><li/><li/></></ul>` → `ul`'s
   single child is a `Fragment` holding two `li`.
3. **`lower.rs`** — whitespace-only text inside a fragment is dropped (same
   normalization as host children).
4. **`lower.rs`** — fragment still rejects the documented non-goals: assert
   `xs.map(x => <></>)` → `MapShapeNotSupported`; assert `<BrustPage/>` inside a
   fragment → `BrustPageMustBeRoot`.
5. **`lower.rs`** — inline expansion: an inlinable component whose body is a
   fragment, expanded via the `lower_component_inline` path, yields a `Fragment`
   node; a `{children}` slot inside that fragment splices call-site children.
6. **`emit_jinja.rs`** — `Fragment { children: [Text("a"), Text("b")] }` emits
   exactly `ab` (no wrapper); a fragment containing an `Expr` emits `{{ … }}`.
7. **`lib.rs`** — islands inside a fragment are numbered in source order and
   appear in `collect_islands` output (fragment is transparent to numbering).
8. **`lower.rs`** — a fragment as a direct child of an SSR component
   (`<Layout><>…</></Layout>`) is rejected with
   `FragmentInSsrComponentNotSupported`.
9. **`emit_factory.rs`** — `collect_factories` descends through a `Fragment`
   wrapping an `SsrComponent` (e.g. root `<><Layout/></>`) and still produces the
   `Layout` factory entry (proves the recurse arm works).

Integration / golden: add a native-route fixture exercising a root fragment and
a nested fragment, asserting the rendered HTML has no spurious wrapper. Run the
existing crate suite + the runtime native-route tests.

## Acceptance criteria

- `cargo test -p jsx-rust-compiler` green, including the replaced fragment tests.
- `cargo fmt --check` and `cargo clippy --all-targets --locked -D warnings` clean
  (the CI gate — see memory `release-mirror-ci-gates`).
- A native route returning `<>…</>` renders its children with no wrapper element.
- A fragment nested in a host element renders inline.
- The four documented non-goals still produce clear compile errors (no panic).
- Addon rebuilt (`cd runtime && bun run build`) so TS/integration see the change;
  `index.d.ts` regenerates via napi (not hand-edited).

## Known limitations (shipped)

- `.map(x => <>…</>)`, fragment ternary/`&&` branches, and keyed fragments remain
  unsupported (see Non-goals). These are natural follow-ups but out of scope here.
- A fragment anywhere inside an SSR component's subtree
  (`<Layout><>…</></Layout>` or `<Layout><div><>…</></div></Layout>`) is rejected
  with `FragmentInSsrComponentNotSupported`; full `h(Fragment, …)` factory support
  is a deferred follow-up.

## Open questions resolved at plan time

- **Flatten at lower-time vs. dedicated IR node?** → Dedicated `Fragment` node.
  Flattening can't represent a root fragment (`Component.root` is a single
  `JsxNode`) and would complicate `ChildrenSlot` splicing; the dedicated node
  produces byte-identical emit output and keeps every walker uniform.
- **Does keeping the Fragment node (vs flattening) change island numbering?** →
  No. Walkers recurse into `Fragment.children` in source order, identical to
  flattening.
