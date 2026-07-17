# Imported Static Constants in Native Inline Components

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Allow an implicitly native-inlined component to statically expand a local named import whose source is a bounded `export const` value. The motivating consumer shape is `NavBar.tsx` importing an array of literal link objects and rendering `NAV_LINKS.map(...)` alongside a client island.

The delivered behavior must make the exact NavBar-shaped compiler fixture inline into Jinja while retaining `MobileMenu` in the island manifest. It must not turn the compiler into a general JavaScript module evaluator.

## Decisions

1. Resolve only local **named imports** backed by a directly declared `export const` in a source already supplied through `component_sources`. The local binding may be aliased; match the imported/exported name in the dependency and cache the resulting static value under the local name.
2. Evaluate the exported initializer with the existing bounded static evaluator and its existing literal/array/object/operator budgets. Same-module `const` dependencies may resolve through the existing evaluator. Do not execute calls, getters, methods, side effects, or package imports.
3. Stay fail-closed. Default imports, namespace imports, `export { X }`, re-exports, dynamic imports, and transitively imported constants are outside this slice. Unsupported values retain fallback behavior with a precise static-evaluation warning.
4. Preserve the existing `Island` ISR contract: `isr` without `ssr` remains invalid. The consumer's `<Island component={MobileMenu} isr={{...}} />` is a separate authoring error; for its client-only intent, omit `isr`. Do not silently ignore it in the compiler.
5. Do not change source gathering in `runtime/cli/native-routes-emit.ts`: the current gatherer already supplies the `NAV_LINKS` dependency source under the local imported identifier. Prove this assumption through the compiler-facing fixture and existing gather tests; modify runtime gathering only if a failing regression demonstrates it is necessary, and challenge this plan before widening the boundary.

Rejected alternatives:

- Treating `.map` as a readable property on every imported symbol: this hides the missing module value and permits method semantics the evaluator does not implement.
- Inlining dependency source text by string rewriting: this loses AST binding/alias semantics and is unsafe around shadowing.
- Ignoring `isr` when `ssr` is absent: this converts an authoring error into inert configuration and masks caching mistakes.
- General recursive ESM evaluation: unnecessary for the reported literal data module and expands the security/budget surface substantially.

## Implementation Boundary

- `crates/jsx-rust-compiler/src/static_eval.rs`
- `crates/jsx-rust-compiler/src/lower.rs`
- `crates/jsx-rust-compiler/src/lib.rs`

No consumer file is committed in this task. `/Users/detoro/code/ket-doc` is an acceptance fixture only and must not be edited by the implementation lane.

## Implementation

1. Add a source-aware entry point or parameter at `expand_inline_body` so `lower_component_inline` can expose the shared `InlineEnv.sources` map to static evaluation. Keep source-free unit helpers using an empty map.
2. Teach evaluator module scanning to recognize both plain `const` declarations and direct `export const` declarations. Preserve binding-count checks.
3. During evaluator construction, inspect named import specifiers. When `component_sources[local_name]` exists, parse that dependency, find the directly declared exported const matching the imported name, and evaluate only that initializer with a dependency-local bounded evaluator. Insert a successful value into the current evaluator cache under the local binding. Component imports and unsuccessful/unsupported const candidates must remain unresolved symbols/fallbacks.
4. Keep resolution one dependency module deep. Detect/self-limit cycles using existing recursion/binding/depth limits; do not chase the dependency's imports in this slice.
5. Preserve the static-map expansion path: once `NAV_LINKS` resolves to `Value::Array`, `expand_map_expr` must use the existing callback binding and `append_expr_children` behavior unchanged.

Implementation judgment within these constraints belongs to Dabin. Any need to change public NAPI parameters, runtime source gathering, ISR semantics, or general expression support is a design conflict and must be filed as a task challenge for Aoki to rule.

## Tests (red before green)

1. In `static_eval.rs`, add a focused failing test for an aliased named import resolving a direct `export const` literal array. Assert the map expands and imported/local member values appear in the expanded body.
2. Add negative tests proving default/namespace imports and a non-static exported initializer are not executed or widened. Assert deterministic fallback/error text rather than panic.
3. In `lib.rs`, add an end-to-end `compile_full` regression with:
   - route source rendering `<NavBar/>`;
   - `NavBar` source importing `NAV_LINKS`, mapping links to anchors, and containing `<Island component={MobileMenu}/>`;
   - dependency source `export const NAV_LINKS = [...]` supplied under `NAV_LINKS`;
   - `MobileMenu` source using `useState`, supplied under `MobileMenu`.

   Assert `warnings` is empty, `components` is empty, the Jinja template contains every static link, and `islands_json` contains `MobileMenu` exactly once.
4. Add or retain a negative exact-shape test showing `isr={{ key: "[NavBar]MobileMenu" }}` without `ssr` still produces the existing island-ISR fallback warning. This guards Decision 4.

## Gates

Run in the lane, in order:

```sh
cargo fmt --all -- --check
cargo test -p jsx-rust-compiler static_eval
cargo test -p jsx-rust-compiler
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

After integration on main, Aoki reruns:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd runtime && bun run build:debug
cd .. && bun run ci
bun test runtime/
```

Consumer acceptance is read-only/in-memory: compile the actual `NavBar.tsx` after removing only its inert `isr` attribute in memory, using the actual `NAV_LINKS` and `MobileMenu` sources. Expected: no NavBar warning, template contains `Document Flow`, and island manifest contains `MobileMenu`. Do not edit or commit the consumer repository in this task.

## Risk Ledger

- `component_sources` is keyed by local identifier rather than module path. Alias handling must use the import specifier's imported name for export lookup and local name for source-map/cache lookup.
- A source file can contain multiple exports. Select only the requested direct `export const`; never import every top-level binding into the caller namespace.
- Imported literal graphs can consume budgets. Reuse bounded evaluation and fail closed; do not introduce an unbounded clone/walk.
- Capitalized component and lucide imports are represented as symbols today. Do not reinterpret them as static consts unless their supplied source directly exports the requested const value.
- The existing warning `property map is unsupported` is a symptom of unresolved import traversal. Do not weaken `read_property` globally as a shortcut.
- Conclave lane worktrees may need a lane-local `node_modules` symlink for Bun gates, and full Bun suites can exhibit the known loader-poisoning trio. This task's authoritative implementation gates are Rust; main integration reruns Bun with real dependencies.

## Done When

- The exact end-to-end NavBar fixture passes with no warning and retains its client island.
- Existing local static-map, runtime-map, helper, budget, and island-ISR tests remain green.
- No general ESM execution or ISR semantic change lands.
- The original consumer diagnosis is documented in the task outcome: framework gap fixed; client-only `Island` must omit `isr` (or explicitly add `ssr` if caching SSR HTML is intended).
