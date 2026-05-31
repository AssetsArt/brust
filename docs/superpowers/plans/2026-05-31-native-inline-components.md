# Plan — Native inline components (`<Comp native/>`)

Spec: `docs/superpowers/specs/2026-05-31-native-inline-components-design.md` · Base: `9965f15`

TDD, bottom-up. Each task: tests first (red) → implement (green) → `cargo fmt` +
clippy clean. Rebuild addon (`cd runtime && bun run build`, ~40s) before any TS/
integration task sees Rust changes. Run `tests/*.test.ts` SEPARATELY.

## Open questions — RESOLVED for v1
- **Q1 map keying:** `component_sources: HashMap<String,String>` keyed by **local
  component ident** as written (route + each component file). Ident collision
  across the native graph → hard error `InlineIdentCollision`. (v1 limitation.)
- **Q2 method→filter allowlist:** `toUpperCase→upper`, `toLowerCase→lower`,
  `trim→trim`, `slice(a,b)→slice(a,b)`, `join(s)→join(s)`, `.length→length`
  (property, not call). Anything else → fallback.
- **Q3:** ONE extended `Expr` enum (no separate CondExpr).
- **Q4:** default param values, `{...rest}`, spread at call site → **fallback**
  (not supported v1).
- **Q5 truthiness:** absent member path renders as minijinja `none` (falsy);
  `===`→`==`, `!==`→`!=`; `&&`→`and`, `||`→`or`, `!`→`not`. Rely on minijinja
  truthiness (none/false/0/""/empty falsy).

## Spec-coverage map
| Spec section | Task |
|---|---|
| IR additions (Cond, ChildrenSlot, Clone, Expr) | T1 |
| emit_jinja {% if %} + new Expr | T2 |
| IR-walker recursion into Cond | T3 |
| analyze (inlinability) | T4 |
| inline (expansion + recursion + cycle) | T5 |
| lower.rs native branch + warnings | T6 |
| lib.rs/NAPI wiring + CircularInline | T7 |
| TS build: recursive sources + merged imports + warnings | T8 |
| Integration | T9 |

---

## T1 — IR additions
**Files:** `crates/jsx-rust-compiler/src/ir.rs`
- Add to `JsxNode`: `Cond { test: Expr, consequent: Box<JsxNode>, alternate: Option<Box<JsxNode>> }`, `ChildrenSlot`.
- Add `Clone` to `JsxNode`'s derive (now `#[derive(Debug, Default, Clone)]`).
  `Expr` already derives `Clone`. Add `Clone` to any nested type a JsxNode owns
  that lacks it (JsxAttr, AttrValue, SsrProp) so the tree clones.
- Extend `Expr`: `Arith { op: ArithOp, lhs: Box<Expr>, rhs: Box<Expr> }`,
  `Concat(Vec<Expr>)` (template literal: literal+expr segments),
  `Filter { value: Box<Expr>, name: String, args: Vec<Expr> }` (method→filter),
  `Compare { op: CmpOp, lhs: Box<Expr>, rhs: Box<Expr> }`,
  `Logical { op: LogOp, lhs: Box<Expr>, rhs: Box<Expr> }`, `Not(Box<Expr>)`.
  Add small enums `ArithOp{Add,Sub,Mul,Div,Mod}`, `CmpOp{Eq,Ne,Gt,Lt,Ge,Le}`,
  `LogOp{And,Or}` (derive Debug, Clone, PartialEq).
