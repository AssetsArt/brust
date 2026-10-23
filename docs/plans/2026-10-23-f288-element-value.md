# F288: an element-value model for `@radix-ui/react-presence` (design note, no code)

Status: Q1-Q3 ruled (§9, Detoro 2026-10-23); Q4-Q5 REVIEW-PASS by Mellow (42291d86) with binding amendments A1/A2, written into §4. Owner of the row: Detoro (ledger F288, parked).
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

- **G7: B7 for non-Provider callees.** Today `splice_render` runs only inside `specialise()`, which needs `specialisable()` (non-empty `provides`). Proposal: a component that reads `children` only through E1-E5 is specialised per call site like a Provider. Same mechanism, same refusals, without the `provides` requirement. The ruled "ONE mechanism for B7" (R34.122-124) stays one mechanism; only its entry predicate widens.
  - **A1 (Mellow 42291d86, binding): the clone key.** The G7 entry calls `specialise()` itself, with the same key: site (module path + `spec_salt`, the enclosing clone's id) + `clone_site(carried + rebased nodes, render prop)` (F238) + loc (`children.rs` :3552-3560). It is NOT a content-only hash, and NOT the F307 host-clone key (that one is site + loc only: `"{c_path}#{exp}~host~{site}~{loc}"`). Reason: `pinned()` bakes per-call-site `fixed_props` into the clone (:3536), and those are not in the hash. Two call sites with equal content but different pins would share one clone that carries the first site's pins. Instance and job records are per id, too.
  - Sharing happens only at lowering, through R34.124's equal-chunk factory dedup, never at analysis.
  - `E` cannot leak across clones, given three things: (a) `E` is built only inside the `compile_specialised` closure, after `splice_render` / `splice_children`, so every `E` field is a name the clone owns or a Carry hidden input; (b) the hash covers the S2 arrow body through `render`; (c) a G7 clone nested in another clone is salted by `spec_salt` (:105), so `CollapsibleContent`'s Presence site gets one clone per enclosing host or Provider clone, not one per library file.
  - Kept unchanged: `!cir.specialised` (a clone is never re-specialised), and the F374 refusals (children carried by a spread or by the `children` prop).
  - Phase A tests that pin A1:
    - two call sites of one G7 component with byte-equal children but different pinned props (one fixed, one client-changing): two distinct clone ids, and the right paint per site;
    - one call site inside a list: one clone, with per-row values through hidden inputs.
  - Widening the entry creates one clone per call site for EVERY component that reads children only through E1-E5, not just Presence. The phase A READY reports the clone count and chunk bytes on battery, shadcn and website.
- **G9: a render-time write to a ref** (`useStableComposedRefs`: `refsRef.current = refs` during render). Today this is `ref-in-render`. Native has no re-render that would redo the write: it runs once, at instance setup. So "equal to `useRef(v)`" holds only when `v` cannot change after the instance is created.
  - **A2 (Mellow 42291d86, binding): the closed rule.** A render-time write `r.current = v` lowers to the `useRef` initialiser iff ALL of these hold:
    1. `r` is a `useRef` of this component (after custom-hook inlining).
    2. The write is ONE unconditional top-level statement of the render body. There is no other write to `r` in render, and no read of `r.current` in render, including through a function called during render.
    3. `r` does not escape: it is not passed as a prop, returned or stored. Its `.current` is read only inside callbacks, effects or handlers.
    4. `v` is built only from stable leaves, through array or object literals (identity is not observable under 2 and 3). Stable leaves are:
       - literals and module constants;
       - `useRef` bindings;
       - `useCallback` / `useMemo` with `[]` deps, setters, and `dispatch`;
       - a `useCallback` whose deps are all stable leaves;
       - a prop of the clone that is in `fixed_props` (pinned: its call site never changes it on the client) and whose call-site expression is itself a stable leaf. This is checked recursively through Carry hidden inputs, depth-bounded, and fails closed.
       - **(ruling 255806ff, Detoro 2026-10-23, on Dew's challenge)** `o.k` is stable iff `o` is a const local of this component whose initialiser is an object literal with static keys only (no spread, computed key, getter or method), `o` is never written (`o.k = ...`, `delete`) and never escapes (rule 3 applied to `o`), and the field's value is itself stable; anything else fails closed.
       - **(ruling 255806ff)** a logical expression `A || B`, `A ?? B`, `A && B` is stable iff EVERY operand is stable, because its value is always one of its operands; this covers `A || (A ?? null)` (the §3 fold of `getElementRef`) without a peephole. No other operators (no calls, arithmetic, comparisons or ternaries).
  - `E.ref` counts as stable only through these rules, never as a category of its own. Anything else stays `ref-in-render`.
  - **Forwarded refs in the element (ruling 70370f98, Detoro 2026-10-23, on Dew's challenge).** `E.ref` of an S1/S2 element whose `forwarded_ref` is set is the CALLER's forwarded ref, carried into the clone as the hidden input `__fwd_ref`; it never means the clone's own forwarded ref. `__fwd_ref` is stable exactly like A2 rule 4's pinned-prop leaf: iff the caller's call site passes no ref (folds to `null`), or a `useRef` binding, or a `[]`-deps `useCallback`, AND no spread at that call site may carry a ref; propagated per component like `stable_props` (`fwd_ref_stable`). Anything else is `ref-in-render`. The `useRef` case is aimed for phase A (A2 test "collapsible with a `useRef` ref (native)"); if it is not reachable, that test asserts the refusal, the READY names it, and it becomes row F401 (a forwarded `useRef` ref through a Presence clone refuses; fail-closed). `cloneElement` still REPLACES the ref with the composed callback (React 19); the forwarded ref is reached only through G9's refs array.
  - A forwarded ref from a clone caller is stable only when the app's ref is absent (it folds to `null`), a `useRef` object, or a `[]`-deps callback, AND the prop is pinned. An inline arrow ref is not stable, so `ref-in-render` applies. (React attaches once with the render-1 refs, because `useStableComposedRefs`'s callback has `[]` deps. Only the no-cleanup detach reads the latest refs, :155-160. Refusing is right.)
  - Phase A tests that pin A2:
    - collapsible with no ref (native);
    - collapsible with a `useRef` ref (native; `ref.current` is the `div` after mount, and `null` after unmount where that applies);
    - collapsible with an inline arrow ref (`ref-in-render` refusal);
    - a G9 battery pair, both refusing: a conditional write, and a write whose `v` is a non-pinned prop.
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
- **Q4 (Mellow; answered by A1 in §4).** Soundness of G7's entry predicate: what decides that two call sites share a specialised clone, and can an `E` built at one call site leak into another clone?
- **Q5 (Mellow; answered by A2 in §4).** G9's "stable across renders" test: is the list (`useCallback([])`, build-folded `E.ref`, module consts) closed enough? In particular, is a forwarded ref from the caller stable when the caller is itself a clone?

## 8. Boundary (for the phase A PR)

- `analyze/passes/children.rs` (G7 entry, E1-E6 folds)
- `analyze/jsx.rs` (a function child between the tags as S2)
- `analyze/component.rs` (G9, B1 on the composed ref)
- the constant folder, for §3
- tests, battery rows, the shadcn scoreboard, generated docs

`packages/runtime-dom`: `signal.ts` and the effect API only (ruling 94404307, post layout effects); the rest of it stays phase B.

## 9. Lead ruling (Detoro, 2026-10-23)

- **Q1: ACCEPTED, with a guard.** The §3 fold is a general rule, not a recogniser: it evaluates the library's body as written over a modelled object, and no name or package is keyed. This does NOT reverse the F288 ruling: reading `child.props.ref` directly (bypassing the source) stays ruled out. Why it is sound: for the element shapes React actually builds, every branch of `getElementRef` returns the same ref (production: data properties, falls to `props.ref || ref`; development: warning getters, which pick the other field, which holds the same ref). Guard (required in phase A): a differential test that imports the installed `@radix-ui/react-presence` source's `getElementRef` and runs it on real elements built by `react/jsx-runtime` in BOTH production and development builds, asserting it equals the fold's `E.ref` for: a callback ref, an object ref, no ref, and a `forwardRef` component child. The modelled shape is React 19's; when the project resolves a React major other than 19, the fold refuses with `element-value`.
- **Q2: Phase A first**, as in §5. Phase B (G5, runtime) starts only after phase A merges, and only with a measured runtime cost of ≤ 0.3 KB gzip in the always-loaded runtime; over that it goes behind a compiler-set lazy feature.
- **Q3: ACCEPTED as a known difference for Presence** (the timing only delays removal; with a function child nothing is removed). Recorded as its own ledger row F390 (layout effects print as plain effects, so they run after paint, not before it). Phase A does not wait for it.
- **Q3 AMENDED (ruling 94404307, Detoro 2026-10-23, on Dew's challenge; credit Dew).** The premise above was wrong: Dew's served probe (real react-presence 1.1.11) showed the layout effect reading computed style before the bindings of the same change apply, so `UNMOUNT` fires and an exit animation never holds. The narrow part of F390 is IN phase A: `EffectDecl.layout` prints `ctx.effect(fn, true)`; the runtime runs a post effect's re-runs after the current flush has drained (after every DOM binding of that change), synchronously, before paint; passive effect timing is unchanged; first-run order stays as F97 (effects after `bindHost`). Budget: runtime growth ≤ 0.15 KB gzip (`packages/runtime-dom bun scripts/size.ts --check`). Tests: the served exit-animation test (present held until `animationend` == React), a runtime post-ordering unit test, and a control where a passive effect keeps today's timing. F390 is narrowed at integration to what remains.
- **Q3 AMENDED AGAIN (ruling 94404307 amended, Detoro 2026-10-23, on Mellow F1 5df8bf50).** Keeping passive effects in the binding flush while layout moved after it inverted React's order (a passive effect read what the layout effect had not written yet). On a re-run the order is React's commit order: (1) every DOM binding of the change, (2) compiled `useLayoutEffect` re-runs, (3) compiled `useEffect` re-runs, each tier in declaration order; first runs stay as F97. Implemented as two post tiers after the bindings (not by marking passive as layout). Tests: Mellow's `le.tsx` shape as a runtime unit test and served (layout writes, passive reads == React), next to the post control; a binding read by a passive effect still sees the new DOM. Budget: total runtime growth for phase A ≤ 0.15 KB gzip. F390 keeps only "passive runs before paint where React runs it after" (low).
- **Q4, Q5: Mellow design review before phase A code.** Phase A code waits for Mellow's PASS on G7's clone key/leak question and on G9's stable-input list.
- **Phase A gate, amended:** Presence no longer refuses at `CollapsibleContent` and `TabsContent` (first refusal moves past Presence or the page goes native), served first paint == React, and the Chromium toggle test from §5. "Collapsible page has 0 islands" is the chain's goal; it is this PR's gate only if F380/F382 have landed first.
- **Order for Dew:** F388 round 3 → F384 restack (after F388 PASS) → F288 phase A (after Mellow PASS on Q4/Q5).
