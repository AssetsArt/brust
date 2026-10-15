# shadcn S2 — lane `context-lowering` (wave A of the Radix non-overlay compounds) (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Tiësto (proposed) · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: next free F-number (F168 or later; F166/F167 are hardening-batch)

Author: Tiësto. Status: **RULED 2026-10-14 (see §11); lane may start after hardening-batch.** Base: origin/main 690670e9 (2.0.0-alpha.9). R-numbers: **R34.100–R34.115** (the lead's range; R34.88–R34.99 are F149 and the lanes before it). Evidence: the task `radix-compounds-spike` (a long note; the lead's rulings on it are on that task: bubble input kept with a native event, Presence kept as a small feature, wave A first), `docs/shadcn-coverage.{md,json}` at this base, and the original TypeScript of each Radix package, read from its source map. Anything I did not run is marked **[verify]** and is step 0 of the lane.

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

## 11. Lead ruling (2026-10-14)

Accepted. The design (a context is an implicit prop threaded lexically from the nearest Provider frame, on top of the shipped `x-props-bind` and the inlined-child substitution) adds no runtime feature for context itself, which is what the north star asks for. Rulings on §10:

- **Q1 Accept the `createContextScope` recogniser**, integrity-checked, as the **second and last** structural recogniser (after `Primitive`): it is one generic API shared by every Radix primitive, not a per-primitive shim. React's own `createContext`/`useContext`/`<C.Provider>` is compiled in the same lane (ordinary apps use it); it is the general feature, the Radix factory only feeds it. Any further recogniser needs its own ruling.
- **Q2 Avatar: try it; on a failed step 0 it moves to wave A2** with a short note, without blocking the other pages.
- **Q3 Controlled state: uncontrolled + a constant controlled prop only** in v1; a page-owned dynamic controlled prop stays an island (`controlled-state`).
- **Q4 Stop rule accepted:** stop and report if the first flipped page is above ~10 KB gzip.
- **Q5 Order accepted, and shipped incrementally: one PR per step** so bytes land early and reviews stay small: PR 1 = recognisers + frames + progress (compile-time context, 0 JS); PR 2 = toggle + collapsible; PR 3 = switch + checkbox (effects, bubble input, Presence feature); PR 4 = avatar. Each PR has its served check and its measured scoreboard rows; Mellow reviews each (security: the frame decides which values reach which DOM bindings).

## Amendment 2026-10-15 — R34.18 extension: a static child's spread takes live values too (lane `context-lowering-2b-handlers`, DESIGN NOTE, no code)

**Status: PROPOSED.** Mellow reviews the print paths below, Detoro rules, then code as PR 2b-handlers. Written after the six hook items landed as 2b-hooks (`useControllableState` now inlines with general machinery).

### 1. What stops the toggle page now (measured)

Radix `Toggle` writes `<Primitive.button aria-pressed={pressed} data-state={…} {...buttonProps} onClick={composeEventHandlers(props.onClick, () => setPressed(!pressed))}/>`. The first refusal is `spread-handler`: `<Primitive.button> is linked (another prop of it changes on the client)`. It is the first of three that stack. A hand-written analog (`Btn = ({children, ...rest}) => <button type="button" {...rest}>…</button>`, a native parent with state) shows each in isolation, built with the shipped compiler:

| Parent writes | Result today |
|---|---|
| `<Btn onClick={…}/>` (+ any `{...rest}` before it) | **native**: S1.3 hoists the handler, `Btn` stays static |
| `<Btn aria-pressed={on}/>` (state value, no handler) | React, `spread-props`: "a value that changes on the client … reaches an element through a spread, which brust expands into HTML only" |
| `<Btn aria-pressed={on} {...rest}/>` | React, `spread-props` (same, and a later unknown spread may replace the attribute) |
| `<Btn aria-pressed={on} onClick={…}/>` | React, `spread-handler`: the child is linked |

So the cause is one thing, not three: **a child's spread is expanded into HTML on the server only, so anything live that lands through it has no client binding.** S1.3 solved it for handlers (the parent binds `x-on-*` on the child's element in the parent's scope, R34.18). It did not solve it for live values, and it gave up as soon as a live value forced a link. The same shape is written by Radix `Toggle`, `Switch`, `Checkbox` and the `Collapsible` trigger (`<Primitive.button state-driven aria/data {...rest} onClick={composeEventHandlers(…)}/>`), so this is the leverage point of PR 3, not a toggle detail.

