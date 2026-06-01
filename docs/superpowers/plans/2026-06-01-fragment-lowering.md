# Implementation plan — Fragment lowering for native routes

Spec: `docs/superpowers/specs/2026-06-01-fragment-lowering-design.md`
Parent commit: `d627086` · Crate: `crates/jsx-rust-compiler`

Two tasks. Task 1 is atomic by necessity: adding the `JsxNode::Fragment` variant
breaks every exhaustive `match` in the crate, so all arms must land together to
compile. Task 2 adds golden fixtures + rebuilds the addon for integration.

Verification commands (run from repo root unless noted):
- `cargo test -p jsx-rust-compiler` — unit + golden
- `cargo fmt -p jsx-rust-compiler` then `cargo fmt --check`
- `cargo clippy -p jsx-rust-compiler --all-targets --locked -- -D warnings`
- `cd runtime && bun run build` — rebuild napi addon (~45s); regenerates `index.d.ts`
- `bun test tests/jinja-route.test.ts` (run native-route TS tests SEPARATELY — mock.module leak / port race)

---

## Task 1 — Rust: full jinja fragment support + reject fragment-as-SSR-child

ESCALATE if: the exhaustiveness checker surfaces a `JsxNode` match site NOT listed
below (report it — the spec's enumeration would be incomplete), or any non-goal
test unexpectedly passes/panics instead of erroring.

### Step 1.1 (RED→GREEN) — IR variant

`crates/jsx-rust-compiler/src/ir.rs`: add to `enum JsxNode`, after `ChildrenSlot`:

```rust
    /// JSX fragment (`<>…</>`). Emits its children concatenated with NO wrapping
    /// element — a pure grouping node. Children are lowered through the same
    /// `lower_child` path as host-element children, so islands / SSR components /
    /// Cond / Map / nested fragments are all valid inside one. A fragment as a
    /// DIRECT child of an SSR component is rejected at lower time
    /// (`FragmentInSsrComponentNotSupported`); see `lower_ssr_component`.
    Fragment { children: Vec<JsxNode> },
```

Add a clone/construct test in `ir.rs`'s `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn fragment_node_clones() {
        let original = JsxNode::Fragment {
            children: vec![JsxNode::Text("a".into()), JsxNode::Text("b".into())],
        };
        let cloned = original.clone();
        assert_eq!(format!("{:?}", original), format!("{:?}", cloned));
    }
```

### Step 1.2 — New ErrorKind

`crates/jsx-rust-compiler/src/lib.rs`: add to `enum ErrorKind` (near
`SpreadChildNotSupported`):

```rust
    #[error("fragment `<>…</>` as a direct child of an SSR component not supported — wrap it in an element")]
    FragmentInSsrComponentNotSupported,
```

### Step 1.3 — Lowering: `lower_fragment` + route the 4 reject sites

`crates/jsx-rust-compiler/src/lower.rs`:

1. Add `JSXFragment` to the `swc_core::ecma::ast::{…}` import list (line ~10).
2. Add the helper (place near `lower_element`):

```rust
/// Lower a `<>…</>` fragment by lowering each child through `lower_child`
/// (whitespace-only JSXText and empty `{}` containers are dropped, exactly as for
/// host-element children). `in_map` flows through unchanged.
fn lower_fragment(
    frag: &swc_core::ecma::ast::JSXFragment,
    scope: &Scope,
    in_map: bool,
) -> Result<JsxNode, LowerError> {
    let mut children = Vec::new();
    for child in &frag.children {
        if let Some(node) = lower_child(child, scope, in_map)? {
            children.push(node);
        }
    }
    Ok(JsxNode::Fragment { children })
}
```

3. Replace the 3 root-level `FragmentNotSupported` returns:
   - `lower` (~113): `SwcExpr::JSXFragment(f) => return lower_fragment(f, &scope, false),`
     — but note this arm currently binds `element` then runs BrustPage detection +
     `lower_element`. Restructure: lower the fragment directly into `root`,
     bypassing the `element`/BrustPage branch. Concretely, change the `let element
     = match jsx {…}` + `let root = if BrustPage …` block so a `JSXFragment`
     produces `root` directly:

```rust
    let root = match jsx {
        SwcExpr::JSXElement(element) => {
            if let JSXElementName::Ident(ident) = &element.opening.name
                && ident.sym.as_ref() == "BrustPage"
            {
                lower_brust_page(element, &scope)?
            } else {
                lower_element(element, &scope, false)?
            }
        }
        SwcExpr::JSXFragment(f) => lower_fragment(f, &scope, false)?,
        _ => return Err(LowerError::at(jsx.span(), ErrorKind::BodyMustBeSingleReturn)),
    };