- This breaks exhaustive matches. In `emit_jinja.rs` and `emit_factory.rs`, add
  arms: for new `JsxNode` variants in emit_factory add `unreachable!("...")`
  TEMPORARILY (T2/T3 replace emit_jinja's). Just enough to compile.
**Tests (`ir.rs` #[cfg(test)] or a new test mod):**
- `cond_node_clones`: build a `Cond`, `.clone()`, assert structural eq via Debug.
- `expr_variants_construct`: build each new Expr, Debug-format non-empty.
**Green:** `cargo test -p jsx-rust-compiler ir` ; `cargo build -p jsx-rust-compiler`.
**BLOCKED fallback:** if Clone on JsxNode fights a non-Clone field, derive Clone
on that field too; if truly impossible, box it.

## T2 — emit_jinja: Cond + new Expr
**Files:** `crates/jsx-rust-compiler/src/emit_jinja.rs`
- `emit_node`: `JsxNode::Cond { test, consequent, alternate }` →
  `{% if <test> %}<consequent>{% else %}<alternate>{% endif %}` (omit `{% else %}`
  when `alternate` is None). Use `emit_expr_path` for the test.
- `JsxNode::ChildrenSlot => unreachable!("ChildrenSlot must be substituted before emit")`.
- Extend `emit_expr_path` for new `Expr`: `Arith`→`a + b` (map ops), `Concat`→
  `a ~ b ~ "lit"`, `Filter`→`value | name` or `value | name(args)`,
  `Compare`→`a == b` etc, `Logical`→`a and b`/`a or b`, `Not`→`not a`. Parenthesize
  binary operands to preserve precedence.
**Tests (emit_jinja test mod, golden strings):**
- `cond_and_emits_if`: `Cond{test:Field("active"), consequent:<span>, alternate:None}`
  → `{% if active %}<span></span>{% endif %}`.
- `cond_ternary_emits_if_else` → `{% if x %}…{% else %}…{% endif %}`.
- `filter_upper` : `Filter{Field("name"),"upper",[]}` inside `{{ }}` → `{{ name | upper }}`.
- `compare_gt`: `{% if count > 0 %}` ; `concat`: `{{ "Hi " ~ name }}` ;
  `logical_and`: `{% if a and b %}`.
**Green:** `cargo test -p jsx-rust-compiler emit_jinja`.

## T3 — IR-walker recursion into Cond
**Files:** `crates/jsx-rust-compiler/src/lib.rs`, `emit_factory.rs`
- In `number_islands`, `collect_islands`, `number_ssr_components`,
  `collect_components` (lib.rs) and `collect_factories` (emit_factory.rs): add a
  `JsxNode::Cond { consequent, alternate, .. }` arm that recurses into
  `consequent` and (if Some) `alternate`. Add `JsxNode::ChildrenSlot => {}` (no-op,
  unreachable post-lower but keep matches exhaustive without panic in collectors).
**Tests (lib.rs test mod):**
- `collect_islands_recurses_cond`: route IR with `Cond` whose consequent holds an
  `Island` → `collect_islands` returns it; `number_islands` assigns instance 0.
- `collect_components_recurses_cond`: `Cond` branch holds an `SsrComponent` →
  collected.
**Green:** `cargo test -p jsx-rust-compiler`.

## T4 — analyze.rs (inlinability)
**Files:** NEW `crates/jsx-rust-compiler/src/analyze.rs`; register `mod analyze;`.
- `pub enum Inlinability { Inlinable, Fallback(FallbackReason) }` where
  `FallbackReason { Hook(String), SideEffect(String), Untranslatable(String), Unresolved(String) }` (impl Display for warning text).
- `pub fn analyze(func_body: &swc_ecma_ast::Function|ArrowExpr) -> Inlinability`:
  walk the body AST. Fallback if: any `CallExpr` whose callee ident matches
  `^use[A-Z]` → Hook; any `AwaitExpr`/`ThrowStmt`/`console.*` call → SideEffect.
  Expression translatability is checked in T5's `translate_expr` (returns
  Result); analyze can defer expr checks to inline and convert an inline
  `Untranslatable` error into a fallback there. analyze's job = hook+side-effect
  gate. (Keeps analyze pure-syntactic.)
**Tests (`analyze.rs` test mod) — parse via `parser::parse` then analyze:**
- `pure_props_jsx_inlinable`
- `usestate_hook_fallback` (callee `useState`) → Fallback(Hook)
- `custom_hook_fallback` (callee `useTheme`)
- `await_fallback`, `throw_fallback`, `console_fallback`
**Green:** `cargo test -p jsx-rust-compiler analyze`.

## T5 — inline.rs (expansion)
**Files:** NEW `crates/jsx-rust-compiler/src/inline.rs`; `mod inline;`.
- `pub struct Subst { pub props: HashMap<String, Expr>, pub children: Vec<JsxNode> }`
- `pub fn inline_component(parsed: &ParsedSource, subst: &Subst, sources: &HashMap<String,String>, cycle: &mut Vec<String>) -> Result<Vec<JsxNode>, LowerError>`:
  1. find the component's returned JSX (single return, or if/else returns → build
     `Cond`). Lower it reusing `lower`'s element machinery BUT with a substitution
     scope: a prop ident reference resolves to `subst.props[ident]` (an `Expr`);
     a `children` reference → emit `ChildrenSlot` then splice `subst.children`.
  2. `translate_expr(swc_expr) -> Result<Expr, Untranslatable>`: member path,
     literals, arith, template literal→`Concat`, allow-listed method→`Filter`,
     compare, logical, not. Unknown call/method/regex → `Err(Untranslatable)`.
  3. For a `native`-annotated descendant element: recurse — push its ident to
     `cycle`; if already present → `Err(CircularInline(cycle.join("→")))`; resolve
     its source from `sources` (missing → caller treats as Unresolved fallback);
     inline; pop.
  4. Replace each `ChildrenSlot` in the produced nodes with cloned `subst.children`.
