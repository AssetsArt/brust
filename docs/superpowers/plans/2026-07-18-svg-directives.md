# SVG directives across the native runtime

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Make native behavior directives bind to SVG elements, including SVG subtrees, structural directives, dynamically added/removed SVG component hosts, and SVG-safe class binding. The fix must preserve HTML behavior, nested `x-data` ownership, shadow-root lifecycle, and existing author-facing behavior types.

## Confirmed diagnosis

`brustjs@0.1.63-alpha` is reproducibly wrong at the runtime seam. Commit `30f9ab9` adds three literal-DOM tests that each assert the target is an `Element` but not an `HTMLElement`; current production code produces exactly three failures while all 55 pre-existing tests pass:

- `<g x-show="flag">` remains visible because `bindTree()` stops at its `<svg>` ancestor.
- `x-on-click` on `<path>` never installs a listener.
- `x-bind-class` on `<use>` never writes its class.

The same `HTMLElement` assumption exists in `bindAdoptedNode()`, `collectSeeds()`, `observeRoot()`, and disposal paths. A dynamic SVG `x-data` host probe mounts zero times and disposes zero times. The native compiler is not involved in this runtime-only repro.

## Decisions

1. **Directive traversal is `Element`-wide.** `x-text`, `x-show`, `x-bind-*`, `x-on-*`, `x-if`, and `x-for` must work on HTML, SVG, and MathML elements when the underlying standard DOM API exists. Nested `x-data` remains a hard ownership boundary regardless of element namespace.
2. **Component hosts and lifecycle are `Element`-wide.** Initial scans, lazy-load remounts, the mounted weak map, MutationObserver added/removed nodes, disposal, keyed seeds, and structural clone bookkeeping all accept `Element`. This prevents SVG hosts and SVG-wrapped component subtrees from being skipped or leaked.
3. **Preserve existing TypeScript source compatibility.** Make `BehaviorCtx` and `Behavior` generic in their host element with `HTMLElement` as the default. `register()` accepts/internally erases the host generic for registry storage. Existing `BehaviorCtx`/`Behavior` annotations continue to mean HTML; SVG-root authors can opt into `BehaviorCtx<SVGElement>` or inference. Do not globally replace the public default with bare `Element`.
4. **`x-model` stays HTML-only.** It targets form-control properties. If encountered on a non-`HTMLElement`, warn once for that binding and skip it; do not install listeners or cast blindly.
5. **Class binding is namespace-safe.** `setBound(el, 'class', value)` keeps `className` for `HTMLElement`; every non-HTML `Element` uses `setAttribute('class', ...)` / `removeAttribute('class')`. This covers SVG's `SVGAnimatedString` and MathML without assignment.
6. **Property special cases are capability-sensitive.** `value` and boolean property reflection may write a property only when that property exists on the element; attribute presence/removal remains the namespace-neutral fallback. Generic attributes always use `setAttribute`/`removeAttribute`.
7. **No build warning fallback.** SVG is supported at runtime. Silent skipping is removed rather than documented as a limitation.

Rejected alternatives:

- Widen only the two visible walker guards: rejected because keyed x-for adoption and mutation lifecycle would remain silently broken.
- Change public `BehaviorCtx.el` directly from `HTMLElement` to `Element`: rejected because existing behavior code that reads HTML-specific members would become a source-level TypeScript regression.
- Warn and keep SVG unsupported: rejected because the required DOM APIs are available and SVG directives are normal UI behavior.

## Implementation map

Edit `runtime/native/runtime.ts`:

- Generalize `BehaviorCtx`, `Behavior`, registry storage, `mounted`, `scanAndMount`, `mountElement`, lazy-load pending queries, `bindTree`, structural directive element/bookkeeping types, keyed seed helpers, `bindAdoptedNode`, `bindIf`, `bindAttrs`, observation, disposal, and `setBound` to the settled `Element` boundary.
- Replace every traversal/mutation `instanceof HTMLElement` filter that currently drops SVG with `instanceof Element`.
- Keep `bindModel()` typed `HTMLElement`; guard it at `bindAttrs()`.
- Apply `x-show` through the element's standard inline style capability without narrowing traversal back to HTML.
- Preserve shadow-root recursion and nested `x-data` stops exactly.

Edit `runtime/native/runtime.test.ts`:

- Make happy-dom expose every global constructor used by new runtime guards.
- Turn the three tests from `30f9ab9` green without weakening their assertions.
- Add dynamic SVG `x-data` host mount + removal disposal coverage.
- Add SVG `x-if` toggle coverage.
- Add SVG keyed `x-for` seed adoption/reconcile coverage so `collectSeeds()` and clone bookkeeping cannot regress.
- Add non-HTML `x-model` warn-and-skip coverage if the implementation adds the settled warning branch.
- Retain all HTML tests unchanged.

## Gates

Run and observe:

1. `bun test runtime/native/runtime.test.ts`
2. `bun test runtime/`
3. `bun run ci`

Expected: all commands exit 0; the original three SVG failures are green; no existing runtime test regresses; no debug probes remain.

## Risk ledger

- Generic function variance can accidentally make existing `Behavior` annotations fail. Preserve `HTMLElement` defaults and keep the erasure internal to registry storage.
- `Element` does not statically expose every HTML/SVG style/property member. Use capability checks or narrow local casts; do not reintroduce an HTML-only traversal guard.
- Structural SVG clones must stay in the SVG namespace. `cloneNode()` preserves namespace; do not recreate via HTML parsing.
- MutationObserver callbacks receive arbitrary `Node`s. Widen only after an `instanceof Element` check; text/comment nodes remain ignored.
- A removed SVG host must dispose its own mounted instance and any descendant hosts exactly once.