```

   - `lower_with_sources` (~181): apply the identical restructure.
   - `lower_component_inline` (~251): replace the `JSXFragment` reject with
     `SwcExpr::JSXFragment(f) => return Ok(vec![lower_fragment(f, &scope, false)?]),`
     (keep the rest of the single-return match; `try_lower_if_return_body` and
     `extract_return_jsx_from_stmt` are deliberately NOT changed — Non-goal #5).

4. `lower_child` JSXFragment arm (~1830): replace with
   `JSXElementChild::JSXFragment(f) => Ok(Some(lower_fragment(f, scope, in_map)?)),`

### Step 1.4 — Reject fragment as direct SSR-component child

`lower.rs`, in `lower_ssr_component`'s child loop (~700-704):

```rust
    let mut call_site_children: Vec<JsxNode> = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child(child, scope, in_map)? {
            if matches!(node, JsxNode::Fragment { .. }) {
                return Err(LowerError::at(
                    el.opening.span,
                    ErrorKind::FragmentInSsrComponentNotSupported,
                ));
            }
            call_site_children.push(node);
        }
    }
```

### Step 1.5 — Walker arms (compiler-enforced; add each, recurse children)

`lower.rs`:
- `splice_children_slots` — add a `Fragment { children }` arm using the SAME
  `while i < children.len()` in-place splice loop as the `Element` arm (NOT a
  plain per-child recurse — see spec):

```rust
        JsxNode::Fragment { children } => {
            let mut i = 0;
            while i < children.len() {
                if matches!(children[i], JsxNode::ChildrenSlot) {
                    children.remove(i);
                    for (j, c) in slot_children.iter().enumerate() {
                        children.insert(i + j, c.clone());
                    }
                    i += slot_children.len();
                } else {
                    splice_children_slots(&mut children[i], slot_children);
                    i += 1;
                }
            }
        }
```
  (use the actual parameter name for the call-site children — it is `children` in
  the signature; rename the local `children` binding above to avoid shadowing, or
  match as `Fragment { children: frag_children }`.)

- `infer_props_types` — `Fragment { children } => { for c in children { infer_props_types(c, props)?; } Ok(()) }`
- `collect_map_member_fields` — `Fragment { children } => { for c in children { collect_map_member_fields(c, binding, fields); } }`

`lib.rs`:
- `number_islands` — recurse: `Fragment { children } => for c in children { number_islands(c, counter); }`
- `collect_islands` — recurse into children
- `number_ssr_components` — recurse into children
- `collect_components` — recurse into children

`emit_factory.rs`:
- `collect_factories` — recurse: `Fragment { children } => for c in children { collect_factories(c, out); }`
- `emit_child` — `JsxNode::Fragment { .. } => unreachable!("fragment rejected as SSR-component child in lower_ssr_component"),`

### Step 1.6 — Emit (jinja)

`emit_jinja.rs`, in `emit_node`:

```rust
        JsxNode::Fragment { children } => {
            for c in children {
                emit_node(c, out);
            }
        }