**Tests (`inline.rs` test mod):**
- `substitutes_member_prop`: `({title})=><h1>{title}</h1>` + subst title=`data.x`
  → `<h1>` with `Expr::MemberAccess(data.x)`.
- `splices_children`: `({children})=><div>{children}</div>` + children=[Text("hi")]
  → `<div>` containing `Text("hi")` (no ChildrenSlot remains).
- `and_becomes_cond`, `ternary_becomes_cond`, `ifelse_return_becomes_cond`.
- `template_literal_concat`, `method_upper_filter`, `arith_add`.
- `unknown_method_untranslatable` → Err.
- `nested_native_recurses`, `circular_native_errors` (A→B→A → CircularInline).
**Green:** `cargo test -p jsx-rust-compiler inline`.
**BLOCKED fallback:** if reusing `lower`'s private element fns is hard, expose a
crate-internal `lower_element_with_subst(el, scope, subst)` in lower.rs and call
it from inline; do NOT duplicate the lowering logic.

## T6 — lower.rs native branch + warnings
**Files:** `crates/jsx-rust-compiler/src/lower.rs`
- Thread `sources: &HashMap<String,String>` and `warnings: &mut Vec<String>`
  through `lower`/`lower_element`/`lower_ssr_component` (add params; update call
  sites; existing public `lower(parsed)` keeps signature by defaulting empty —
  add `lower_with_sources(parsed, sources, warnings)` and make `lower` delegate
  with empty map + a throwaway warnings vec).
- In `lower_ssr_component`: detect bare `native` attr (like `ssr` on island;
  must not become a prop). If present:
  - resolve source from `sources[ident]` (missing → push warning
    `native component "X" not inlined: source unresolved`, emit SsrComponent).
  - parse + `analyze`: Fallback → push warning with reason, emit SsrComponent.
  - Inlinable → `inline::inline_component(...)`; `Ok(nodes)` → return them
    (splice); `Err(Untranslatable)` → warning + SsrComponent; `Err(CircularInline)`
    → propagate (hard error).
  - `native` + `isr` present and inlined → push warning `isr ignored on inlined
    native component "X"`; if it falls back → keep isr (existing path).
**Tests (lower.rs test mod) — `lower_with_sources`:**
- `native_pure_inlines`: route `<Card native title="x"/>`, sources has Card →
  result has no `SsrComponent`, has the expanded element.