### 2. Three shapes considered

- **A. Keep the link, bind the handler in the parent's scope on the linked child's host.** The linked child's root element IS its host (it carries `x-data`), so `x-on-click="_h1"` resolves in the child's scope, not the parent's. It would need a scope-up reference in the runtime (a new directive syntax). Rejected: runtime change, and the child keeps a chunk and a link for nothing.
- **B. The host carries the handler.** Pass the function through `x-props-bind` (functions already pass through) and let the child chunk apply it. The chunk is one per component and its spread is HTML-only, so the client would need a runtime spread that binds event names it does not know at compile time. Rejected: a new client attribute sink (attribute-name and `on*` injection, F94 class), sized for every page that loads it.
- **C. Extend R34.18 to live values; the child never links (recommended).** Whatever the parent passes that lands in a *static* child's spread, and that the child reads nowhere else, is bound by the parent on the child's element **in the parent's scope**, exactly as hand-written markup would: a handler as `x-on-<event>` to a parent member `_hN` (shipped), a live value as `x-bind-<attr>` to a parent member `_dN` (new; the same `x-bind-*` directive hand-written attributes use). With nothing live left on the instance, `instance_needs_link` returns `None`: the child stays static and unlinked (no chunk, no `x-props-bind`), the output equals hand-written `<button …>` in the parent. Smaller than A and B and no runtime change.

### 3. Shape C: rules

