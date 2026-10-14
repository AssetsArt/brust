# shadcn S2 — lane `context-lowering` (wave A of the Radix non-overlay compounds) (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Tiësto (proposed) · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: next free F-number (F168 or later; F166/F167 are hardening-batch)

Author: Tiësto. Status: **DRAFT, awaiting the lead's ruling; no lane started.** Base: origin/main 690670e9 (2.0.0-alpha.9). R-numbers: **R34.100–R34.115** (the lead's range; R34.88–R34.99 are F149 and the lanes before it). Evidence: the task `radix-compounds-spike` (a long note; the lead's rulings on it are on that task: bubble input kept with a native event, Presence kept as a small feature, wave A first), `docs/shadcn-coverage.{md,json}` at this base, and the original TypeScript of each Radix package, read from its source map. Anything I did not run is marked **[verify]** and is step 0 of the lane.

## 1. What this lane buys, and what it does not

Wave A is the six compounds whose whole difficulty is a React context plus simple state: progress, toggle, switch, checkbox, collapsible, avatar. Today each page ships 85–91 KB gzip (react + react-dom + the Radix leaf bundle), 531 KB for the six. The spike's estimate if they compile: about 0–6 KB each, so about **−500 KB**; the only measured anchor is the `label` page (a compiled Radix leaf), 4 KB in total. The estimate has to be re-measured on the first page that flips (R34.115).

| Page | JS today | Components in the Radix package | What it needs beyond context |
|---|---|---|---|
| progress | 85 KB | Progress (Provider), ProgressIndicator (consumer) | nothing: both props are constants on a page |
| toggle | 87 KB | Toggle (no context) | `useControllableState` |
| collapsible | 89 KB | Collapsible (Provider + state), Trigger, Content (+ Presence) | `useControllableState`, `useId`, Presence |
| switch | 89 KB | SwitchProvider (state), SwitchTrigger (button, effect), Thumb, BubbleInput | controllable state, a form-reset effect, bubble input |
| checkbox | 91 KB | same shape + Indicator (Presence) | as switch + Presence |
| avatar | 87 KB | Avatar (Provider + status state), AvatarImage (effect + `new Image()`), AvatarFallback (delay) | image status behaviour |

Not in this lane: tabs, accordion, radio-group (roving focus + collection: wave B), slider (stays an island), every overlay. `direction` (69 KB) is also a context (`DirectionProvider`) and falls out of the same feature; it is in the proof table but has no ruling of its own.

## 2. The finding that shapes the design

The S0 survey's `hook-unsupported` on these packages (33 components) is exactly the 33 components that call a scoped context hook (`use*Context` from `createContextScope`). Every other hook they use (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useLayoutEffect`) is already read. **Context is the blocker.** And brust already has, on both sides, the one primitive a context needs:

- Compiler: a child instance gets its props from the parent by **binding** (`PropBinding::Expr` for an inlined static child; linked props or an `x-props-bind` for a native child), resolved when the child is lowered at its call site.
- Runtime: `x-props-bind="member"` on a child host rebinds the child's `props` signal reactively to the member of the **nearest ancestor host** (packages/runtime-dom README, `test/ref-props-bind.test.ts`: three levels, late-arriving parent chunk, no ancestor warns and keeps the seed). That is "inject from the closest provider", already shipped and tested.

So a context is **an implicit prop, threaded lexically**: the consumer reads `useXContext()` as `props.__ctx_X` (hidden, never printed as an attribute), and the call site fills it from the nearest `Provider` frame on the lowering stack. No new runtime feature for the context itself.

## 3. Design (recommended)

### 3.1 Recognising a context (R34.100, R34.101)

A context has two shapes in this code:

1. React's own: `const C = createContext(default)`, `<C.Provider value={…}>`, `useContext(C)`. Generic; already named by the spec.
2. Radix's `createContextScope(NAME)` from `@radix-ui/react-context`: `const [createX, createXScope] = createContextScope(NAME)`; `const [XProvider, useXContext] = createX(NAME)`; the Provider takes the value fields as **props** (`<XProvider scope={…} open={…} onOpenToggle={…}>`) and the hook is `useXContext(NAME, __scopeX)`.

Shape 2 is a factory call, not a component, so it cannot be analysed as written (it builds components in a closure). It is recognised **structurally, as `Primitive` is** (package-leaf plan R34.65): the exact call shape and the two destructured bindings, from the package `@radix-ui/react-context` (checked by the package-source integrity check, R34.62, so a changed shape is an island). It is **one** recogniser for a generic API, not a per-primitive one, so the package-leaf Risk 1 gate holds. The scope argument (`__scopeX`) is nesting disambiguation across two providers of the same name; v1 requires it to be absent or a pass-through of the component's own scope prop and fails closed otherwise (`context-scope`).

### 3.2 Provider frames (R34.102)

A component whose return renders a Provider **declares** a frame: `provides = [{ context, value: { field → member or constant } }]` and where its children land (inside the Primitive element, as in Collapsible). When the **page** lowers a call to that component, the frame is pushed for the lowering of the children passed to it, exactly as `lower_nodes` already scopes `Env` for list rows. A consumer instance met inside a frame receives the frame's value as its hidden prop; with no frame it receives the context's default when the default is constant, else the build keeps the consumer in React (`context-no-provider`).

The value of a frame is a set of **members of the Provider's own instance**: `open` (the controllable state), `onOpenToggle` (a handler), `contentId` (a `useId` slot), `disabled` (a prop). The Provider component is native when any of them is reactive or a handler, and static when all are constants (progress: `value` and `max` are page constants, so the whole tree is static, 0 JS).

### 3.3 Consumers (R34.103, R34.104)

- **A static consumer** (no state, effect or ref of its own: ProgressIndicator, SwitchThumb, CheckboxIndicator without Presence, CollapsibleTrigger) is inlined as today; `context.open` is replaced by the frame's member expression, the same substitution an inlined child's props already get. Its `data-state`, `aria-expanded`, `aria-controls` become the existing `x-bind-*` bindings against the provider's members. The runtime binds them because they are DOM descendants of the provider's host and not inside a nested host.
- **A native consumer** (own state, effect or ref) is a nested host that binds the frame with `x-props-bind` to a `computed` member of the provider. Used for AvatarImage. A consumer that is a nested host *and* needs the provider's setter (AvatarImage reports its loading status) calls a function that travels in the context value: functions pass through `x-props-bind` (tested).
- **`composeEventHandlers(props.onClick, context.onOpenToggle)`** lowers to a handler that calls the user's handler then the context's. v1 supports an absent user handler and a **static** user handler (the S1.3 hoist); a user handler that is a page function or reads page state fails closed (`context-handler`), a follow-up of F150.

### 3.4 The hooks the Providers use (R34.105, R34.106)

- **`useControllableState`** (react-use-controllable-state, 97 lines + a reducer variant) is a plain custom hook: controlled `prop`, else internal state seeded from `defaultProp`, and `onChange`. It is inlined by the custom-hook machinery (G3, `c-custom-hook`), after package-source (F153c step 2) reads it. v1: the uncontrolled case plus a **constant** `open`/`checked` prop; a controlled prop that changes at run time, or an `onChange` that is a page function, fails closed (`controlled-state`). shadcn pages use `defaultOpen`, `defaultChecked`.
- **`useId`**: the existing `use_id_slots` (the compiler's `useId` slots). Nothing new.

### 3.5 Presence (R34.107) — kept as a small feature, as ruled

`Presence` (react-presence, 280 lines + a state machine) mounts its child while `present`, and on `present → false` waits for the CSS exit animation (`getComputedStyle().animationName`, `animationend`) before removing it. Lowered as a runtime feature module `presence` (own module, under the runtime's ≥ 1 KB rule; **estimate** 1–1.5 KB gzip): `x-presence="member"` is `x-if` with a deferred removal: server HTML omits the element when not present (unchanged), the clone is inserted when present, and on false the node stays until its animation ends (no animation: removed at once). It is not a recogniser of one primitive: any `<Presence present={expr}>{child}</Presence>` from `@radix-ui/react-presence` with a single child element lowers to it, and `forceMount` keeps the element. Used by CollapsibleContent and CheckboxIndicator. If a Content is not animated, behaviour equals `x-if`; the feature only matters for exit animations.

### 3.6 Bubble input and form reset (R34.108) — kept, with a native event, as ruled

The Switch/Checkbox `BubbleInput` is a hidden `<input type="checkbox">` mirroring the state for form submission; its effect sets `checked` through the prototype setter and dispatches a bubbling `click` event when the state changes, so a form library sees the change. The compiled version keeps both: the hidden input is a normal element (`x-bind-checked`), and the effect lowers to the component's behaviour as an effect with an `x-ref` and a DOM call, the shape `useEffect` + `ref.current` that the native tier already supports **[verify: the effect body uses `Object.getOwnPropertyDescriptor(...).set.call` and `dispatchEvent(new Event('click', { bubbles: true }))`, which are DOM globals inside an effect; the S0 `browser-global` rule fires for render-time reads, not effects]**. `SwitchTrigger`'s effect (listen to the form's `reset`) is the same shape. Both live in the provider's host, because the trigger and the bubble input are inlined under it.

### 3.7 Avatar (R34.109)

`AvatarImage`: state `status` in the Avatar provider, an effect that creates `new window.Image()` and reports `loaded`/`error`, and renders the `<img>` only when `loaded`. `AvatarFallback`: shown unless loaded, after an optional `delayMs`. The SSR output of React (status `idle`: no image, fallback shown) equals the compiled server output, so first paint matches. Wave A includes avatar if step 0 proves the effect lowers (the `new Image()` is a client-only effect body); otherwise it moves to wave A2 with a ruling.

## 4. Requirements (R34.100–R34.115)

- **R34.100 Context shapes.** React `createContext`/`Provider`/`useContext` and the structural recognition of `createContextScope` (§3.1), each from its package, checked by R34.62.
- **R34.101 Scope argument.** Absent or the component's own pass-through; anything else is `context-scope`, an island.
- **R34.102 Provider frames.** `provides` on the component IR; frames pushed while lowering the children passed to a Provider component; consumer outside any frame: default if constant else React (`context-no-provider`).
- **R34.103 Static consumer.** Inlined; `context.x` is the frame's member expression; first paint equals the React build's HTML (R34.3).
- **R34.104 Native consumer.** A nested host with `x-props-bind` to a computed member of the provider; functions in the value pass through.
- **R34.105 `useControllableState`.** Inlined as a custom hook (uncontrolled, or a constant controlled prop); else `controlled-state`.
- **R34.106 `useId`.** Existing slots; the value is a frame member.
- **R34.107 Presence.** Runtime feature `presence`, `x-presence`, single child, `forceMount`; budget ≤ 1.5 KB gzip; loaded only by pages that use it (the L33 feature split).
- **R34.108 Bubble input and reset effect.** Hidden input mirrors the state, a bubbling `click` is dispatched on change (the compiled effect), form `reset` restores the default.
- **R34.109 Avatar.** Image status behaviour, or a ruling to defer.
- **R34.110 Composed handlers.** `composeEventHandlers(user, context.fn)` with an absent or static `user`; else `context-handler`.
- **R34.111 Fail closed (§5).** Each remaining shape has a named code; valid React never becomes a build error (the F142 ruling).
- **R34.112 Battery.** Rows in §5, each built, and the nine DOM/behaviour assertions of R34.113.
- **R34.113 Behaviour parity.** A Chromium test per component (`tests/server/radix-wave-a.chromium.test.ts`): initial HTML equals the React build's; click toggles `data-state`/`aria-*`; a hostile value in a prop stays text; the form `reset` and the bubbled `click` reach a `form` listener (switch, checkbox).
- **R34.114 Scoreboard.** `docs/shadcn-coverage.*` regenerated; the PR lists every row that moves tier and bytes, and every row that stays an island with its code.
- **R34.115 Re-measure.** The first flipped page is built and measured (gzip, files), the estimate in §1 is replaced by the measured number, and the lane stops after wave A if the number is not in the order of 10 KB or less per page.

## 5. Fail-closed list and battery rows

| Shape | Result |
|---|---|
| `createContextScope` with a different shape, or from another package | island, `context-factory` |
| a scope argument that is not a pass-through | island, `context-scope` |
| a consumer with no Provider frame and a non-constant default | React, `context-no-provider` |
| a Provider whose children are not rendered inside its own element (a portal, a render prop) | island, `context-children` |
| a controlled state prop that changes at run time, or `onChange` a page function | React, `controlled-state` |
| `composeEventHandlers` with a page-function user handler | React, `context-handler` |
| `Presence` with several children or a function child | island, `presence-shape` |
| a consumer that writes the provider's state during render | island, `context-write` |

Battery rows (single snippet plus files; built, and where it flips a page tier, served): `b-context-create-static` (constant value, 0 JS), `b-context-state-consumer-static`, `b-context-nested`, `b-context-two-contexts`, `b-context-no-provider`, `b-context-default`, `b-context-handler-compose`, `b-context-controlled-prop`, `b-presence-basic`, `b-presence-force-mount`, `b-context-scope-radix` (a stub package with the `createContextScope` shape), plus negatives for each line of the table.

## 6. Proof — the rows that move

- **Expected static or native with 0–a few KB:** progress (static, 0 JS), toggle, collapsible, switch, checkbox; avatar if step 0 allows. Each page is built **alone** by the real `brust build`, **served**, and compared with the React build's HTML and behaviour (the memory rule: a build proves nothing).
- **Wave A estimate:** about −500 KB over six pages (§1). Re-measured at R34.115; **not** a claim of this plan.
- **Do not move:** tabs, accordion, radio-group, slider, the overlays.

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/{hooks,names,aliases,exports}.rs` and `passes/children.rs` (frames, consumers), `ir/` (`provides`, the hidden prop kind), `lower/{template,client}.rs` (printing), `packages/brust/src/build/{pkg-src.ts,bundle.ts,manifest.ts}` (the package-source reach to `react-context`, `react-presence`, `react-use-controllable-state`, `react-id`; the feature module), `packages/runtime-dom/src/{features,directives}/presence.ts`, tests, battery rows, generated docs, ledger. Nothing in `crates/brust-core` unless a manifest field is needed. Gates: Mellow (a new build-time recogniser and a runtime feature), Illenium. Reviewed rounds capped at 2; a second recogniser beyond `Primitive` and `createContextScope` stops the lane.

## 8. Risks

1. **`createContextScope` is a second structural recogniser.** Mitigation: exact shape, integrity-checked package, one generic API; if a release changes the shape it is an island, not wrong output.
2. **Slot content of a native provider binds against the provider's members.** The design relies on DOM nesting (descendants of a host that are not inside a nested host are bound by it). Slot content that reads **page** state would silently bind to the wrong instance; v1 fails closed on it (`context-page-state`). **[verify in step 0 by a hand-written fixture before any compiler code]**
3. **Estimate risk.** All byte numbers are estimates until R34.115.
4. **Presence semantics.** An element whose exit is animated by something other than a CSS animation (JS) is not handled; documented.
5. **forwardRef/ref.** The Provider and consumers are `forwardRef` components; F153b already drops the forwarded ref, and a call-site `ref` stays `forwardref-ref`.

## 9. Step 0 (before the lane writes compiler code, reported as a task note)

1. **Runtime fixture, no compiler:** hand-write the HTML a compiled collapsible would print (a provider host, a trigger and a content as descendants, `x-props-bind` for a nested consumer) and mount it in `packages/runtime-dom` (happy-dom); assert click, `data-state`, `aria-expanded`, `x-if` content, and a nested native consumer. This settles risk 2 and the §3.3 claim at the cost of one test file.
2. **Compile what exists:** run the compiler on the wave A packages' source after package-source reaches them and list, per component, the diagnostics that remain after context is stubbed by hand (a throwaway patch), to confirm that nothing else blocks (`useCallback`, `forwardRef` + rest spread, `Primitive` are already handled).
3. **The effect shape:** compile the BubbleInput effect as written and record whether it is `browser-global` or lowers.

## 10. Questions for the lead

- **Q1 Recogniser.** Accept `createContextScope` as a structural recogniser (one generic API, integrity-checked), or compile only React's own `createContext` in this lane and leave Radix's scoped contexts for the package-source step 2? Recommended: accept; wave A has no other way in.
- **Q2 Avatar.** In wave A, or deferred to A2 if the effect does not lower in step 0? Recommended: try it, defer on a failed step 0.
- **Q3 Controlled state.** v1 supports uncontrolled plus a constant controlled prop only. OK? Recommended: yes; the dynamic-controlled case is a React-shaped use (the page owns state) and stays an island.
- **Q4 Stop rule.** R34.115: stop and report if the first flipped page is more than about 10 KB gzip. OK?
- **Q5 Order inside the lane.** progress (pure compile-time context), then toggle and collapsible, then switch and checkbox (effects, bubble input), then avatar. Recommended as written; each is its own commit and gets its own served check.
