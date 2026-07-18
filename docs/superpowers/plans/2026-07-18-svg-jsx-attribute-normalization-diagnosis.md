# Diagnose SVG JSX attribute normalization

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Establish a deterministic reproduction and root cause for native component inlining failures such as `unknown attribute rename viewBox`, then specify the complete SVG/JSX attribute-normalization behavior needed for an implementation task. This task is diagnosis-only: do not edit production or test files.

## Reading order

1. `crates/jsx-rust-compiler/src/lower.rs` around `rename_attr` and `lower_attr`.
2. `docs/superpowers/specs/2026-05-28-jsx-rust-compiler-phase-a1-design.md` section 4.5.
3. `runtime/cli/templates/minimal/components/Counter.tsx` as an existing SVG fixture.
4. Existing lowerer tests around `rejects_unknown_uppercase_attr`.

## Required diagnosis sequence

1. Reproduce deterministically with the smallest compiler-level test or existing command. Include at least `viewBox`, one camelCase SVG property that serializes to kebab-case (for example `strokeWidth`), and one case-sensitive SVG property that must preserve camelCase (for example `preserveAspectRatio` or `gradientUnits`).
2. Trace the path from JSX parsing through `lower_attr` to `UnknownAttributeRename`; enumerate tag/namespace context available at each step.
3. Falsify the narrow hypothesis "only viewBox is missing" by showing whether adding/accepting `viewBox` alone leaves another valid SVG attribute failing.
4. Separate valid attributes into behavior classes: HTML rename, SVG preserve-case, SVG kebab-case serialization, lowercase/data/aria passthrough, event/ref/key rejection, and genuinely unknown camelCase rejection.
5. Cross-reference every run in a task-note ledger. Conclude with the smallest robust implementation shape, affected files/symbols, regression cases, and commands.

## Constraints

- Preserve the existing event-handler, `ref`, and `key` precedence.
- Do not solve this with a `viewBox` one-off.
- Do not blindly lowercase SVG names; SVG contains case-sensitive attributes.
- Do not accept arbitrary camelCase names merely to suppress the diagnostic.
- No production edits or commits in this diagnosis task.

## Deliverable

A `READY` task note containing: exact repro, breadcrumb ledger, confirmed root cause, disproof of the one-entry hypothesis, recommended normalization data model, exact implementation boundary, and focused/full verification commands.
