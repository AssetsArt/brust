# Compiler inline relaxations (R2+R3) — implementation plan

Spec: `docs/superpowers/specs/2026-06-13-compiler-inline-relax-design.md` — the spec carries file:line-level detail (post-review, verified against source). This plan defines task boundaries, order, and gates.

Branch: `feat/compiler-inline-relax`

Gates after EVERY task: `cargo test -p jsx-rust-compiler -p brust-core` green, `cargo fmt --all`, `cargo clippy --all-targets --locked -- -D warnings`, commit.

## Task 1 — F1 dynamic head style text (+ style_safe filter)

TDD. Implement spec §F1:
- `crates/brust-core/src/template/jinja.rs`: `style_safe` filter in `base_env()` — replaces every case-insensitive `</` with `<\/`. Unit tests in the existing tests mod (take TEST_LOCK; cases: `</style>` breakout scrubbed, `</STYLE` case-insensitive, plain CSS untouched, renders through a registered template).
- `crates/jsx-rust-compiler`: `HeadEntry.text: Option<String>` → `Option<HeadValue>`; `parse_head_array` accepts member-path exprs for `tag == "style"` text (everything else keeps `BrustPageHeadTextMustBeLiteral`, message updated per spec); `emit_jinja.rs` head-text branch emits Literal raw / Path as `{{ (path) | style_safe }}`.
- Rust tests per spec §Tests F1 (follow the existing `brust_page_head_*` test style in lib.rs ~1158-1340; UPDATE `brust_page_head_dynamic_text_is_rejected` to target a script entry and ADD the style-accepts case).
- Commit: `feat(compiler): dynamic BrustPage head style text via style_safe filter (R2)`

## Task 2 — F2 inline local const bindings

TDD. Implement spec §F2 (manual clone-walk substitution pre-pass in `lower_component_inline`; shadowing rules; new InlineUntranslatable messages). Rust tests per spec §Tests F2. Make sure the warning-path (analyze gate) tests still pass. Commit: `feat(compiler): native inline accepts local const bindings (R3a)`

## Task 3 — F3 component-map dispatch

TDD. Implement spec §F3 (recognizer post-substitution, `scope.inline_env` gated, synthesized `Expr::Compare`/nested Cond chain, all-or-nothing fallback via `Err(InlineUntranslatable)` → outer `Ok(None)`). Rust tests per spec §Tests F3. Commit: `feat(compiler): native inline component-map dispatch (R3b)`

## Task 4 — E2E + addon rebuild + docs

- Rebuild addon (`cd runtime && bun run build:debug`) — REQUIRED before any TS-side test touches the compiler (stale-napi memory).
- Fixture: add to `tests/fixtures/app` a native route exercising all three (dynamic head style from loader data + a section component with const bindings + a two-key dispatch). Wire E2E assertions following `tests/jinja-route.test.ts` patterns (or extend that file).
- Docs: update the native-routes constraint list (`example/docs/content/` — find the page describing native template constraints) + `architecture.md` native section.
- Full `bun test` + `bun run ci` green.
- Commit: `feat: E2E + docs for compiler inline relaxations (R2+R3)`

## BLOCKED fallbacks

- F2: if the clone-walk hits an SWC node shape that can't be cloned-and-rewritten cleanly, restrict v1 to consts whose init is an ObjectLit/string/number/member-path (covers `rootStyle`) and reject others with `InlineUntranslatable("const init too complex")` — still satisfies R3a's driving case.
- F3: if branch-inlining inside `lower_component_inline` fights the borrow structure (Rc<InlineEnv> re-entry), pivot: synthesize the Cond chain at the `lower_ssr_component` level instead (where try_native_inline is already called per component). If both fail → ship F1+F2, file F3 as explicit deferral in the PR body, and tell the orchestrator (do NOT silently drop).

## Spec coverage map

| Spec § | Task |
|---|---|
| F1 + style_safe | 1 |
| F2 substitution + shadowing + errors | 2 |
| F3 recognizer/lowering/fallback | 3 |
| E2E fixture + docs + acceptance | 4 |
