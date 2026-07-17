# Native static-component compatibility investigation

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Explain every native-inline fallback in `/Users/detoro/code/ket-doc/landing/components`
for `NavBar`, `Hero`, `DocumentTypes`, `FlowSection`, `AccuracySection`,
`AutomationSection`, and `PricingSection`, then recommend the smallest generic
compiler feature set that lets ordinary static React components of these shapes
compile natively. Do not change source files in this task.

## Reproduction

Run `bun run build` from `/Users/detoro/code/ket-doc/landing/components`. The
signal is seven deterministic warnings of the form
`native component "<name>" not inlined: unsupported prop`.

## Reading order

1. `/Users/detoro/code/ket-doc/landing/pages/Home.tsx`
2. The seven component files named above
3. `crates/jsx-rust-compiler/src/lower.rs`, especially
   `try_native_inline`, `lower_component_inline`, expression lowering, and
   `.map()` lowering
4. Relevant tests in `crates/jsx-rust-compiler/src/lower.rs`

## Required evidence

- A component-by-component compatibility matrix listing the first failing AST
  construct and any later blocker that becomes visible after it is removed.
- Three to five ranked hypotheses and explicit disproof evidence for each.
- A recommended generic design, with rejected alternatives and rationale.
- Exact Rust and end-to-end regression tests needed to prove all seven become
  native while existing fallback behavior remains intact.

## Constraints

- Preserve React/TypeScript semantics for static literal data.
- Do not special-case Ket Doc component names or paths.
- Prefer compile-time evaluation only for a deliberately bounded literal subset;
  arbitrary JavaScript execution in the compiler is out of scope.
- Existing runtime-data `.map()` lowering and soft fallback contracts must remain
  compatible.
- No file edits; report conclusions through task notes prefixed `READY`.

## Gate

The lead can reproduce every claimed blocker from a minimal fixture or an
existing compiler test and can turn the recommendation into a zero-context
implementation plan.
