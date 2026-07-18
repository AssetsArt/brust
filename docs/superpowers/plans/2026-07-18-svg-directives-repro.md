# SVG directive runtime reproduction

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Turn the reported `brustjs@0.1.63-alpha` SVG directive failure into deterministic runtime regression tests without changing production code.

## Evidence and hypotheses

1. Most likely: `bindTree()` skips every non-`HTMLElement` child, so reaching an `SVGSVGElement` stops traversal of its entire subtree.
2. Separate defect: `setBound(..., 'class', ...)` assigns `className`, but SVG exposes `SVGAnimatedString`; the SVG-safe path is `setAttribute('class', ...)`.
3. Less likely: the native compiler strips SVG `x-*` attributes before runtime. A runtime test using literal DOM markup falsifies this compiler hypothesis while exercising the reported walker.
4. Less likely: happy-dom differs from browsers in SVG inheritance or style/event support. Assert the fixture nodes are `Element` but not `HTMLElement`, then exercise standard DOM APIs through the actual runtime.

## Work

Edit only `runtime/native/runtime.test.ts`.

- Add a failing test proving `<g x-show="flag">` beneath `<svg>` starts hidden and toggles visible when the signal changes.
- Add a failing test proving `x-on-click` on an SVG descendant invokes the registered method.
- Add a failing test proving `x-bind-class` on an SVG descendant sets and reactively updates the `class` attribute without throwing.
- Prefer one compact SVG fixture if failures remain individually attributable.
- Run the focused tests at least twice and record the exact failures. Do not edit `runtime/native/runtime.ts` and do not make the tests pass.

## Gate

`bun test runtime/native/runtime.test.ts` must fail only on the new SVG assertions, with the existing test suite otherwise green.