```

### Step 1.7 — Tests (replace the stale reject test; add positive + non-goal)

`lower.rs` `mod tests`:
- REPLACE `rejects_fragment` (~2883) with `root_fragment_lowers`: root
  `<><a/><b/></>` → `lower(...)` Ok, `root` is `JsxNode::Fragment` with 2 Element
  children.
- `fragment_child_of_element`: `<ul><><li/><li/></></ul>` → `ul`'s single child is
  a `Fragment` holding two `li` Elements.
- `fragment_drops_whitespace`: `<>  <a/>  </>` → Fragment with exactly 1 child.
- `fragment_map_body_still_rejected`: `xs.map(x => <></>)` → `MapShapeNotSupported`.
- `brust_page_in_fragment_rejected`: `<><BrustPage/></>` → `BrustPageMustBeRoot`.
- `fragment_in_ssr_component_rejected`: `<Layout><>a</></Layout>` →
  `FragmentInSsrComponentNotSupported`.
- inline: reuse the existing `inline_lower` helper — a component body
  `<>{children}</>` lowered via `lower_component_inline` yields `[Fragment{[…]}]`
  and a ChildrenSlot inside is spliced (assert via `splice_children_slots`).

`emit_jinja.rs` `mod tests`:
- `emits_fragment_children_no_wrapper`: `Fragment{[Text("a"),Text("b")]}` → `"ab"`.
- `emits_fragment_with_expr`: `Fragment{[Expr(Field("t"))]}` → `"{{ t }}"`.

`lib.rs` `mod tests`:
- `islands_in_fragment_numbered`: a root fragment containing two Islands → both
  numbered in source order and present in `collect_islands` output.

`emit_factory.rs` `mod tests`:
- `factory_descends_through_fragment`: root `<><Layout/></>` (Layout = SSR comp) →
  `emit(&component)` produces one `FactoryOutput` referencing `Layout`.

### Step 1.8 — Verify

```
cargo test -p jsx-rust-compiler
cargo fmt -p jsx-rust-compiler && cargo fmt --check
cargo clippy -p jsx-rust-compiler --all-targets --locked -- -D warnings
```
All green/clean. Commit: `feat(jsx-compiler): lower JSX fragments on native routes`.

BLOCKED fallback: if the `splice_children_slots` parameter naming causes churn,
match as `Fragment { children: frag_children }` and operate on `frag_children`.

---

## Task 2 — Golden fixtures + addon rebuild + integration

Depends on Task 1 committed.

### Step 2.1 — Emit golden fixture

`crates/jsx-rust-compiler/fixtures/fragment_basic.tsx`:

```tsx
export default function FragmentBasic() {
  return (
    <div>
      <>
        <h1>One</h1>
        <p>Two</p>
      </>
    </div>
  )
}
```

Register in `crates/jsx-rust-compiler/tests/golden_emit_jinja.rs` `FIXTURES`
const: add `"fragment_basic"`. Generate the golden:

```
cd crates/jsx-rust-compiler && UPDATE_GOLDEN=1 cargo test --test golden_emit_jinja
```

Then INSPECT the generated `fixtures/fragment_basic.expected.jinja` — it MUST be
`<div><h1>One</h1><p>Two</p></div>` (no wrapper around the fragment children).
If it differs, Task 1's emit is wrong — fix before committing the golden.

### Step 2.2 — Render golden (optional but preferred)

If `golden_render_jinja/main.rs` is the right home, add a `#[test] fn
renders_fragment_basic()` mirroring the existing per-fixture tests, asserting the
rendered HTML for `fragment_basic` (create `fragment_basic.expected.html`). Use
the same render harness the sibling tests use. If the harness needs props/context
the fixture doesn't supply, keep this step to the emit golden only and note it.

### Step 2.3 — Rebuild addon + integration

```
cd runtime && bun run build      # ~45s; regenerates index.d.ts (do NOT hand-edit)
```
Then add a native-route integration assertion. Smallest viable: extend
`tests/jinja-route.test.ts` (or add a focused `tests/fragment-route.test.ts`)
with a route whose page returns a root fragment, asserting the served/compiled
HTML contains the children with NO injected wrapper element. Run it ISOLATED:

```
bun test tests/jinja-route.test.ts
```

### Step 2.4 — Verify + commit

Re-run `cargo test -p jsx-rust-compiler` (goldens included) and the isolated TS
test. Commit: `test(jsx-compiler): golden + integration fixtures for fragments`.

---

## Spec coverage map

| Spec section | Task.Step |
|---|---|
| New IR node | 1.1 |
| `lower_fragment` + 4 sites | 1.3 |
| Reject fragment-as-SSR-child + ErrorKind | 1.2, 1.4 |
| Emit jinja | 1.6 |
| Factory arms (recurse + unreachable) | 1.5 |
| Walkers (lib.rs ×4, lower.rs ×3) | 1.5 |
| analyze.rs unaffected | (no change) |
| Tests 1–9 | 1.7, 2.1–2.3 |
| Acceptance: cargo test/fmt/clippy | 1.8, 2.4 |
| Acceptance: addon rebuild | 2.3 |
| Non-goals (map / cond branch / BrustPage / conditional-inline / SSR-child) | 1.3 (untouched helpers), 1.7 reject tests |
