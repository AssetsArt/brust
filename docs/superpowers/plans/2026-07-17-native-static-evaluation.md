# Implement bounded native static evaluation

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Implement the accepted design in
`docs/superpowers/specs/2026-07-17-native-static-evaluation-design.md` so the
seven native Ket Doc landing components compile to native markup with no React
SSR slots.

## Reading order

1. `docs/superpowers/specs/2026-07-17-native-static-evaluation-design.md`
2. `docs/superpowers/plans/2026-07-17-native-static-components-investigation.md`
3. `crates/jsx-rust-compiler/src/lower.rs`: `lower_component_inline`,
   `try_native_inline`, `lower_call_as_map`, expression lowering, lucide lowering
4. `crates/jsx-rust-compiler/src/analyze.rs`
5. `tests/native-inline.test.ts` and `tests/fixtures/app/NativeInline.tsx`
6. The seven files under `/Users/detoro/code/ket-doc/landing/components` named in
   the investigation plan

## Implementation

### 1. Deep static-expansion module

Create `crates/jsx-rust-compiler/src/static_eval.rs` and expose only a
crate-private `expand_inline_body(module, root_name, function)` interface plus
its error type. Register the module from `lib.rs`.

The implementation must satisfy the supported subset, substitution rules,
all-or-nothing behavior, and exact budgets in the design. It must return a
borrowed body when no transformation is needed. Do not introduce SWC transform
features or arbitrary JavaScript execution; follow the existing manual
clone-and-rewrite precedent in `hoist_const_bindings`.

Run the pass in `lower_component_inline` before `hoist_const_bindings` so the
existing local-const and IR lowering paths remain the downstream source of
truth. Static callback-local consts and same-file helper props are expanded by
the new module; runtime prop maps are left unchanged for `lower_call_as_map`.

Same-file helper lookup is limited to unexported top-level function declarations
in the same parsed module. It is a narrow private-helper exception to the
existing non-cascade rule, not permission to auto-inline imported/exported child
components. Analyze every helper body before expansion. A hook, side-effect,
unsupported helper/default/prop/lucide shape, cycle, or budget breach fails the
outer native inline attempt with a precise soft-fallback reason; it must never
emit an SSR factory for an unexported local helper. Function-valued const helpers
remain out of scope for this change.

### 2. Numeric and diagnostics correctness

Preserve finite decimal literals through static attribute/lucide compilation.
Do not globally turn integer-only data expressions into floats; choose the
smallest IR/lucide change that supports `strokeWidth={2.5}` and `{2.25}` while
keeping existing numeric template semantics and tests.

In `try_native_inline` stage 6, include the actual `LowerError.kind` text for any
lowering failure. Keep the stage-2 call-site `unsupported prop` warning unchanged.

### 3. Regression fixture

Add a native fixture route in `tests/fixtures/app` that covers the Ket Doc
shapes in one small component:

- module object-array and tuple-array maps;
- a direct literal-array map;
- callback index and tuple/object destructuring;
- callback block with a leading `const Icon = item.icon`;
- nested feature-array map and missing optional boolean field;
- class/string conditional;
- pure same-file helpers, including a defaulted boolean prop;
- lucide icons with fractional `strokeWidth`.

Wire the route in `tests/fixtures/app/routes.tsx`. Extend
`tests/native-inline.test.ts` (or add one focused sibling test if isolation is
cleaner) to run through the real CLI/NAPI path and assert:

- distinctive HTML from every shape exists in the emitted Jinja;
- build stderr has no fallback warning for the fixture component;
- its `.components.json` is absent or contains neither the native root nor any
  same-file helper;
- the existing hook component still falls back with its current warning and
  manifest entry.

Add focused Rust tests at the new module interface and compile/lower interface
for every supported binding/expression shape, runtime-map passthrough, helper
hook/cycle/budget/default-prop fallback, decimal lucide props, and precise
diagnostics. Include a negative helper fixture proving an unsupported private
helper falls back the outer imported component and never creates a local-helper
SSR manifest entry.

## Non-goals

- Calls, spread/computed static objects, getters, methods, mutation, async,
  arbitrary loops, or general JavaScript evaluation.
- Auto-inlining imported components that are not marked `native`.
- Changing runtime loader-data map output.
- Editing the Ket Doc source components to fit compiler limitations.

## Risk ledger

- **Semantic drift:** missing object properties must be undefined/falsy, not a
  hard error; string and numeric `+` must not be conflated.
- **Scope capture:** callback/helper parameters and local consts may shadow outer
  bindings. Attribute/property names are never substitution targets.
- **Template explosion:** enforce all three design budgets before cloning more
  output; nested maps and recursive helpers share one counter.
- **Partial native output:** any failure in a same-file helper or static map
  falls back the imported root as one unit.
- **Stale addon:** TypeScript/E2E and Ket Doc verification are invalid until
  `runtime/brust.darwin-arm64.node` is rebuilt from the changed Rust source.
- **Fixture false positive:** assert manifest absence, not only warning absence.

## Gates

Run from `/Users/detoro/code/brust` unless a command says otherwise:

1. `cargo fmt --check`
2. `cargo test -p jsx-rust-compiler`
3. `cargo clippy -p jsx-rust-compiler --all-targets -- -D warnings`
4. `cd runtime && bun run build`
5. `bun test tests/native-inline.test.ts`
6. `bun run ci`
7. `bun test`
8. From `/Users/detoro/code/ket-doc/landing`, run
   `bun /Users/detoro/code/brust/runtime/cli/index.ts build` and capture stderr.
   Expected: none of the seven `native component "…" not inlined` warnings.
9. Inspect `/Users/detoro/code/ket-doc/landing/dist/jinja/Home.components.json`.
   Expected: none of `NavBar`, `Hero`, `DocumentTypes`, `FlowSection`,
   `AccuracySection`, `AutomationSection`, `PricingSection`, `HeroScene`, or
   `DocumentSheet`; the unmarked `Footer` may remain.

## Escalation contract

Implementation choices inside this interface are the implementer's. Any need to
execute arbitrary JavaScript, widen auto-inlining beyond same-file helpers,
change runtime loader-map output, or weaken all-or-nothing fallback is a design
conflict: file a task challenge to Aoki with evidence and a safe default.
