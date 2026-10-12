# f97-effect-order: native `useEffect` runs before refs and handlers are bound

**RULED by lead Detoro 2026-10-13.** Source: Dew, site-hardening @e724934 (bb `gaps:docs-site` G9). Filed as F97.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 (latest at lane start) · flow: lane → PR → v2 → CI

## Bug

`packages/runtime-dom/src/mount.ts:28-29`: `mountHost` calls `inst.init(factory)`, which runs the component's mount effects, and only then calls `bindHost(inst, host, {})`, which binds `x-ref` and `x-on`. So in a native component:

- `ref.current` is `null` inside a mount `useEffect`, and inside `useLayoutEffect`.
- An effect that reads no signal never re-runs, so the component silently does nothing. The docs landing's CountUp and Histogram (`useRef` + `useEffect` + IntersectionObserver) never arm. The page still shows the final values, so nothing looks broken.

React's contract: during commit, refs are attached, then layout effects run, then passive effects run (after paint). Handlers are live before any effect runs.

## Fix

- `init` creates state, computeds and handlers but **queues** the component's effects. `bindHost` binds every directive, including `x-ref` and `x-on` and nested hosts as today. Then the queued effects run: layout effects synchronously after binding, passive effects after that (a microtask, or the same tick, whichever matches the existing passive-effect behaviour). The bar: `ref.current` is the element in both.
- Cleanup and dispose order is unchanged. An instance disposed before its effects flush never runs them.
- `x-if` and `x-for` binders that mount nested hosts during the initial pass follow the same rule per host: the child's refs are bound before the child's effects.
- No compiler change unless the compiler is what decides effect timing. If it is, keep the change in the emitted chunk's init contract and document it.

## Acceptance

1. Reproduction first, red on base: a runtime-dom test where a mount `useEffect` reads `ref.current` (expect the element, not null) and attaches a listener that a dispatched event then triggers. A `useLayoutEffect` variant too. A browser case: an IntersectionObserver-armed count-up (CountUp shape from `website/components/landing/CountUp.tsx` on docs-site) that animates.
2. Fix, then all green. An existing effect-ordering test that changes is listed and justified in READY.
3. Gates mirror ci.yml (cargo fmt/clippy/test, `bun run ci`, runtime-dom, server, battery, browser, cf). Then PR → v2 and CI green, reading conclusions.

## Tasks

| slug | tier | role | deps | review |
|---|---|---|---|---|
| `f97-effect-order` | standard | Implementer | — | complex |

Boundary: `packages/runtime-dom/`, `crates/brust-compiler/src/lower/client.rs` (only if init's effect contract lives there), `tests/browser/`, `tests/fixtures/`.