Reuse the S1.3 gate (`forward_handlers`' `why` chain) unchanged and add the live-value arm:

1. **Eligible key.** `child.spread.lands(k)` (the child's spread lands on exactly one element), the child reads `k` nowhere else (`onward.reads` does not contain it), does not pass it to another component (`onward.components`), the child is `Tier::Static`. Anything else keeps today's refusal, with its code. **Whole-rest reads (C2).** The component's `...rest` must be used ONLY as the single spread on the one element (`spread.lands`); ANY other use of the rest object counts as reading every key: a second `{...rest}` on another element or component, `Object.keys(rest)`, `JSON.stringify(rest)`, `rest` passed to a helper or a hook, a `rest.k` read. Otherwise the parent would bind a value the child also consumes elsewhere and the two would disagree after a click.
2. **Attribute name (C3).** Compile-time constant from the parent's source key, through the SAME gate a hand-written attribute goes through, not only `handler_key_ok`: `attr_name_ok` on the React and the HTML name; `is_refused_attr` (`on*`, `srcdoc`, `x-*`, so `x-html` can never become `x-bind-x-html`); `NOT_ATTRS` (`children`, `key`, `ref`, `dangerouslySetInnerHTML` never bind); `style`/`className` refused (Q2). `value`/`checked` on a form element are refused when the element also has a model (the binder sets the property), as `template.rs` does today. A key that fails is dropped with the existing `unsafe-attr` warning or refused, never bound; a runtime-computed key is never bound.
3. **Later spread: decided per instance, at compile time (C1, lead ruling Q1).** Order is React's: the last occurrence wins. When an unknown spread follows the live key (`aria-pressed={pressed} {...buttonProps}`, Radix Toggle), it is the component's OWN `...rest`, and the keys in that rest at one call site are exactly the attributes that call site writes (its props minus the ones the component destructures), all known when the call site is compiled. So for each instance: the call site writes the key → the call site's value wins (omitted when it is `undefined`, as React omits it); the call site does not write it → the component's own value is bound. A call site that ITSELF spreads an unknown object into the component, or a later spread that is not the component's own rest, is refused with `spread-props` ("may replace it"). **No runtime `in` test**: props cross as JSON, which drops a present-but-`undefined` key (React: it still wins), and `in` reads inherited keys.
4. **Member and print path (C4, C6).** The value becomes a derived member `_dN` of the parent (no new IR kind: a `DerivedDecl` over the parent's state), printed on the child's element by the SAME code path as a hand-written dynamic attribute: painted by `attr_kind` (F196: `__attrs` for `aria-*`/`data-*`, `__bool`, `__attro`, the `__attr` null rule), URL attributes through `url_ok` on the server and `safeUrl` in the binder; no bespoke printer. The server's first paint is the child's `spread_attrs(...)` over the SAME merged value (rule 3 decides it), so the first paint equals `_dN` at hydration. Inside a parent's list the member is per row (`_dN` with the row's loop scope, the existing keyed `x-bind`-in-list machinery).
5. **Booleans.** `x-bind-aria-pressed` with `false` must print `"false"`, as React does for `aria-*`/`data-*` (F196, `event-aria-correctness`). **2b-handlers depends on F196**; without it the toggle page is wrong when off. A served test equal to React is the proof.

### 4. How the handler reads the CURRENT state, and `composeEventHandlers`

The hoisted member is a member of the parent, i.e. the same closure `<button onClick={…}>` written in the parent would have: it reads signals at call time, so it always sees the current state; nothing is copied into the child. The prop expression `composeEventHandlers(props.onClick, () => setPressed(!pressed))` is the handler's body evaluated **per event** (`(e) => (<expr>)(e)`), so `props().onClick` is read at event time too. Order and `defaultPrevented` are then not re-implemented but are the library's own function running on the native event: the caller's handler first, then ours unless `event.defaultPrevented`. A native event's `defaultPrevented` is what React's SyntheticEvent mirrors, so the result is equal. (SyntheticEvent-only members inside a handler are F195, `event-aria-correctness`, not this lane.) **Function gate (C5).** Evaluating the expression per event is accepted only if it passes S1.3's function gate: no JSX; reads limited to props, state, setters and module functions; no side effects in its arguments (React evaluates them once per render, here they run once per event). And `props().onClick` must be DEFINED on the client whenever the page passes a handler: it is bound through the existing S1.3 hoist from the page, or the instance is refused; it is never silently `undefined`, which would drop the caller's handler while ours runs. The proof is a Chromium test: the caller's `onClick` runs first; one that calls `preventDefault` stops ours and the state does not change; one that does not, flips `aria-pressed`/`data-state`.

### 5. Print paths Mellow must check

1. **Server HTML**: the child's `spread_attrs(...)` print plus the parent's `x-bind-<attr>` directive on the same element: no duplicate attribute, key order and later-wins as React, boolean/`undefined`/`null` values per React (`undefined` omits).
2. **Client `x-bind-*` sink**: set through `setAttribute` (text), never as markup; URL attributes (`href`, `src`, …) get the same guard a hand-written `href={x}` gets; `style`/`class` keep their own paths (a live `className`/`style` landing in a spread stays refused in v1).
3. **Names**: only compile-time keys reach `x-bind-`/`x-on-`; the `unsafe-attr` drop path is covered by a test with a hostile key.
4. **The `in` test of rule 3(a)** over the rest object: a key spelled `__proto__` or `constructor` must not read the prototype (own keys only).
5. **No link means no chunk, and no double binding (C7)**: assert that the child has no `x-data`/`x-props-bind` in the output and no JS chunk (zero JS when the parent is otherwise static is NOT claimed; the parent has a state), and that the child's own template has no `x-on`/`x-bind` for the forwarded keys: only the parent's directives exist, so an attribute is never bound twice.

### 6. Tests (a plan, not code)

Fixtures are the hand-written analog above plus Radix `Toggle`'s shape: positive (live value only; handler only; both; both with `...rest` before; the Radix order with `...rest` after, rule 3: the call site writes the key / does not write it / writes it as `undefined`; a toggle inside a `.map`, C6), negative (a call site that spreads unknown keys, a different spread after, `{...rest}` on two elements, `Object.keys(rest)`, `rest` passed to a helper, a page `onClick` that cannot be hoisted, `x-html`/`on*`/`srcdoc` keys, `value`/`checked` with a model, the child reads the key by name, the child forwards it to another component, hostile key, a live `className`, a non-event function), one battery row each; served-vs-React parity for the toggle page; a Chromium click test (§4). Bytes: the toggle page is measured against R34.115 before it is called done.

### 7. Order, files, coordination

PR 2b-handlers: `analyze/passes/children.rs` (`check_spread`, `forward_handlers`, `instance_needs_link` callers), `lower/template.rs` (the inline print), tests, battery, regenerated `docs/shadcn-coverage.*`. Not `placement.rs`. `children.rs` is shared with Dew's `element-drop-fixes`: whoever lands second merges main first, and each posts on the other's task before touching it. F196 lands first (it is a prerequisite of the toggle parity test).

### Rulings and reviews (2026-10-15)

- **Lead:** shape C accepted, conditional on Mellow's review. Q1 YES, resolved at compile time from each call site (rule 3), no runtime `in`. Q2 YES (live `className`/`style` stay refused, named). Q3 YES (F196 merged, #244).
- **Mellow (security/soundness):** SOUND WITH CONDITIONS C1-C7, all folded into the rules above (C1 rule 3, C2 rule 1, C3 rule 2, C4 rule 4, C5 section 4, C6 rule 4 and tests, C7 section 5.5). Status: **ACCEPTED, CODE AFTER 2b-hooks LANDS.**

## Amendment 2026-10-15b — PR 2c: a native Provider (state-valued frames) and Presence, for shadcn `collapsible` (DESIGN NOTE, no code)

Author: Tiësto · task `context-lowering-2c` · seeds: §3.2–3.5, Mellow's C1 on the 1d review ("a linked consumer's props are re-evaluated in the browser: a non-literal frame value must be precomputed or fail closed"), the S1.3/R34.18 hoisting and the 2b-handlers shape C. Everything marked **measured** was run on origin/main a94593e1 (napi built from it); nothing here is implemented.

### 1. What stops `collapsible` today (measured, `compileTree` as `brust build` runs it)

Page 89 KB / 1 island. Per component, the first blocker:

| Component (Radix 1.2.1, from source maps) | Tier today | First blocker |
|---|---|---|
| `Collapsible` (Provider + `useControllableState` + `useId` + `useCallback`) | React | `hook useId is called inside an expression` (`contentId={useId()}` in a JSX prop); behind it `context-state` (`provider_problem`: a Provider handing out state/handler) |
| `CollapsibleTrigger` (consumer; `onClick={composeEventHandlers(props.onClick, context.onOpenToggle)}`) | Native (!) | compiles, but as its own host; the page then fails `slot-native` for `asChild` on a stateful component, and `context-island` while the Provider is React |
| `CollapsibleContent` (consumer; `<Presence present={forceMount \|\| context.open}>{({present}) => <Impl present={present}/>}</Presence>`) | React | render prop (`island-prop`, B7), `Presence` is not followed (`the export is not declared in a form the compiler follows`) |
| `CollapsibleContentImpl` (consumer; `useState`, 4 refs, `useEffect`+rAF, `useLayoutEffect`+`getBoundingClientRect`, `hidden`, `{isOpen && children}`) | not exported | refs read in render (`heightRef.current`, B4 shape), composed refs (B1/B2) |

Presence itself (`react-presence` 1.1.11, source read): a state machine through `useReducer` (`useStateMachine`), two layout effects and a passive one, a **callback ref** that calls `setNode`, `getComputedStyle`, `CSS.escape`, animation events, `React.Children.only`, `React.cloneElement(child, { ref })`, `getElementRef` through property descriptors. With a **function child** (as Collapsible uses it) `forceMount` is true: the child is always rendered and only the `present` argument follows the machine.

### 2. Finding that changes the design: who owns a directive printed inside another host's region (measured, wrong output on main)

A native child's slot content is printed inside that child's host element, and the runtime binds every directive by the **nearest** `x-data` ancestor (runtime README: "nested hosts are bound by their own instance"). So page state read in slot content of a native child binds to the **child's** instance. Repro, no Radix, no context: a native page with `useState(on)` rendering `<Box><p>{on ? 'yes' : 'no'}</p></Box>`, `Box` native with its own state and `{children}`. The compiler prints no diagnostic and emits `<div x-data="box_…"><p x-text="_c1">`; run in happy-dom with the exact chunks: first-paint mismatch warning (`"no" vs "0"`), the text becomes Box's `_c1`, and a click on the page's button never reaches it. A page handler in slot content calls Box's `_h1` the same way. This is risk 2 of §8, which §8 said to fail closed (`context-page-state`) and which was never implemented. It is on main today (task note on `context-lowering-2c`; recommended as its own small fail-closed PR first).

**Ownership rule (O1, general, replaces `context-page-state`).** Every expression the template prints as a directive has an *owner* component (the component whose scope its names are resolved in; after a frame substitution the owner is the Provider whose member it names). A directive may be printed only where the nearest enclosing host element **is** its owner's host. A directive whose owner is P found under a native child host of P (slot content, or a consumer inlined into it) is refused at the call site with the named fallback `slot-owner` (the caller of the child stays on React; the child itself is unaffected). Static content (no directive) is unaffected, which is why every existing page passes.

This single rule is also the soundness condition of the native Provider: a consumer's directives are owned by the Provider after substitution, and they sit inside the Provider's host, so they pass; a **page**-owned directive in the same slot is refused.

### 3. The native Provider (R34.116–R34.121)

**R34.116 State-valued frames.** A frame field is an expression of the **Provider's own scope** (not of the call site, as §3.2 for constant frames): a member of its instance = state, a derived value, a handler (`useCallback`/arrow over its setters), a prop, a `useId` slot. Such a Provider is Native (it has state) and its host element is the element its template returns (Collapsible: the `Primitive.div`). `provider_problem` no longer refuses state/handler members; it still refuses elements, loop values and stores (`context-state` shrinks to those). Constant frames keep the §3.2 call-site substitution unchanged.

**R34.117 Static consumers under a native Provider are inlined into the Provider's host region.** `context.open` becomes the Provider's member (`open()` in the chunk, `open` in the jinja scope); `aria-expanded`, `data-state`, `aria-controls`, `disabled`, `x-if` for `{isOpen && children}` become directives owned by the Provider (O1: they pass). A consumer handler (`context.onOpenToggle`, alone or through `composeEventHandlers(props.onClick, fn)` with an absent or static user handler, R34.110) becomes `x-on-click` calling the Provider's handler member, the same hoisting S1.3/shape C already do for a static child's spread; `asChild` on the consumer (shadcn's `<CollapsibleTrigger asChild><Button/></CollapsibleTrigger>`) merges that directive into the child element, so `check_poly`'s `slot-native` becomes `slot-owner`-style: allowed iff every merged handler/binding is owned by the enclosing native Provider, else refused by name. `Trigger` thereby stops being its own host (it is Static after substitution).

**R34.118 No host between consumer and Provider.** A consumer must have no other native host element between itself and its Provider's host element in the lowered tree (otherwise the runtime would bind it, or resolve `x-props-bind`, to the wrong instance). The compiler checks it on the lowering stack (it holds the host chain); a violation is `context-hop`, the call site stays on React.

**R34.119 Native consumers and Mellow's C1.** A consumer with its own state, refs or effects (`CollapsibleContentImpl`) is a nested host and receives the frame through `x-props-bind` to a `computed` member `_pN` of the Provider (the shipped linking). That computed is **evaluated in the browser, in the Provider's chunk**, so every frame field it reads must be client-closed. Rule: a frame field consumed by a native consumer must pass the existing `client_ok` test of `lower/template.rs` (names of the Provider's state/derived/props/handlers that are present in its chunk; no `Expr::Server`, no props-only precompute slot, no module helper not carried into the chunk by 4a); otherwise `context-client` (the call site stays on React). Fields that are constants are inlined as literals. Static consumers need the same test because their directive expressions are printed into the same chunk. Functions travel through `x-props-bind` unchanged (tested); the consumer calls the Provider's setter, never a copy. No path evaluates a frame field anywhere but the Provider's template (server first paint) and the Provider's chunk (browser).

**R34.120 `useId()` inside an expression (general).** A hook call in a JSX attribute value (or any expression position) that runs unconditionally on every render is hoisted to a statement before the return, in source order (`contentId={useId()}` ⇒ `const _id = useId()`), for the hooks the compiler already reads. Conditional or looped positions stay refused (`hook-in-expression`). Small, general, independent of Radix; first step.

**R34.121 `useControllableState` + the toggle callback.** Already shipped (2b-hooks); `onOpenToggle={useCallback(() => setOpen(p => !p), [setOpen])}` is a handler member (the `useCallback` is read today).

### 4. Presence — three ways, one recommendation

- **P1 compile as written.** Needs, besides the PR 3 gaps (B1 callback ref, B2 rest-hook, B7 render prop): `React.Children.only`, `cloneElement(child, { ref })` with a composed ref, `useReducer` through a custom hook (`useStateMachine`), `getElementRef` (property descriptors on the element: not expressible), and following the package's export. That is five more general gaps for one component, one of which (descriptor reads on a React element) has no meaning without a React element tree. Not recommended for this lane.
- **P2 the ruled design (R34.107): a runtime feature `presence`** (`x-presence="member"`, ≤1.5 KB gzip, loaded only by pages that use it), recognised **structurally** from `@radix-ui/react-presence` (integrity-checked package, exact export shape), covering both the element child and the function child (`{({present}) => <Impl present={present}/>}`: the argument is bound to the feature's `present` signal). This is a **third structural recogniser** and a runtime feature that stands in for library code, so it needs Detoro's explicit ruling against the "no port" line he drew for BubbleInput (that case compiled; this one does not, per P1).
- **P3 stage it.** Land the native Provider, the static consumers (`Trigger`) and an un-animated `Content` first: with a function child `present` follows `context.open`, and with no exit animation (shadcn's `collapsible-content` has none) `isPresent` equals `open`, so Presence reduces to `present = open`. Accept P3 only if it is **proven**, not assumed: the recogniser would fold `Presence` to its child with `present := the present prop` **iff the page ships no exit animation for it** (decidable only at run time: `getComputedStyle(node).animationName`), so a build-time fold is unsound for a user who animates `[data-state=closed]`. Therefore P3 is not available without the runtime half.

**Recommendation: P2, narrowly**, because it is the only sound one; shadcn's `accordion` (wave B W3) and `checkbox`'s Indicator need the same feature, and it keeps first paint equal to React (Presence with a function child renders the child always, `hidden` handles the closed state; the feature only delays the `present` flip until the exit animation ends). If Detoro rejects a third recogniser, `collapsible` Content stays an island and the page keeps its `Trigger`/`Root` compiled around it (O1/R34.116–R34.119 still land and are measured on that mixed page).

### 5. Fail-closed list (additions)

`slot-owner` (a directive owned by P under a native child host of P), `context-hop` (a native host between consumer and Provider host), `context-client` (a frame field a native consumer reads is not client-closed), `hook-in-expression` (conditional/looped hook in an expression), plus the §5 rows. Each: valid React never becomes a build error; the caller falls back to React with the name.

### 6. Order and proof

1. **`slot-owner` guard** (O1 as a refusal only; no frame work). Independent bug fix; battery rows: native-in-native with page state in slot, page handler in slot, loop value in slot, static slot (passes), nested three deep.
2. **R34.120** hoist `useId()` in expressions (+ rows).
3. **Step 0 (hand-written analog, before any frame code):** React `createContext` disclosure (state + toggle callback + `useId`, a static Trigger with an `asChild`-style merge, an Impl-like native consumer with a ref and an effect) written by hand in the shape R34.116–R34.119 would print; mounted in `packages/runtime-dom` (happy-dom): click, `data-state`, `aria-expanded`, `x-if` content, nested native consumer through `x-props-bind`, and the mismatch case of §2 to prove the guard is needed. Reported as a task note.
4. **R34.116–R34.119** in `children.rs`/`context.rs`/`lower/{template,client}.rs`; the analog fixture first (Cargo + served-vs-React), then the Radix page.
5. **Presence** per the ruling on §4.

Proof for the PR: `collapsible` page 89 KB → measured (stop rule R34.115: >~10 KB gzip stops the lane), 0 islands if P2 is ruled, served == React (`context-parity` page added) and a Chromium test (`tests/server/collapsible.chromium.test.ts`: click toggles `data-state`/`aria-expanded`/`hidden`, content text mounts, a hostile `id`/class value stays text, an exit animation keeps the content until `animationend`, wired in `ci.yml`). Mutation checks on `slot-owner`, `context-hop`, `context-client`.

Boundary: `analyze/{context,hooks}.rs`, `analyze/passes/children.rs`, `analyze/component.rs`, `lower/{template,client}.rs`, `ir/`, tests, battery rows, `scripts/shadcn` scoreboard, generated docs; for Presence also `packages/runtime-dom/src/features/presence.ts`, `packages/brust/src/build/{pkg-src,bundle,manifest}.ts`. Not `placement.rs` (B4 waits for `element-drop-fixes`).

### 7. Questions

- **Q1 (Detoro)** Land the `slot-owner` guard first as its own PR (new ledger number, task name needed), independent of Radix? Recommended: yes.
- **Q2 (Detoro)** Presence: P2 (third structural recogniser + runtime feature), or collapsible Content stays an island? Recommended: P2, with the integrity check and a fixture that a changed package shape islands.
- **Q3 (Mellow)** Is O1 sound as the single binding rule (owner = the component whose scope resolves the names after substitution; nearest host must be the owner's)? Specifically hostile inputs: a consumer inlined into a *different* Provider's region of the same context name (nesting), `asChild` merging a page handler into a consumer element, and `x-for` rows inside a Provider host.
- **Q4 (Mellow)** Is R34.119 (client-closed fields only, no re-evaluation anywhere else) enough for C1, or must a frame field be restricted to *names* (no operators) for native consumers?
- **Q5 (Detoro)** `asChild` + handlers (R34.117) widens `check_poly`: accepted as part of this lane, or a separate task?
