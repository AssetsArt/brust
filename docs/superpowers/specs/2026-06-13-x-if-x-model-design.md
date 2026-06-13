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
- Ordering/precedence: `x-if` is processed BEFORE other directives on the same element (an unmounted element must not register x-on listeners etc.) — in `bindAttrs`/`bindTree`, check `x-if` first and let it own the element's binding lifecycle (other directives on that element bind inside the per-mount pass, like x-for clones do).
- Nested `x-data` inside an x-if subtree: same rule as today's bindTree (stop at nested x-data; MutationObserver mounts it on insert — verify the observer picks up re-inserted subtrees: it watches document.body childList+subtree, so yes; the re-inserted clone's nested x-data mounts via the observer, and disposeTree handles removal).
- `x-if` + `x-for` on the same element: REJECT loudly (console.warn, skip x-if) — compose by nesting (documented).

### `x-model`

- Element kinds: `input[type=checkbox]` → boolean `checked`; `input[type=radio]` → writes its `value` when checked, reflects `checked = (signalValue === el.value)`; `select` → `value` (single only; multi-select rejected with warn); other `input`/`textarea` → string `value`.
- Write path: `input` event (text/textarea/select use `input`; checkbox/radio use `change`) → set the signal at `path` on the instance — REUSE the existing path-write mechanism if one exists (check how x-on handlers mutate state: methods mutate signals directly; there may be no generic path-writer — implement `writePath(instance, path, value)` resolving like `read` but setting the final signal `.set(value)`; if the final hop is not a signal, warn once and skip).
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
