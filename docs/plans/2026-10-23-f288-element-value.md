# F288: an element-value model for `@radix-ui/react-presence` (design note, no code)

Status: proposal for Detoro's ruling and Mellow's soundness read. Owner of the row: Detoro (ledger F288, parked).
Author: Dew, 2026-10-23. Inputs: ledger F229/F288 (`m1a-followups.md:301,361`), `2026-10-14-shadcn-context-lowering.md` §4 and §8 (P1 is the path, P2/P3 rejected), the north star (compile libraries as published, never port).

## 1. What Presence does, and what each Radix caller needs

`Presence` (react-presence 1.1.11, `dist/index.mjs`) does four things in its body:

```js
const child = typeof children === "function" ? children({ present: presence.isPresent }) : React.Children.only(children)
const ref = useStableComposedRefs(presence.ref, getElementRef(child))
const forceMount = typeof children === "function"
return forceMount || presence.isPresent ? React.cloneElement(child, { ref }) : null
```

`usePresence(present)` is a `useReducer` state machine (F285 already compiles it), plus three refs, an effect and two layout effects that read `getComputedStyle(node).animationName` and listen for `animationstart`/`animationend`/`animationcancel` on the node. It gets the node through a `useCallback` ref that calls `setNode(node)`.

There are two call shapes in the packages we ship. Each needs a different subset of the gaps:

| caller | child | where the ref lands | needs |
|---|---|---|---|
| collapsible `CollapsibleContent` (and accordion, which renders it) | function: `({present}) => <CollapsibleContentImpl … ref={forwardedRef} present={present}/>` | Impl's root `div`, which is **always mounted** (`hidden={!isOpen}`) | E1-E5, G7, G9 |
| tabs `TabsContent` | function: `({present}) => <Primitive.div … />` | the `div`, always mounted | E1-E5, G7, G9 |
| checkbox `CheckboxIndicator`, radio-group `RadioIndicator` | **element**: `<Primitive.span … ref={forwardedRef}/>` | the `span`, mounted **only while present** | everything above + G5 |

With a function child, `forceMount` is true, so the output never depends on `isPresent` at render time. `isPresent` only flows into the child as a prop. That is why phase A below needs no runtime work.

## 2. The model: an element is a build-time record, never a runtime object

**Definition.** An *element value* `E` is a compile-time record `{ type, props, ref, key, children }`:
- `type` is a host tag or a resolved component.
- `props` and `ref` are IR expressions in the scope of the place that wrote the JSX.
- `children` is IR nodes.

It exists only during analysis of a **call-site-specialised** component. It is never printed to the chunk and never serialised. Every operation on it is folded at build time into ordinary IR: a `Node::Component` / `Node::Element`, its attributes and its `ref`. Anything the fold cannot finish is a named refusal on the caller, which keeps React. Valid React is never a build error.

**Where `E` comes from.** Only these sources, all known at the call site:
- (S1) The call site's children are exactly one JSX element (after dropping whitespace text): `E` is that element.
- (S2) The call site's children are one arrow `(args) => <JSX/>` with a single returned JSX expression. This is the render-prop path, extended to a function **between the tags** (today that falls to a `Slot(Raw)`, `jsx.rs:1923`). `children(x)` then yields `E` = the body with the parameters bound to `x`. This is B7 (`splice_render`) applied to `children`.
- (S3) A JSX literal in the specialised body.

**Operations,** each with React's semantics, folded in order:

| op | rule (React semantics) | refuses (fallback name) when |
|---|---|---|
| E1 `typeof children === "function"` | decided per call site: S2 → `true`, S1 → `false`; the other branch is dropped | children are neither S1 nor S2 (`children-read`, as today) |
| E2 `React.Children.only(children)` | S1 → `E`; React **throws** for zero or more than one child | not exactly one element (`children-only`): React's throw stays React's |
| E3 `children(args)` | S2 → `E`, with B7's argument rules (one object-literal argument, pure reads) | B7's refusals |
| E4 `React.cloneElement(E, config)` | new `E'` (React 19.3 `react.production.js` `cloneElement`): `props = {...E.props}` then every own key of `config` except `key`, `__self`, `__source`, and `ref` when `config.ref === undefined`; `ref` is a prop, so `E'.ref = E'.props.ref ?? null`; `key = config.key` (stringified) if defined, else `E.key`; extra arguments replace `children`. **No merging of handlers or `className`**: this is not the `asChild` Slot merge (`check_poly_component`). G6 is exactly this row. | `config` is not an object literal with static keys; a spread in `config`; `E.type` is a component whose props cannot take the new keys (same rules as a written attribute) |
| E5 `getElementRef(E)` (G8) | see §3 | §3 |
| E6 render `E'` | prints as if `<E'.type {...E'.props} ref={E'.ref}/>` were written at that place; a `ref` on a component goes through F267/B1 (`ref={cb}` on a Component) | whatever the written JSX would refuse |

