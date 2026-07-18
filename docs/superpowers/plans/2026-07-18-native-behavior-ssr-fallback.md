# Native behavior survives SSR-component fallback
<!-- conclave-plan:v1
{
"owner":"0ddb11d0-954b-4710-90ce-8191a46fe3c3","authority":"in-loop",
"planPath":"docs/superpowers/plans/2026-07-18-native-behavior-ssr-fallback.md","baseSha":"68b878afe25698511b1925bb429b317b0fe03295","escalation":"0ddb11d0-954b-4710-90ce-8191a46fe3c3",
"readingOrder":["docs/superpowers/plans/2026-07-18-native-behavior-ssr-fallback.md","docs/superpowers/specs/2026-06-03-native-interactivity-directives-design.md","example/docs/content/native-interactivity.md","crates/jsx-rust-compiler/src/lower.rs","runtime/islands/native-render.ts"],
"boundary":["crates/jsx-rust-compiler/src/emit_factory.rs","crates/jsx-rust-compiler/src/ir.rs","crates/jsx-rust-compiler/src/lib.rs","crates/jsx-rust-compiler/src/lower.rs","docs/superpowers/plans/2026-07-18-native-behavior-ssr-fallback.md","example/docs/content/native-interactivity.md","example/docs/content/rendering.md","runtime/cli/native-routes-emit.ts","runtime/islands/native-render.test.ts","runtime/islands/native-render.ts","tests/fixtures/app/NativeInline.tsx","tests/fixtures/app/components/BehaviorSsrFallback.tsx","tests/native-inline.test.ts","types/islands/isr-jsx.d.ts"],
"consumes":["crates/jsx-rust-compiler/src/lower.rs#try_native_inline","runtime/islands/native-render.ts#resolveComponentContext","runtime/native/runtime.ts#start"],
"produces":["docs/superpowers/plans/2026-07-18-native-behavior-ssr-fallback.md#Done When","tests/native-inline.test.ts#behavior SSR fallback regression"],"gates":["test -f tests/fixtures/app/NativeInline.tsx","cargo fmt --all --check","cargo clippy --workspace --all-targets --locked -- -D warnings","cargo test -p jsx-rust-compiler --locked","bun test runtime/islands/native-render.test.ts","bun test tests/native-inline.test.ts","bun test runtime/native/","bun run ci"]
} -->

## Goal

Make a behavior-bearing component remain interactive when a `native` inline attempt soft-falls back to an SSR-component slot. Inline eligibility may affect performance, never the presence of the behavior mount host.

## Non-goals

- Expanding inline-lowering support for `Array.from(...)` or referenced constants.
- Changing the public `behavior` API, directive chunk naming, or directive event semantics.
- Adding wrappers around SSR components or making the directive runtime depend on React.
- Treating documentation or a stronger warning as sufficient when the behavior can be wired correctly.

## Decisions

- Diagnose through the real native build and SSR-component render path before selecting a correction seam.
- Treat inline eligibility as a performance concern; behavior mount correctness is invariant across inline and SSR fallback paths.
- Do not mutate production code until the RED reproduction and strongest-hypothesis falsification are recorded.

## Interface

The diagnosis phase changes no public interface. The eventual fix must preserve `export const behavior`, `x-data`, `x-behavior`, `x-on-*`, and directive chunk naming exactly as documented.

## Ordered edits

1. Add the dedicated behavior fallback fixture and route usage.
2. Add the deterministic build/SSR regression assertion and observe it fail twice.
3. Trace and falsify the fail path, then stop at `DIAGNOSIS READY`.
4. After Aoki amends this plan with a recorded correction seam, implement the fix, extend all three regression variants, update docs, and run every header gate.

## User-observed failure

For behavior components whose template cannot be inline-lowered (`Array.from(...).map`, referenced computed const, referenced literal const), build emits the directive chunk and server HTML retains `x-on-*`, but rendered HTML lacks the auto-injected `x-data`. The directive runtime scans only `[x-data]`, so it never imports the chunk or installs listeners. The build emits only a generic inline-fallback warning.

## Debug protocol

Apply the four-step debug mantra in order. Do not edit production code before the deterministic regression test is observed red.

### Phase 1 — deterministic reproduction

