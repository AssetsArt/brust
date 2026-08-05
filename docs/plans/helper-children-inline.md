# Plan: inline JSX children passed to same-file helper components (static eval)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro, Lead) · authority: in-loop
implementer: assigned via conclave task `helper-children-inline`
escalation: design/spec conflicts → file `conclave task challenge` on this task; Detoro rules.

## Problem (external feature request, ket-doc workspace, 2026-08-05)

A same-file helper component that takes `children: React.ReactNode` and renders
`{children}` makes the whole native route fall back to React SSR with
`brust: warning — native component "X" was not inlined: unresolved identifier 'children'`.
Prop-passed components (`icon={Files}` → `const Icon = icon; <Icon/>`) inline fine;
JSX children do not. `<Card>text</Card>` is the most instinctive JSX shape there is,
so this silently degrades pages written by normal contributors.

Reproduction shape (from the reporter, mutation-isolated on a real build):

```tsx
function FeatureCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><h3>{title}</h3><p>{children}</p></div>
}
export default function Page() {
  return <FeatureCard title="Files">Some <strong>rich</strong> text</FeatureCard>
}
```

## Root cause (verified in this repo, main @ 9d9ae9a)

All in `crates/jsx-rust-compiler/src/static_eval.rs` (same-file helper expander;
entry `expand_inline_body_with_sources` :60, helper call inliner
`expand_helper_element_inner` :1212):

- Children ARE captured: :1249-1259 wraps `element.children` in a synthetic
  `Expr::JSXFragment` and inserts it as `attributes["children"]`. Note it is NOT
  passed through `expand_expr` like the other attributes (:1246 does that for them).
- `bind_helper_pattern` (:1292) binds it into `helper_env` (shorthand `{ children }`
  → `ObjectPatProp::Assign` branch :1310-1332, insert at :1331).
- But the binding is unreachable: the env is only read by (a) `eval_expr` :456,
  whose `Value` enum (:17) has NO JSX variant so a JSXFragment falls to the
  `_ => Ok(None)` catch-all :565, and (b) the tag-name substitution in
  `expand_jsx_element` :1093-1101 (that's why `icon={Files}` works —
  `Value::Symbol`). **`expand_expr` (:776) has no `Expr::Ident` substitution arm
  at all**, so `{children}` in the helper body survives as a bare `Ident`.
- The untouched `Ident("children")` then reaches the lowerer:
  - Outer component does NOT destructure `children` → `lower.rs:5374`
    `ErrorKind::UnresolvedIdent("children")` → fallback warning at
    `lower.rs:3374`. (The reported symptom.)
  - Outer component DOES destructure `children` (a layout) → the gate at
    `lower.rs:4745-4756` turns the helper's `{children}` into a
    `JsxNode::ChildrenSlot`, which `splice_children_slots` (`lower.rs:3429`)
    fills with the OUTER component's call-site children — **silent wrong
    output**, worse than the fallback. The fix closes this hole too; it needs a
    regression test.

## Decision (ruled by Detoro — do not re-litigate; challenge with evidence if wrong)

- Implement FULL JSX element children (elements, fragments, text, nested helper
  calls), not text-only: the substitution machinery is identical and text-only
  would need an extra validation loop for no savings.
- `children` used OUTSIDE child position (`title={children}`, `{children && x}`,
  `{children ? a : b}`) is NOT required to fold. If it doesn't fold it must fail
  CLOSED with the existing precise-warning path — ideally the reason names the
  construct (nice-to-have; `unresolved identifier` is acceptable if the ident-arm
  substitution makes the failure a later, still-precise lowering error). Never
  silently emit wrong output.
- `props.children` via a non-destructured param (`function Card(props)` …
  `{props.children}`) is OUT OF SCOPE (needs a `Value::Jsx` variant; separate
  task if demand appears).
- JSX default values (`{ children = <span/> }`) stay unsupported → existing
  `dynamic helper default` warning path (:1321-1327) is fine.

## Implementation (two edits, ~30-50 lines + tests)

1. `static_eval.rs` ~:1249-1259 — expand the captured children fragment in the
   CALLER's env before inserting into `attributes` (mirror what :1246 does for
   other attribute values): `self.expand_expr(&mut fragment_expr, env, depth + 1)?`.
   This resolves nested helpers/consts inside the children in the correct scope
   and avoids callee-env capture/shadowing bugs.
2. `static_eval.rs` `expand_expr` (:776) — add an early arm before the
   `eval_expr` attempt at :848: if the expression is an `Ident` bound in `env`
   and the bound expr is `JSXElement`/`JSXFragment`, replace the ident with a
   clone of the bound expr, set `self.changed = true`, count it via
   `add_expansion()` (:393) so the expansion budget stays honest, and return
   WITHOUT recursing (already expanded at capture).

Downstream already works: `expand_jsx_children` :1142-1155 splices JSX-valued
containers into the parent child list, `append_expr_children` :1658 flattens
fragments and drops `null`/`false`/`undefined`. Absent-children case already
works today (Value::Undefined → dropped) — don't regress it.

## Tests (extend, don't rewrite)

Rust (`cargo test -p jsx-rust-compiler`):
- `static_eval.rs` `mod tests` :1691 — nearest model:
  `expands_static_map_and_private_helper` :1898. Add: helper with element
  children, fragment children, nested helper-in-children, children absent
  (regression), children in non-child position → fails closed (no silent wrong
  output).
- `lower.rs` fallback/precision suite (:9920-:10060) — keep warnings precise.
- NEW regression for the mis-splice hole: helper receiving children INSIDE a
  layout/component that itself destructures `children`; assert the helper gets
  the call-site children, not the layout's (see `native_children_splice`
  :10252 and `native_layout_splices_children_into_shell` :8475 for the
  assertion style; `assert_no_children_slot` :10064 helps).

TS integration:
- Fixture `tests/fixtures/app/NativeStaticEval.tsx`: add
  `function PrivateCard({ title, children })` used with rich JSX children by the
  route `tests/fixtures/app/NativeInline.tsx`.
- `tests/native-inline.test.ts:118` — assert the new marker appears in emitted
  jinja AND no warning on stderr. Leave the `HookBadge` warning-format assert
  (:223) intact.

## Gates (all must be green before review)

1. `cargo test -p jsx-rust-compiler`
2. Rebuild the napi addon BEFORE running TS tests — stale gitignored
   `runtime/*.node` silently masks Rust changes (known trap). Use the repo's
   build script (check `package.json` scripts; typically `bun run build:rust`
   or similar — verify, don't guess).
3. `bun test tests/native-inline.test.ts` (run test files SEPARATELY — combined
   integration+cli-build runs have a known ~1/5 port-race flake).
4. `bun run ci` (biome; this is the TS gate — `tsc` is unusable here).
   Avoid `git add -A`.

Known pre-existing failure on main: `/native-islands` data-testid test — do not
chase it.

## Risk ledger

- Expansion budget: cloning children into every substitution site could explode
  on pathological inputs — the budget counter (`add_expansion`) must gate it.
- `{children}` appearing MULTIPLE times in a helper body: clone-per-site is
  correct for static eval, but check emitted island/slot numbering stays stable
  (anchored `{{ island_` renumbering is load-bearing elsewhere in the compiler).
- Don't touch the cross-file inline path (`lower.rs` ChildrenSlot machinery) —
  it already works and has its own tests; the fix lives in static_eval.