A value escapes when `E` is stored in state or a ref, put in a list, passed to a non-specialised function, compared, or read by any property not listed in §3. When `E` escapes, the caller is refused with `element-value`. This mirrors the existing `jsx-const-child` rule (`placement.rs:1578`, `:1715`) and replaces it only for the operations above.

## 3. G8: `getElementRef` without a recogniser

The ledger rules out reading `child.props.ref` as a recogniser. I propose instead that the element record **has React 19's production element shape**, and that the existing constant folder evaluates the function's body as written over that shape.

React 19 production builds the element as a plain object (`react-jsx-runtime.production.js` `jsxProd`, React 19.3.0 as installed): `{ $$typeof, type, key, ref: props.ref ?? null, props }`, where `props` is the config without `key`. `ref` is a data property, and `props.ref` is the same ref as a data property. Development builds put warning getters on these; production does not. Brust serves the production semantics everywhere; it already does not run React's development-only checks.

Over that shape, `getElementRef` evaluates step by step, with no knowledge of the function's name or package:
1. `Object.getOwnPropertyDescriptor(element.props, "ref")?.get` is `undefined`, because a data property has no `get`.
2. So `mayWarn` is falsy, and the same holds for the second descriptor.
3. The function returns `element.props.ref || element.ref`, which is `E.ref`.

What has to be added is a **general** fold, used by any code that reaches these operations, never keyed on `getElementRef`:
- `Object.getOwnPropertyDescriptor(R, "k")` where `R` is an element record or its `props`: gives `{ value: <field>, writable: true, enumerable: true, configurable: true }`, or `undefined` for a missing key.
- Member read on such a descriptor or record.
- `"k" in v` and `&&`, `||`, `?.` over these values.

Any other operation on a record is `element-value`.

**This is the decision Detoro has to make (Q1).** The ledger line "skips the source's DEV branches" is true. My argument is that the DEV branches are not skipped by brust: they are *false in production React*, and the fold computes that from the object, not from the name. If this is still read as a recogniser, then G8 has no general rule, and Presence stays an island by the existing ruling.

## 4. The other gaps, made general

- **G7: B7 for non-Provider callees.** Today `splice_render` runs only inside `specialise()`, which needs `specialisable()` (non-empty `provides`). Proposal: a component that reads `children` only through E1-E5 is specialised per call site like a Provider. Same mechanism, same refusals, without the `provides` requirement. The ruled "ONE mechanism for B7" (R34.122-124) stays one mechanism; only its entry predicate widens. Mellow review item: specialisation of a component with **no** frame. The question is what makes two call sites share or not share a clone. Proposal: the clone key is the call-site content hash, as in F307 host clones.
- **G9: a render-time write to a ref** (`useStableComposedRefs`: `refsRef.current = refs` during render). Today this is `ref-in-render`. General rule: a render-phase write `r.current = v` is accepted iff nothing in render reads `r.current` and `v` is the same across renders (all its inputs are stable: `useCallback([])` results, build-folded `E.ref`, module constants). Then it is equal to `useRef(v)`, and it lowers to the initialiser. Otherwise `ref-in-render` stays.
- **G5: a callback ref on a node mounted by `x-if`** (needed only by the element-child callers). This needs a runtime change. Today the runtime `x-if` (`packages/runtime-dom/src/directives/if.ts`) inserts by cloning and binding, and removes with `current.remove()` only. `x-ref` registers its nulling on the instance (`directives/ref.ts`, `instance.ts:65`). Proposal: an `x-if` branch owns a cleanup list. Binds inside the branch register on it, and `remove()` runs it. The B1 desugar of a callback ref inside a branch then becomes "call `cb(node)` when the branch is inserted (after bind, before effects of that flush) and `cb(null)` (or the returned cleanup) when it is removed". That is React's attach/detach order for a conditionally mounted host. This is a general runtime feature (any `{cond && <div ref={cb}/>}` gains it, a shape that is refused today: `component.rs:961-967`), not a Presence feature. The size cost must be measured; budget ≤ 0.3 KB gzip in the always-loaded runtime, or lazy behind a flag the compiler sets.