- `native_hook_falls_back`: Card uses useState → result has `SsrComponent`,
  warnings non-empty containing "useState"/hook.
- `native_unresolved_falls_back` (no source) → SsrComponent + warning.
- `native_isr_inlined_warns`.
**Green:** `cargo test -p jsx-rust-compiler lower`.

## T7 — lib.rs + NAPI wiring
**Files:** `crates/jsx-rust-compiler/src/lib.rs`, `crates/brust/src/jsx_compile.rs`
- `Compiled` gains `pub warnings: Vec<String>`. `compile_full(source, path,
  sources)` builds a warnings vec, calls `lower_with_sources`, sets it.
  `compile`/`compile_with_path` delegate with empty sources.
- New error kind `CompileError::CircularInline(String)` + `InlineIdentCollision(String)`.
- NAPI `compile_jsx(source, path, component_sources: Option<HashMap<String,String>>)`;
  `NapiCompiledJsx` gains `pub warnings: Vec<String>`. `None` → empty map (today's
  behavior). Map the Rust `warnings` through.
**Tests:**
- Rust: `compile_full_collects_warnings` (route with a fallback native →
  warnings non-empty); `circular_inline_errors`.
- `jsx_compile.rs` test mod: `compile_jsx_accepts_component_sources_and_returns_warnings`.
**Green:** `cargo test --workspace`. Then `cd runtime && bun run build`.

## T8 — TS build wiring
**Files:** `runtime/cli/native-routes-emit.ts`, `runtime/islands/build.ts`,
`runtime/index.d.ts`
- `index.d.ts`: `compileJsx(source, path, componentSources?: Record<string,string>): NapiCompiledJsx`;
  add `warnings: string[]` to `NapiCompiledJsx`.
- Build: for each native-referenced component (transitively), read its source;
  build `componentSources` (ident→source) and pass to `compileJsx`.
- Build a **merged import map** = page `scanImports` ∪ each inlined file's
  `scanImports`, pass to `reconcileIslandManifest` and `emitComponentArtifacts`
  (fixes the throw). Ident collision with differing paths → throw clear error.
- Print `compiled.warnings` to `process.stderr` (one line each).
**Tests (`runtime/cli/native-routes-emit.test.ts` or build.test.ts — temp files):**
- `compileJsx_accepts_componentSources_and_returns_warnings`.
- `recursive source gather resolves transitive native import`.
- `merged import map lets a nested island reconcile` (the BLOCKER regression).
**Green:** `cd /Users/detoro/code/brust && bun test runtime/` ; `bun run ci`.

## T9 — Integration
**Files:** `tests/native-island-ssr.test.ts` (extend; same `brust build` +
cwd=FIXTURE_DIR harness), fixture components under `tests/fixtures/app`.
- Add a pure `InlineCard.tsx` (props→JSX, no hooks) + a route using
  `<InlineCard native title={data.x}/>`.
- Assertions: built jinja for that route contains the expanded markup, contains
  NO `comp_<n>_html` slot for InlineCard, `.components.json` has no InlineCard
  entry, `.factory.ts` has no InlineCard factory.
- A `<HookCard native/>` (uses useState) route → jinja HAS a `comp_N_html` slot,
  stderr warning emitted.
- A native component containing `<Island>` → built islands.json has the island,
  page renders + hydration markup present.
- A native component with `{cond ? <A/> : <B/>}` on `data` → jinja has
  `{% if %}…{% else %}`, renders correct branch for two data inputs.
**Green:** `cd /Users/detoro/code/brust && bun test tests/native-island-ssr.test.ts`.

## Final gate (Phase 6, orchestrator)
`cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings`
· `cargo test --workspace` · `bun test runtime/` · `bun run ci` · each
`tests/*.test.ts` separately · golden fixtures unmoved (no-native routes byte-identical).
