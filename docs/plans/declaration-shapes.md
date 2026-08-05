# Plan: recognize ordinary React declaration shapes in the native inliner

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro, Lead) · authority: in-loop
implementer: assigned via conclave task `declaration-shapes`
escalation: design/spec conflicts → `conclave task challenge`; Detoro rules.
integration order: `form-action-guard` merges FIRST; this lane rebases on the
merged main before READY (shared files: lower.rs, lib.rs,
scripts/react-coverage.ts, docs/react-coverage.md — report conflicts are
resolved by REGENERATION on the rebased tree, never by hand).

## Problem (docs/react-coverage.md category B/D; verified pointers @ 9333940)

The inliner recognizes exactly ONE component shape: `export default function
Name(){}` (`find_default_export`, crates/jsx-rust-compiler/src/lower.rs:1261,
match at :1266-1268). Arrow components, `function X(){}; export default X`,
`export default memo(fn)` all fall back to React SSR — and the warning says
"parse error" (hardcoded at lower.rs:3310 and :3320), which is misleading: the
file parses fine. Same-file ARROW helpers (`const Badge = () => …`) are never
found as helpers (static_eval.rs:322-324 collects only `Decl::Fn`), warning
"source unresolved". Arrow components are half of real-world React.

## Ruled scope (challenge with evidence to change)

IN (this lane):
- S1 `find_default_export` widening: `export default (…) => …`,
  `export default function` (unchanged), `function X(){}; export default X`
  (ident resolved against module-level fn/const decls),
  `export default memo(fn|arrow)` incl. `React.memo`, nested unwrap loop over
  the allowlist {memo, forwardRef, React.memo, React.forwardRef} — BUT
  forwardRef only UNWRAPS for recognition; see OUT for its semantics.
- S2 honest warnings: lower.rs:3310/:3320 must say what was actually wrong,
  e.g. `no recognizable component declaration (expected a default-exported
  function or arrow component)` / `component function has no body` — keep
  :3298 as the true parse-error case.
- S3 same-file arrow helpers: register module-level `const X = <arrow|fnexpr>`
  as helpers in static_eval (the inits are ALREADY captured at
  static_eval.rs:311-319/:298-310 — they are just never consulted as helpers,
  only as values; guard against double-counting).

OUT (follow-up tasks, do not attempt):
- Named-export components (`export function X` + `import { X as Y }`): alias
  correctness needs import-specifier plumbing into InlineEnv / compileJsx
  (runtime/cli/native-routes-emit.ts keys sources by LOCAL ident, :62-64).
- forwardRef SEMANTICS (2-param `(props, ref)` and `ref={ref}` in the body):
  `lower_params` (lower.rs:1336-1341) rejects 2 params and
  RefAttributeNotSupported (lower.rs:4348-4353) rejects the attr. A
  memo/forwardRef-wrapped SINGLE-param component that never uses ref may
  inline via S1; a real forwardRef component still falls back — with the S2
  honest warning. d-forwardref stays GAP in the report.

## Implementation notes (Explore-verified)

- Return type of `find_default_export` must change: arrow bodies can be a bare
  expression (`() => <span/>`) needing a synthetic `{ return …; }` block —
  use `Cow<Function>`/small `ComponentDecl { name, params, body: Cow<…> }`;
  precedent: `expand_inline_body` already returns `Cow<BlockStmt>`.
  Anonymous shapes (`export default () => …`) need a stable display name —
  use the file-derived component name the callers already carry.
- Fix ALL FOUR callers together: lower.rs:159 (`lower`, test-only), :226
  (`lower_with_sources` — route position, so route files gain the shapes
  too), :358 (`lower_component_inline`), :3306 (`try_native_inline` step 4).
- Lockstep widening (same commit, or the feature is inconsistent):
  - `behavior_default_render_body` lower.rs:3096-3115 (behavior-SSR transform
    accepts only DefaultDecl::Fn/Class today — an arrow behavior component
    would silently lose the transform).
  - `declaration_binds_array` static_eval.rs:145-155 (Array-shadow guard must
    also see ExportDefaultExpr shapes).
  - Test helpers that hand-roll the old shape: analyze.rs:190-203,
    static_eval.rs:1585-1608, static_eval.rs:1729-1760.
  - Stale comment runtime/cli/native-routes-emit.ts:213 (says the compiler
    only matches `export default function`) — update the text; the chain
    wrapper generator itself (:247) keeps emitting the classic shape, fine.
- S3: change `helpers` (static_eval.rs:90, filled at :322, consumed at :1191,
  body used at :1214) to a normalized `(params, Cow<BlockStmt>)`; register
  const-arrow/fn-expr inits; an arrow that is registered as a helper must not
  ALSO be misused as a value const in the same expansion (decide precedence:
  helper wins for capitalized idents used as JSX tags, value semantics
  otherwise).
- Route files remain DEFAULT-export-only as a rule (ssg.ts:253-259 requires a
  default export on leaf routes) — widening the recognized default-export
  SHAPES is fine, accepting purely-named-export ROUTES is not.

## Acceptance (coverage report is the spec)

Battery rows in scripts/react-coverage.ts flip to `expected: 'inline'` and
lose `expectedRoute: 'broken'` where the route position now passes:
b-arrow-component (:397), b-declaration-then-default-export (:410),
b-same-file-arrow-helper (:437), d-memo (:630).
b-named-export-component (:423) and d-forwardref (:643) STAY gap — but their
observed reason must become the S2 honest text (update their note text if it
quotes the old reason). Regenerate docs/react-coverage.md (rebuild addon
first; the script exits 1 if stale). Zero `⚠` mismatches allowed.

## Tests

Extend, don't rewrite: `tolerates_extra_top_level_statements` lower.rs:6615,
`rejects_two_default_functions` :6667 (duplicate guard must still fire across
NEW shapes — e.g. `export default X` + a second default), `rejects_no_default_function`
:6683 (message may change; keep it honest), warn+fallback template :9674,
`lower_with_src` :9557. Add per-shape Rust tests for S1 (arrow, ident-then-
export, memo, React.memo, memo(forwardRef(fn)) unwrap, anonymous arrow name)
+ S3 (arrow helper w/ props and children, double-counting guard) + S2
(warning text asserts). Behavior lockstep: an arrow component with `export
const behavior` still gets the behavior transform (model on
single_file_native_component_compiles_with_directive_attr :6638).

## Gates (mirror ci.yml exactly)

1. `cargo fmt --all --check`
2. `cargo test -p jsx-rust-compiler` (and `cargo test --workspace --locked` if
   golden tests are touched)
3. `cd runtime && bun run build:debug`, then `bun scripts/react-coverage.ts`
   ×2 + `git diff --exit-code docs/react-coverage.md`
4. `bun test tests/react-coverage.test.ts`, `bun test
   tests/native-inline.test.ts`, `bun test tests/native-island.test.ts`,
   `bun test tests/native-island-ssr.test.ts` (each separately)
5. `bun run ci`

## Risk ledger

- The `&FnExpr → Cow<Function>` lifetime change is the main risk; keep it
  mechanical, resist refactors beyond the four callers.
- Ident-resolution for `export default X` must NOT resolve through imports
  (only module-local decls) — an imported default re-export is out of scope.
- static_eval expansion budget: arrow helpers go through the same
  add_expansion accounting as fn helpers.
- Remember the one-env guard rule (docs/plans/helper-children-inline.md
  Amendment 1): binding installs values, it never re-expands.