Effects and hooks Presence needs that already compile: `useReducer` through a custom hook (F285/F286), `useCallback`, `useRef`, effects with DOM access in client JS. Two points to check:
- **(c1)** `getComputedStyle` in a native effect body is unconfirmed but is plain client JS.
- **(c2)** `useLayoutEffect` is printed as a plain `ctx.effect` (`lower/client.rs:422-440` ignores `layout`). For Presence this is not a correctness problem. The decision it makes (`UNMOUNT` vs `ANIMATION_OUT`) only delays removal, and with a function child nothing is removed at all. It does change when the effect runs relative to paint. I record it as a known difference, not a blocker (Q3).

## 5. Phases

- **Phase A (function child: collapsible, accordion, tabs).** E1-E4 + E6 for the S2 source, E5 (§3, if ruled), G7, G9. No runtime change.
  - Output for collapsible: Presence specialised at `CollapsibleContent`'s call site. The `usePresence` state lives in the clone. `CollapsibleContentImpl` is rendered with `present={isPresent}` and `ref={composed}`. The composed callback reaches Impl's root `div` through forwardRef (W5) and the B1 desugar on an always-mounted element.
  - Gate: the collapsible page has 0 islands, served first paint == React, and the Chromium toggle test (click, `data-state`, `hidden`, an exit animation keeps the content until `animationend`).
- **Phase B (element child: checkbox and radio indicators).** Phase A + E2 (S1) + G5 (runtime). Gate: indicator mount/unmount with and without an exit animation, `ref` attach/detach order versus React, and no leaked listeners after 20 toggles.
- Each phase is its own PR, gated once. Phase B does not start before phase A merges.

## 6. Fail-closed names (new)

- `children-only`: E2, the count is not exactly 1.
- `element-value`: an element record escapes, or an operation is not in §2 or §3.
- `clone-config`: E4 config is not a static object literal.

Existing names keep their meaning: `children-read`, `ref-in-render`, `ref-shape`, `jsx-const-child`. Battery rows, one per refusal and one per accepted shape:
- `Children.only` of 1, 0 and 2 children
- `cloneElement` with `{ref}`, with `{className}` (no merge), and with a spread config
- a stored element
- a function child between the tags
- a render-time ref write that is constant, and one that is not

## 7. Questions

- **Q1 (Detoro).** Is §3, a general fold over React 19's production element shape, acceptable for G8? If not, F288 closes as "Presence stays an island" and phases A and B do not start.
- **Q2 (Detoro).** Phase A first, as above? Phase B needs a runtime change (G5), which is general but adds bytes to the runtime.
- **Q3 (Detoro).** Is printing `useLayoutEffect` as a plain effect (c2) an accepted known difference for Presence, or does F288 need layout timing first (a separate row)?
- **Q4 (Mellow).** Soundness of G7's entry predicate: what decides that two call sites share a specialised clone, and can an `E` built at one call site leak into another clone?
- **Q5 (Mellow).** G9's "stable across renders" test: is the list (`useCallback([])`, build-folded `E.ref`, module consts) closed enough? In particular, is a forwarded ref from the caller stable when the caller is itself a clone?

## 8. Boundary (for the phase A PR)

- `analyze/passes/children.rs` (G7 entry, E1-E6 folds)
- `analyze/jsx.rs` (a function child between the tags as S2)
- `analyze/component.rs` (G9, B1 on the composed ref)
- the constant folder, for §3
- tests, battery rows, the shadcn scoreboard, generated docs

Not `packages/runtime-dom` (phase B only).
