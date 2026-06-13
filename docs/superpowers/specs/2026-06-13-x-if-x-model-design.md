# x-if + x-model directives — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R11 — "x-* directives ครบชุด" before interactive template sections (carousel, accordion, mega-menu) without React islands. The documented v1 set (x-data/x-props/x-text/x-show/x-bind-*/x-on-*/x-for keyed+legacy) is complete and tested in 0.1.50; the real gaps are `x-if` and `x-model`, both former Spec-B non-goals. `x-html` stays rejected (XSS), `x-effect` stays behavior-only (`ctx.effect`).

## Goal

Two new directives in the native runtime (`runtime/native/runtime.ts`):

- **`x-if="path"`** — conditional MOUNT/UNMOUNT of an element (vs `x-show`'s display toggle): element is removed from the DOM when falsy, re-inserted (fresh clone, fresh bindings) when truthy.
- **`x-model="path"`** — two-way binding for form controls: writes element value into the instance signal on input, reflects signal changes back to the element.

## Non-goals

- `x-if`/`x-else` chains, `x-if` on `<template>` wrappers — single-element semantics only.
- `x-model` modifiers (`.lazy`, `.number`, `.trim`) — v1 raw value (checkbox → boolean, others → string value).
- Compiler/SSR awareness: BOTH directives are runtime-only in v1. `x-if` SSR-seeded markup renders the element; the runtime adopts it (no flash) — but the compiler does NOT emit `{% if %}` for it (authors who need SSR-conditional markup keep using inline conditionals; documented). `x-model` needs no SSR (form state is client-side).
- React-island interop changes; store API changes.

## Design

### `x-if`

Bind path semantics identical to `x-show` (reactive read via the same `read(instance, path)` resolution). Mechanism mirrors the keyed-x-for clone/anchor pattern already in the runtime:

- At bind time: insert a comment anchor `<!--x-if-->` before the element, capture the element as a template (clone), then evaluate:
  - truthy → element stays (adopted as-is, bindings continue into its subtree)
  - falsy → element REMOVED (subtree disposers run — same `disposeTree`/per-entry disposers discipline as keyed x-for)
- On reactive change: falsy→truthy re-clones the template, inserts after the anchor, binds the clone's subtree with fresh per-instance disposers (the `bindTree`-style walk used by x-for entries); truthy→falsy removes + disposes.
- Ordering/precedence (review-verified): `bindAttrs` has NO priority ordering today; `bindTree` short-circuits on `x-for` at its top (~159) before calling bindAttrs. Implement `x-if` as a SECOND early-exit in `bindTree` — and the x-if+x-for coexistence check must run BEFORE the x-for early-exit, else x-for preempts and the warn never fires. The x-if branch owns the element's binding lifecycle; per-mount clones bind via `bindTree(clone, childScope, freshDisposers)` — the exact `installKeyedReconcile` pattern (~349-359).
- Nested `x-data` inside an x-if subtree — DELEGATION DISCIPLINE (review-verified): the per-clone disposers cover only NON-x-data directive teardown (`bindTree` already skips nested x-data at ~167); nested x-data cleanup is delegated to the MutationObserver's `disposeTree` on removal (exactly like keyed x-for's `e.node.remove()`), and re-inserted clones' nested x-data mount via the observer's `scanAndMount`. Do NOT call `disposeElement` on nested x-data from x-if's own teardown — `disposeElement`'s `if (!m) return` guard makes a double call safe but the discipline is single-owner. The `<!--x-if-->` comment anchor is never in `removedNodes` for the element removal — safe.
- SSR falsy-initial ordering (pinned): capture the template clone FIRST, then run the initial effect — falsy removes the original (one-frame flash before JS is accepted, documented); truthy adopts the original in place WITHOUT re-cloning.
- `x-if` + `x-for` on the same element: REJECT loudly (console.warn, skip x-if, let x-for proceed) — compose by nesting (documented). Checked before the x-for early-exit per above.

### `x-model`

- Element kinds: `input[type=checkbox]` → boolean `checked`; `input[type=radio]` → writes its `value` when checked, reflects `checked = (signalValue === el.value)`; `select` → `value` (single only; multi-select rejected with warn); other `input`/`textarea` → string `value`.
- Write path: `input` event (text/textarea/select use `input`; checkbox/radio use `change`) → set the signal at `path`. NO generic path-writer exists (review-verified; x-on handlers mutate signals inside user methods). Implement `writePath(instance, path, value)`: **walk with intermediate-hop signal-UNWRAPPING like `read()` (~583-596) — `resolveRaw` does NOT unwrap intermediate signals and cannot be the base for multi-hop paths** — but do not call the leaf; `isSignal(leaf)` → `leaf.set(value)`, else warn once and skip. Signal `.set` with an equal value is a no-op (`Object.is` guard, signal.ts ~100) — confirmed loop-break.
- `select[multiple]`: reject at BIND time (`el.multiple` check) with one warn — never register the listener.
- Radio groups: each radio registers its own reflect effect evaluating `checked = (signalValue === el.value)` — group consistency falls out naturally; do not special-case.
- Read path: reactive effect reflecting signal → element property (guard: don't echo while the element is focused AND the value is identical — prevent cursor jumps; standard guard `if (el.value !== v) el.value = v`).
- Listener registration joins the element's disposer list (cleanup on unmount/SPA-nav, same as x-on).

### Docs + gap table

- `example/docs/content/native-interactivity.md`: directive table gains both rows; short examples (accordion via x-if; search box via x-model); the "what does not ship" list shrinks to x-html/x-effect-attr.
- `architecture.md` native section: directive enumeration updated.

## File structure

- `runtime/native/runtime.ts` — bindAttrs/bindTree integration + the two implementations
- `runtime/native/runtime.test.ts` — unit tests (happy-dom)
- `tests/native-directives.test.ts` — extend integration if it asserts directive behavior (check; it may only assert chunk serving — then units carry the weight)
- docs as above

## Behavior invariants

1. `x-if` falsy removes the element from the DOM (not display:none); listeners/effects of the removed subtree are disposed; re-insert is a FRESH clone (no stale state).
2. `x-model` never double-fires (set from input → effect reflect → no re-set loop: the reflect guard `el.value !== v` breaks the cycle; signal set-equal-value should already no-op — verify signal semantics).
3. Both directives respect existing disposal discipline (unmount via MutationObserver → no leaks; assert via the existing disposal test patterns).
4. Existing directives' behavior byte-identical (full runtime test suite green unchanged).
5. SSR adoption: an x-if element present in server HTML with a falsy initial value is removed on mount (correctness over flash-avoidance); truthy initial → adopted without re-clone.

## Tests (runtime.test.ts, happy-dom — follow existing patterns)

x-if: truthy initial adopted; falsy initial removed; toggle false→true→false (fresh clone each time — mutate the first clone, assert the second doesn't carry it); disposers of inner x-on/x-text run on unmount (reuse the existing disposal assertion helpers); x-if+x-for same element warns and skips; nested x-data inside x-if subtree mounts on insert (may need the observer active — follow how existing observer tests do it).
x-model: text input two-way (type → signal updates; signal.set → value reflects); checkbox boolean; radio group; select; no echo loop (spy on set count); focused-element guard; disposal removes listeners (no signal write after unmount).

## Acceptance criteria

`bun test runtime/native` green (existing + new), full `bun test` green (pre-existing fail exempt), biome green, docs updated. No Rust/compiler changes.
