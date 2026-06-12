# Native compiler relaxations: dynamic head style + inline local bindings + component-map dispatch — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R2 + R3 — (R2) inject per-shop token CSS in native routes (`BrustPage` head `<style>` must accept dynamic values; today `BrustPageHeadTextMustBeLiteral` forces React-SSR for the whole engine), (R3) reuse one `packages/sections` set across React SSR and native (sections have `const rootStyle = {...}` local bindings; `SectionRenderer` dispatches a component by `sectionKey`).

## Goal

Three compiler features in `crates/jsx-rust-compiler`:

- **F1 (R2):** `<BrustPage head={[{ tag: 'style', text: <dynamic expr> }]}>` accepts member-path expressions for `text` on **`style` entries only**, emitted with a new CSS-safe minijinja filter.
- **F2 (R3a):** native component inlining accepts **local `const` bindings** before the return (`const rootStyle = {...}; return <div style={rootStyle}>…`), via AST-level substitution prior to the existing lowering.
- **F3 (R3b):** native inlining supports **component-map dispatch**: `const Comp = MAP[expr]; return <Comp {...props}/>` where `MAP` is a same-file `const MAP = { literalKey: ComponentIdent, ... }` — lowered to a jinja if/elif chain inlining each component.

## Non-goals

- Dynamic `text` for `script`/`noscript` head entries (XSS surface; stays literal-only with the existing error).
- Arbitrary statements in inline bodies (loops, mutation, try/catch) — `const` declarations + the existing single-return / if-return shapes only.
- `let`/`var`, destructuring patterns in inline consts.
- Cross-file component maps (MAP imported from another module) — same-file only in v1.
- A fallback arm for dispatch misses (`MAP[k] ?? Default`); unmatched key renders empty (documented; consumers add a catch-all key).

## F1 — dynamic head style text

Current: `parse_head_array` (`lower.rs` ~1251) accepts only `Lit::Str` for `text`, else `BrustPageHeadTextMustBeLiteral`. Head **attr** values already support `HeadValue::Path(expr)` → `{{ (expr) | e }}`.

Change:
- For entries with `tag == "style"` only: accept the same expression subset as head attrs. **Precisely:** `parse_head_array` runs with `scope.inline = None`, so `lower_expr` only yields `Expr::Field`/`Expr::MemberAccess` here — `data.css` / `cssVar` member paths ONLY; no concat/template-literal/binary (those are inline-gated). Representation: `text: Option<String>` → `Option<HeadValue>` (HeadValue already has Literal/Path variants); literal behavior byte-identical. (Grep for direct `HeadEntry { .. }` struct literals before changing — none known.)
- Emission (`emit_jinja.rs`, the head-entry text branch): `HeadValue::Literal` → raw as today; `HeadValue::Path(e)` → `{{ (path) | style_safe }}`.
- **`style_safe` filter** (registered in `base_env()`, `brust-core/template/jinja.rs` — single registration point shared by boot + dynamic tiers since R1): HTML-escaping would corrupt CSS (`>` selectors), raw would allow `</style>` breakout. The filter replaces ALL case-insensitive occurrences of `</` with `<\/` (valid inside CSS strings, harmless elsewhere — `</` is never valid CSS syntax outside strings) and is NOT safe-marked output… NOTE: minijinja autoescape is `None` in brust (project memory: compiler emits explicit `| e`), so plain filter output is emitted raw — exactly what we want post-scrub.
- `script`/`noscript`/void tags: unchanged errors (`BrustPageHeadTextMustBeLiteral`, `BrustPageHeadTextOnVoid`).
- Error message for non-style dynamic text updated to say "use a literal; dynamic text is only supported on style entries".

## F2 — inline local const bindings (AST substitution)

Current: `lower_component_inline` (`lower.rs` ~322) accepts single-return or two-stmt if-return; anything else → `InlineUntranslatable("local binding")`.