1. Add a dedicated fixture component with `export const behavior`, an author-omitted `x-data`, an `x-on-*` directive, and an `Array.from({ length: 2 }).map(...)` expression that forces the established soft SSR fallback.
2. Use it with the `native` marker from `tests/fixtures/app/NativeInline.tsx`, the component registered by the fixture route table.
3. Extend `tests/native-inline.test.ts` to prove all four facts at the built seam: the warning identifies the inline failure; the component is a `comp_N_html` SSR slot; the matching directive chunk exists; the final server/built behavior host lacks its canonical `x-data` while retaining `x-on-*`.
4. Run the smallest deterministic test twice and record both red results as task gates/notes.

### Phase 2 — fail-path trace

Trace the exact path from directive-name discovery through `try_native_inline`, SSR IR/factory emission, `resolveComponentContext`/`renderToString`, and runtime `[x-data]` scanning. List branch knobs: explicit vs implicit native attempt, inline success vs each soft-fallback reason, author-supplied vs auto-injected `x-data`, single root vs marker host, and SSR render failure.

### Phase 3 — falsification

After reproduction, file a task note with 3–5 ranked hypotheses and a disproof for each. Run the strongest disproof first. The leading hypothesis is not accepted unless it explains every breadcrumb, including why `x-on-*` and chunks survive while `x-data` does not.

### Phase 4 — ruling checkpoint

Stop after diagnosis and send `DIAGNOSIS READY` with the failing test SHA, breadcrumb ledger, fail path, falsification result, and the narrowest viable correction seam. Aoki will amend this canonical plan and rule the implementation before any production edit.

## Implementation

Implementation is intentionally gated on the Phase 4 ruling checkpoint. The amended plan will name the exact IR/runtime seam, invariants, and production edit order after the deterministic evidence selects it.

## Constraints

- Correctness must not depend on inline-lowering capability.
- Preserve author-supplied literal `x-data` and the existing `x-behavior` host precedence.
- The canonical directive name remains `directiveName(sourcePath, projectRoot)` and must match the emitted chunk filename.
- No generic DOM string post-processing that can inject into the wrong root or nested `x-data` scope.
- No documentation-only or warning-only closure if a sound runtime/compiler seam exists.
- Keep the directive runtime React-free.

## Risks

- Injecting at the SSR call site instead of the rendered component root could create an empty wrapper, change DOM/CSS semantics, or bind the wrong subtree.
- Injecting into arbitrary `renderToString` HTML after the fact risks fragments, multi-root output, comments, escaping, and nested behavior ownership.
- Carrying directive identity through IR/factory metadata may require every component collection/emission walk to remain source-order aligned.
- Author-written `x-data` inside an opaque SSR component must continue to win without duplication.

## Rejected alternatives

- Warning-only or documentation-only closure: rejected because it preserves a silent correctness failure.
- Failing every non-inline behavior component: reserved only if diagnosis proves no sound wiring seam exists.
- Generic rendered-HTML string injection: rejected because fragments, wrappers, and nested behavior scopes make root ownership ambiguous.

## Authority and Roles

- Aoki owns diagnosis acceptance, architecture choice, plan amendments, integration, and final release recommendation.
- Dabin owns the deterministic repro and fail-path/falsification evidence, then implementation only after Aoki's recorded ruling.
- Armin performs read-only review after the fix is ready.
- Authority is in-loop.

## Escalation

Design/spec conflicts are filed as task challenges and ruled by Aoki. Dabin owns implementation choices inside the amended plan. Genuine scope expansion, external publishing, or irreversible actions go to the human.

## Verification

- Boundary guard credited to Dabin: `test -f tests/fixtures/app/NativeInline.tsx` prevents the stale route-component path from surviving another plan handoff.
- RED phase: run the smallest `tests/native-inline.test.ts` name pattern twice and record both failing gates.
- Focused GREEN: `cargo test -p jsx-rust-compiler --locked`, `bun test runtime/islands/native-render.test.ts`, and `bun test tests/native-inline.test.ts`.
- Final gates: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `bun test runtime/native/`, and `bun run ci` in addition to the focused gates.

## Done When

- Cases equivalent to `Array.from(...).map`, referenced computed const, and referenced literal const retain the canonical `x-data` when a behavior component falls back to SSR rendering.
- The rendered host retains `x-on-*`; the runtime finds it, loads the matching directive chunk, and installs the listener.
- Inline-success behavior remains unchanged and author-supplied `x-data` still wins.
- A regression test exercises the real native build + SSR-component path, not only a helper.
- Documentation describes inline limitations as performance constraints rather than interactivity correctness hazards.
- All header gates pass at the final implementation SHA.