Change — pre-pass before shape matching:
1. Accept bodies of shape `[zero+ const-decl stmts, then the existing accepted shapes (return | if-return)]`.
2. Each const decl: every declarator must be `Ident = <Expr>` (no destructuring → keep `InlineUntranslatable("destructuring binding")` new message; `let`/`var` → `InlineUntranslatable("let/var binding — use const")`).
3. Build substitution sequentially: for declarator N, first substitute consts 1..N-1 into its init expr, then record. Finally substitute all into the remaining statements (return expr / if-cond + both return exprs).
4. Substitution = **manual recursive clone-and-rewrite over a cloned `BlockStmt`** (SWC nodes are Clone). NOT the swc `Fold` trait — the `ecma_transforms` feature is not enabled in Cargo.toml and must not be added; precedent for scope-aware manual walks is the `Scope.map_bindings` push/pop pattern (lower.rs ~107-123, consulted at ~4090). The walk replaces `Ident` references by a clone of the recorded init expr and MUST NOT replace: member-expression property idents (`a.b`'s `b`), non-computed object keys, JSX attribute names, JSX element names (those are handled by F3 separately — see below), and any subtree where the name is shadowed by a function/arrow param (e.g. `.map(item => …)` shadowing a const `item`) or a nested const of the same name (reject nested redeclaration instead: simpler + rare).
5. After substitution the existing lowering runs unchanged — whatever shapes it already accepts (style objects, ternaries, .map sugar, x-props) now work with hoisted consts, and whatever it rejects keeps its existing error.
6. Gate order note: `analyze(body)` runs BEFORE `lower_component_inline` (try_native_inline ~2082) and walks const inits too — a const whose init calls a hook (`const t = useTheme()`) is already rejected upstream as `Fallback(Hook)`. F2 adds no hook risk.
7. The substitution walk must recurse into arrow bodies (`.map(item => …)` is the target shape) carrying a shadowed-names set (params + nested consts); a nested `const` redeclaring an outer recorded name → `InlineUntranslatable("const redeclaration")`.

JSX element names: if a const's init is a JSX-usable expression (`const Tag = MAP[k]`) and the body uses `<Tag …/>`, substitution rewrites the element name expression — this is the F3 entry point. For v1, a const used as a JSX element name with any init OTHER than the F3 `MAP[expr]` shape → `InlineUntranslatable("dynamic component")`.

## F3 — component-map dispatch

Recognized shape (after F2 substitution): JSX element whose name resolves to `<ObjectLitMap>[<member-path expr>]` where the object literal's values are component identifiers resolvable in `component_sources` (same mechanism the existing `lower_ssr_component`/`try_native_inline` uses) and keys are string-able literals (ident or string keys).

Lowering: for `MAP = {hero: Hero, gallery: Gallery}` and dispatch expr `k` with call-site props P, IR is a **nested `JsxNode::Cond` chain** (alternate of one Cond holds the next). Tests are synthesized programmatically as `Expr::Compare { op: CmpOp::Eq, lhs: <dispatch path>, rhs: <string literal> }` — this variant EXISTS (ir.rs ~279; emit_expr_path emits `(lhs) == (rhs)`; `JsxNode::Cond` emits `{% if <test> %}`). Do NOT add a new IR variant. The emitted jinja is NESTED ifs, not `{% elif %}` (`emit_jinja.rs` Cond emits `{% else %}{% if %}…{% endif %}{% endif %}`) — functionally identical in minijinja; accept the nested form, do not build an elif emitter.

Each branch inlines via the existing `try_native_inline` machinery (circular-inline guard applies per branch). **Call-stack placement:** the F3 recognizer runs inside `lower_component_inline`'s body handling (post-F2 substitution) and is only active when `scope.inline_env` is `Some` (mirrors the `has_native && inline_env` guard at lower.rs ~1707). It inlines each map value itself; if ANY mapped component is not inlinable it returns `Err(InlineUntranslatable("dispatch component not inlinable"))`, which the outer `try_native_inline` converts to warning + `Ok(None)` → caller emits the SSR-component fallback (the documented `Ok(None)` soft-fallback contract at lower.rs ~2007). No partial native dispatch.

Props: the dispatch element's attrs (incl. spread of a member path? — NO spread in v1; explicit attrs only, existing rules) are applied identically to every branch.

## File structure

- `crates/jsx-rust-compiler/src/lower.rs` — parse_head_array text relaxation; const pre-pass + substitution folder; dispatch recognition + Cond-chain lowering
- `crates/jsx-rust-compiler/src/ir.rs` — `text` field type change to HeadValue (if needed); possible new Expr eq variant (check existing binary IR first — explorer says `lower_bin_inline` exists, so equality likely already representable)
- `crates/jsx-rust-compiler/src/emit_jinja.rs` — style text Path emission
- `crates/jsx-rust-compiler/src/lib.rs` — error-variant additions/message updates
- `crates/brust-core/src/template/jinja.rs` — `style_safe` filter in `base_env()` + unit tests
- `tests/` TS-side: extend fixture app with a native route using dynamic head style + a section-style component with const bindings + a dispatch component; assert rendered HTML E2E (the cli-build/native-routes-emit path)
- `example/docs/content/native-routes.md` (or wherever native constraints are documented — find the page) — update the constraint list; `architecture.md` native section note

## Tests

Rust unit (lib.rs/lower.rs test mods, follow existing test style):
- F1: style text member-path → emits `{{ (data.css) | style_safe }}`; literal unchanged; dynamic text on script still rejected; on meta (void) still rejected
- style_safe filter: `a</style><script>` → `a<\/style><script>` is NOT emitted raw… (filter test in jinja.rs: input containing `</style` comes out with `<\/`; case-insensitive `</STYLE`; plain CSS untouched)
- F2: component with `const rootStyle = {...}` + style attr → compiles, emission equals the pre-hoisted equivalent; const chain (B uses A); const + if-return; destructuring/let rejected with new messages; shadowed name in .map callback NOT substituted; const redeclaration rejected
- F3: two-key map dispatch → if/elif chain with both components inlined, props substituted per branch; map with non-inlinable component → whole dispatch falls back (warning); non-MAP dynamic element name → `InlineUntranslatable("dynamic component")`
- existing test suite stays green (regression)

E2E (TS): fixture native route renders per-shop style text + a dispatched section; `tests/jinja-route.test.ts`-style assertion on the HTTP body.

## Acceptance criteria

- All cargo tests green (`cargo test -p jsx-rust-compiler -p brust-core`), clippy/fmt clean, full `bun test` unchanged except new tests, biome green.
- Runtime addon rebuilt; fixture E2E proves the three features through the real pipeline.
- Docs updated (constraint list).

## Known limitations

- F3 same-file maps only; no spread props on dispatch elements; miss renders empty.
- F2 consts are syntactic substitution — a const used N times duplicates its expression N times in the template (fine for the target use; documented).
- style_safe is a breakout guard, not a CSS sanitizer — per-tenant CSS is trusted-ish content authored by the platform, not end users (documented).

## Open questions resolved at plan-time

- Whether `Expr` IR already has string-equality binary representation usable in jinja `{% if %}` tests (explorer: `lower_bin_inline` handles comparison — planner verifies and reuses).
- Exact representation of head `text` today (`Option<String>` vs HeadValue) — planner reads the struct and picks the minimal change.
