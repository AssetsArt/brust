# shadcn S2 — wave B: roving focus + collections (tabs, accordion, radio-group, toggle-group), read-only spike (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · author: knock2 · reviewer: Mellow (recogniser + runtime feature) · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: next free F178 · governed by `docs/plans/2026-10-14-react-parity-north-star.md`, builds on `docs/plans/2026-10-14-shadcn-context-lowering.md` (wave A, Tiësto) and the `radix-compounds-spike` result

Status: **ACCEPTED as option A (lead ruling §13); starts after wave A PR 3.** Drafted from a spike by knock2. No compiler or runtime code was changed. Base: origin/main dfc6dafb. R-numbers are proposals (R34.140–R34.155; the parked spread-into-island plan keeps R34.126–R34.134); the lead renumbers. `placement.rs` is not touched by anything here. Everything measured below was run on this base; what was not run is marked **[estimate]** or **[verify]**.

## 0. Short answer

1. **What wave B needs beyond wave A:** two things context lowering does not give: (a) a **collection**: components that register DOM elements with their data and read them back **in document order** (`getItems()`), and (b) **roving focus on top of it**: a group with one tab stop, arrow/Home/End/Page keys that move focus along the collection, entry focus, and `dir`/`orientation`/`loop`. Both are ordinary React written with refs, effects, a context of functions and `compareDocumentPosition`; neither is an overlay or portal.
2. **Which tier:** `tabs`, `accordion`, `radio-group` and `toggle-group` all reach **native** (state, handlers, refs), never static. None can be an island-free static page, and none needs to stay a React island once collection and roving exist.
3. **Measured floor:** a hand-written native tabs (two triggers, two panels, ArrowLeft/ArrowRight/Home/End roving through `ref` + `querySelectorAll`) builds native, behaves correctly in Chromium and costs **5,048 B gzip** in total (runtime core 3,114 + `basics` 957 + `if` 394 + the component's chunk 583). The Radix tabs page is **94 KB** today. So a page of this kind lands at **5 KB at the floor**, and I estimate **8–12 KB** when compiled from Radix (context frames, five or six small hosts, a `collection` feature of about 0.6–1 KB) **[estimate]**: **−82 to −89 KB per page**, about **−330 to −358 KB for the four pages** (tabs 94, accordion 94, radio-group 97, toggle-group 93), a little above the spike's −257 KB for three.
4. **The decision that is not mine:** to compile `RovingFocusGroup` and `Accordion` as written, `createCollection` (a factory of context + slot + ordered dictionary, 408 + 479 lines) must be **recognised**, exactly like `createContextScope` was. That is a **third structural recogniser**; wave A's ruling made `createContextScope` "the second and last" and said any further recogniser needs its own ruling. This plan asks for it (Q1) and shows the alternative that avoids it (B), which ports the keyboard logic instead of compiling it.
5. **Order:** wave B cannot start before wave A PR 3 (it needs context frames, controllable state, Presence, the bubble input for radio-group, and the collapsible for accordion). I estimate three PRs of its own (§7).
6. **Side findings** (not wave B, reported because they were hit): a compiler bug that emits invalid JS for a local object-literal constant used in a handler (§8, proposed F178), and a template-reserved prop named `loop` on `TabsList` (F168).

## 1. What the four pages are today (measured, `docs/shadcn-coverage.md` at this base)

| Page | Tier | Islands | Client JS gzip | Fallback codes on the page |
|---|---|---|---|---|
| tabs | static | 1 | **94 KB** | external-component, island-prop, spread-props |
| accordion | static | 1 | **94 KB** | external-component, island-children, island-prop, spread-props |
| radio-group | static | 1 | **97 KB** | external-component, island-prop, spread-props |
| toggle-group | static | 1 | **93 KB** | external-component, hook-unsupported, island-children, island-prop, member-tag, spread-props |

All four are one React island (react + react-dom + the Radix tree). Wave A (progress, toggle, switch, checkbox, collapsible, avatar) is the part that makes the context and state behind them compile; wave B is the part that makes the *keyboard and the DOM order* compile.

## 2. What the Radix source needs beyond context (read from the original TS in the source maps)

### 2.1 `RovingFocusGroup` (react-roving-focus 1.2.1, 408 lines; used by tabs, radio-group, toggle-group)

- **State and context:** `currentTabStopId` (`useControllableState`), `isTabbingBackOut`, `focusableItemsCount`; a context of six fields, four of them functions (`onItemFocus`, `onItemShiftTab`, `onFocusableItemAdd/Remove`). Wave A covers this (frames, functions through `x-props-bind`).
- **Group element:** `tabIndex={isTabbingBackOut || focusableItemsCount === 0 ? -1 : 0}`; `onMouseDown` (click-focus flag in a ref), `onFocus` (entry focus: dispatches a **`CustomEvent`** `rovingFocusGroup.onEntryFocus`, then focuses the first of `[active, current, …items]`), `onBlur`; an effect that adds and removes the entry-focus listener (`addEventListener` in an effect: native today).
- **Item element:** `tabIndex={isCurrentTabStop ? 0 : -1}`, `onMouseDown`/`onFocus` set the tab stop, `onKeyDown`: Shift+Tab, then `getFocusIntent(key, orientation, dir)` (`ArrowLeft/Up` prev, `ArrowRight/Down` next, `Home/PageUp` first, `End/PageDown` last, RTL-aware), then `getItems().filter(focusable)`, reverse for prev/last, `wrapArray` for `loop`, and `setTimeout(() => focusFirst(nodes))` (imperative focus after a tick, on purpose).
- **Hydration flag:** `useIsHydrated()` (a `useSyncExternalStore(subscribe, () => true, () => false)`) chooses between a layout effect and a passive effect for registering a focusable item.
- **Shapes the compiler refuses today** (library survey, each component compiled alone): `body-shape` and `browser-global` on `RovingFocusGroupItem`, `member-tag` (`Collection.ItemSlot`, `Collection.Provider`), `hook-unsupported` (every `use*Context`), `forwardref-ref`/`spread-props` (composition, resolved at the call site as in S1.2/F153b). The item's `children` may be a **function** (`typeof children === 'function' ? children({ isCurrentTabStop, hasTabStop }) : children`): a render prop.

### 2.2 `createCollection` (react-collection 1.2.0, 409 + 479 lines; used by roving focus, accordion, slider, select, menus)

- A **factory** returning `{ Provider, Slot, ItemSlot, useCollection }` (and the newer `unstable_createCollection` with `useGetCollection`, an `OrderedDict`). The provider holds `registryRef` (an `OrderedDict` of element → data), a `collectionElement` state, a **`MutationObserver`** that re-sorts when the DOM order changes, and two contexts (a stable one of refs and setters, a stateful one of the sorted map).
- `ItemSlot` is a `Slot` (asChild-like) that registers its child **element** (callback ref → `registry.set(node, data)`) and adds `data-radix-collection-item`; data (`id`, `focusable`, `active`) must be referentially stable.
- `getItems()` sorts by `compareDocumentPosition` and returns `{ ref: { current: el }, id, focusable, active }`; consumers read `item.ref.current`.
- It cannot be compiled as written in any reasonable size: a class (`OrderedDict`), `WeakMap`-style registries, slots, observers. Its **contract** is small: *items are the elements carrying a marker inside a root, in DOM order, each with a little data*. That is why a recogniser is the only way to keep "compile libs, never port" (§4).

### 2.3 What each page uses on top

| Page | Components | Uses beyond context |
|---|---|---|
| tabs | `Tabs` (context, `useControllableState`, `useId`), `TabsList` = `RovingFocusGroup.Root`, `TabsTrigger` = `RovingFocusGroup.Item` + `onMouseDown`/`onKeyDown`/`onFocus` activation, `TabsContent` (`Presence`, `forceMount`, `hidden`) | roving, `activationMode`, `makeTriggerId` string templates; a prop named `loop` on the list (F168 `prop-jinja-name`) |
| accordion | `Accordion` (single/multiple, `useControllableState`, `useDirection`), `AccordionItem` = `Collapsible.Root`, `Header`, `Trigger`, `Content` | `Collection.Provider/Slot/ItemSlot` with its **own** keydown (`Home/End/Arrow*` over `useGetCollection()`, `triggerCollection.findIndex`, `.at(i)?.element.focus()`), inner collapsible (wave A PR 2), `Presence`, `--radix-accordion-content-height` set by a layout effect measuring the element |
| radio-group | `RadioGroup` (roving group, `useControllableState`, `useDirection`), `RadioGroupItem` = `Radio` + roving item, `Indicator` (`Presence`), `BubbleInput` | the bubble input (wave A PR 3: `useSize` is a `ResizeObserver`, `usePrevious`), `onCheck`, form `required` |
| toggle-group | `ToggleGroup` (single/multiple), `ToggleGroupItem` = `Toggle` + optional `RovingFocusGroup.Item` (`rovingFocus`, default true) | `Toggle` (wave A PR 2), roving, `member-tag`, `ref-in-render` |

## 3. Tier reach

| Page | Tier it can reach | Why not static / island |
|---|---|---|
| tabs | **native** (host = `Tabs`, nested native hosts for the list and each trigger, static panels with `Presence`) | state `value`, `currentTabStopId`, handlers, refs, keyboard |
| accordion | **native** | state `value`, collection keydown, Presence + measured height |
| radio-group | **native** | state `value`, roving, bubble input |
| toggle-group | **native** | state `value`, roving |

Every page is one native host family plus the shared runtime core (3.1 KB) and `basics` (1 KB); `if` for panels. No page needs `island` hydration glue (a ~0.8 KB module the page would otherwise load).

## 4. Options

### A. Compile RovingFocusGroup and the consumers as written, with `createCollection` recognised (recommended)

- **R34.140 Third structural recogniser: `createCollection` / `unstable_createCollection`.** Exact call shape, from `@radix-ui/react-collection`, integrity-checked by R34.62 (a changed shape is an island). One generic API shared by roving focus, accordion, slider, select, menus and toolbar, not a per-primitive shim. **Needs the lead's ruling** (wave A's Q1 made `createContextScope` the last one without one).
- **R34.141 Runtime feature `collection`.** The root element gets the marker `data-radix-collection-root`; `ItemSlot` adds `data-radix-collection-item` and stores its data on the element (`el.__brustItem`, current values read from the item host's signals at call time, so the "referentially stable" contract disappears). `getItems()`/`useGetCollection()` is `Array.from(root.querySelectorAll('[data-radix-collection-item]'))` mapped to `{ ref: { current: el }, id, focusable, active, element: el }`: **document order is free** (the DOM already is in order), so there is no `OrderedDict`, no sort, no observer. Own module (budget **≤ 0.8 KB gzip [estimate]**), loaded only by pages that use it (the L33 feature split).
- **R34.142 Compile `RovingFocusGroup`, `Tabs`, `Accordion`, `RadioGroup`, `ToggleGroup` as written** on wave A. Needed beyond wave A:
  - `useIsHydrated`'s `useSyncExternalStore(() => noop, () => true, () => false)` shape lowers as `false` at SSR and `true` after mount (one hook shape, general; any other `useSyncExternalStore` stays `hook-unsupported`).
  - A **render-prop `children`** resolved at the call site: `typeof children === 'function' ? children(…) : children` takes the markup branch when the call site passes elements (the shadcn case); a call site passing a function falls back (`children-read`, already a rule).
  - Browser globals in **handlers and effects** are allowed (they already are): `CustomEvent`, `dispatchEvent`, `document.activeElement`, `setTimeout`, `node.focus({ preventScroll })`. Module helpers called only from handlers (`focusFirst`, `getFocusIntent`, `wrapArray`, `getDirectionAwareKey`) are inlined into the behaviour chunk by the existing G3 machinery; a helper called from render stays `browser-global`.
  - `body-shape` on `RovingFocusGroupItem` (statements before `return`, destructuring with defaults) is the F161 family: [verify] whether it is already absorbed.
  - `ref-in-render` on `ToggleGroupItem` and `RadioBubbleInput` [verify per site].
  - The prop named `loop` (and any other template-reserved word, F168) must be mangled in generated names, not refused.
- **Pros:** the keyboard logic is the library's own (compiled), so a Radix upgrade stays correct; the recogniser is generic and also unlocks slider (not in scope), select and menus later. **Cons:** a third recogniser; more compiler surface (§4 list); first byte count is an estimate until PR W1 lands.

### B. Port the keyboard to a runtime directive, recognising `RovingFocusGroup.Root/Item` (not recommended)

`x-roving="orientation:loop:dir"` on the group and `x-roving-item` on items; the keyboard logic written once in the runtime (about 1–1.5 KB). Smaller and faster to ship, **but it is a port of Radix's behaviour into brust** (against the north star's "compile libs, never port"), still needs the collection for the accordion, and drifts from Radix on every release (entry focus, RTL, `activationMode`). If A's compile blockers prove too many in W1, B is the fallback and the plan says so.

### C. Keep the four pages as islands (no change)

Zero risk, zero gain; −340 KB stays on the table.

## 5. Proposed rules (option A)

- **R34.140** Third recogniser: `createCollection` / `unstable_createCollection` (Q1).
- **R34.141** Runtime feature `collection` (DOM-order registry by marker attribute; ≤ 0.8 KB gzip; own module; loaded only when used). Item data are read at call time from the item's host.
- **R34.142** Compile the consumers as written; the items in §4 are step 0 of PR W1, each with a battery row.
- **R34.143** `useIsHydrated`'s `useSyncExternalStore` shape lowers as SSR `false` / mounted `true`; every other `useSyncExternalStore` stays refused (named).
- **R34.144** Render-prop `children` of an item resolves at the call site; a function at the call site falls back.
- **R34.145** Keyboard parity (R34.3): a Chromium test per page drives the same keys on the React Radix build and the compiled build and compares the focused element and `tabindex`/`aria-*`/`data-state` after each key: ArrowLeft/Right/Up/Down, Home/End, PageUp/PageDown, `loop`, vertical orientation, `dir="rtl"`, Tab and Shift+Tab (entry focus, tab-back-out), disabled items skipped, click focus, `activationMode="manual"`, `type="multiple"` accordion, a radio's `Space`/arrow check, form submit and `reset` for radio-group.
- **R34.146** Initial HTML equals the React build's (R34.3); hydration leaves the focused element alone.
- **R34.147** Fail closed with named codes (never a build error, R34.97): `collection-shape` (a `createCollection` call of another shape or package), `collection-scope` (a scope that is not a pass-through), `roving-function-child` (a function as an item's children at a call site), `hydrated-hook` (another `useSyncExternalStore`).
- **R34.148** Security: the registry reads the DOM and its own item data only. `data-radix-collection-item` and the root marker are compiler-written; request data cannot name them (F148a/F158 rules unchanged); a hostile `value`/`id` prop stays text in `data-*`/`id` attributes. Mellow signs off the recogniser and the feature.
- **R34.149** Scoreboard: `docs/shadcn-coverage.md` regenerated per PR; each PR states the measured gzip of every page that flips and every page that does not, with the code.
- **R34.150** Re-measure: the first flipped page (tabs) replaces the §3 estimate with a measured number; the lane stops and reports if it is above ~15 KB gzip.

## 6. Battery rows (each built and, where a page flips, served and compared)

`b-collection-basic` (a hand-written `createCollection` consumer), `b-collection-order` (items inserted out of order, DOM order wins), `b-collection-dynamic` (items added after mount), `b-roving-group-keys`, `b-roving-rtl`, `b-roving-loop`, `b-roving-vertical`, `b-roving-entry-focus`, `b-roving-disabled`, `b-hydrated-hook`, `b-item-render-prop` (element and function), plus negatives for each R34.147 code.

## 7. Order and PRs (after wave A PR 3)

| PR | Content | Pages | Needs |
|---|---|---|---|
| W1 | recogniser + `collection` feature + `useIsHydrated` + roving group compile + **tabs** | tabs | wave A PR 1 (frames), PR 2 (controllable state), PR 3 (Presence) |
| W2 | **toggle-group** (roving + `Toggle`) and **radio-group** (roving + bubble input + `useDirection`) | toggle-group, radio-group | wave A PR 2 (`Toggle`), PR 3 (bubble input) |
| W3 | **accordion** (collection keydown, collapsible, measured height) | accordion | wave A PR 2 (collapsible), W1 |

Each PR has its served check and measured rows; Mellow reviews each. Stop rule R34.150.

## 8. Findings from the spike (reported, not part of wave B)

1. **Measured prototype.** `Tabs.tsx` (state, `useRef` + `querySelectorAll` + `focus()` in a handler): native, features `basics` + `if`, 5,048 B gzip; in Chromium ArrowRight moves focus and the panel, Home returns, no console error. Source kept in the session scratchpad (`tabs-proto/`).
2. **A compiler bug (proposed ledger row F178).** A local object-literal constant read in a handler emits invalid JS: `const step = { up: 1, down: -1 }` becomes `const step = computed(() => { up: 1, down: -1 })` in the client chunk (a block with labels, not an object), so `brust build` fails with `Expected ";" but found ":"`. Minimal repro: a native component `const [n, setN] = useState(0); const step = { up: 1, down: -1 }; <button onClick={() => setN(n + step.up)}>`. The fix is to print an object literal body in parentheses. Hit while prototyping the roving handler; the same pattern (`const MAP = {…}` inside a component) is common in Radix-style code.
3. **`TabsList`'s prop `loop`** is a template-reserved name (F168); R34.142 asks for mangling, not refusal.
4. **Survey caveat.** The library survey compiles each component alone, so `forwardref-ref` and `spread-props` are inflated; inside a composition they resolve at the call site. The codes that survive composition and matter here are `hook-unsupported` (context), `member-tag`, `body-shape`, `browser-global`, `ref-in-render`, `prop-jinja-name`.

## 9. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/{hooks,names,aliases,exports,use_scan}.rs` and `passes/children.rs` (the recogniser, the render-prop resolution, the call-site rules), `ir/`, `lower/client.rs` (the object-literal print of §8), `packages/brust/src/build/{pkg-src.ts,bundle.ts,manifest.ts}` (the package-source reach to `react-collection`, `react-roving-focus`, `react-use-is-hydrated`, `react-direction`, `react-use-size`, `react-use-previous`), `packages/runtime-dom/src/features/collection.ts` and its binder, tests, battery rows, generated docs. **Not** `placement.rs`. Gates: the F148a set (fmt, CI-exact clippy, `cargo test -p brust-compiler`, `packages/brust` bun tests, battery, scoreboard, island and radix Chromium files) plus `tests/server/radix-wave-b.chromium.test.ts`. Heavy builds per `host:build-slots`.

## 10. Risks

1. **The third recogniser** is the policy risk: Q1.
2. **Compile blockers I could not size from the survey** (`body-shape`, `ref-in-render`, the item render prop): PR W1's step 0 compiles `RovingFocusGroup` with wave A stubbed by hand and lists what remains; if more than three blockers survive, the lane reports and B becomes the proposal.
3. **Focus is the most fragile behaviour in a browser** (Safari does not focus a clicked button; the Radix code has a workaround on `mousedown`). The parity test runs the same key script on both builds in Chromium; Safari/Firefox are not covered by CI (stated in the PR).
4. **All byte numbers beyond the 5,048 B prototype are estimates** until R34.150.
5. **Dependency on wave A's timing** (Tiësto's PR 1a/1c/1b are in review).

## 11. Questions for the lead

- **Q1** Accept `createCollection` as the third structural recogniser (one generic API, integrity-checked), or choose B (port roving into a directive) or C (stay islands)? Recommended: A.
- **Q2** Is the collection by **marker + DOM query** acceptable (no `OrderedDict`, no observer, document order from the DOM), given the Radix contract (items in document order, each with data)? Recommended: yes.
- **Q3** `useSyncExternalStore` for exactly the `useIsHydrated` shape as SSR-false / mounted-true: accept as a general, single-shape hook lowering? Recommended: yes.
- **Q4** Ledger: open F178 for the object-literal print bug now (small fix, independent of this lane)?
- **Q5** Order: after wave A PR 3, W1 (tabs) first, then W2 and W3? Recommended as in §7, one PR each.

## 12. Spike method

Reading: the original TS of react-roving-focus, react-collection, react-tabs, react-accordion, react-radio-group, react-toggle-group from their source maps; `docs/shadcn-coverage.md` at dfc6dafb; the library survey (`scripts/shadcn/lib.ts`, `surveyLibs()`) for the per-component codes; the context-lowering plan and Tiësto's notes on the task. Running: the main napi addon (borrowed from the main worktree, no build), a native tabs prototype built by the real `brust build` and driven in Chromium (scratchpad, not in the tree), and the minimal repro of §8.2 through `compileTree`. No cold build was made.

## 13. Lead ruling (2026-10-14)

owner: Detoro · authority: in-loop. R-numbers R34.140–R34.155 are confirmed (R34.126–R34.134 stay with the parked spread-into-island plan). Task `roving-collection`, ledger row **F179**.

- **Q1: option A.** `createCollection` / `unstable_createCollection` is accepted as the third structural recogniser. This is compiling the library, not porting it: the recogniser matches the exact published shape (R34.62 integrity), and the keyboard logic stays Radix's own, compiled. Any further recogniser needs its own ruling, as before. Option B (port to a directive) is the fallback only if W1 shows that A's compile blockers are too many. The plan says so, and that move needs a new ruling.
- **Q2: marker plus DOM query, yes, with one rule added.** An item belongs to a root only when its nearest collection root is that root: `el.closest('[data-radix-collection-root]') === root`. Without this, a nested collection (a group inside a group, a submenu later) would leak its items into the outer list. Add a battery row, `b-collection-nested`. Items rendered in a portal (outside the root's DOM) are out of scope: those components are overlays and stay islands.
- **Q3: yes**, exactly the `useIsHydrated` shape. Every other `useSyncExternalStore` stays refused, with a named code.
- **Q4: F178 is opened now as its own small lane, separate from this plan.** A build failure on valid React breaks R34.97, so it comes before wave B.
- **Q5: yes.** W1 (tabs), then W2 (toggle-group, radio-group), then W3 (accordion), one PR each. All of them start after wave A PR 3. R34.150's stop rule binds: if tabs measures over about 15 KB gzip, the lane stops and reports before W2.
- Reviewers: Mellow is a security gate on the recogniser and the runtime feature. Afrojack does the code review. Illenium runs the gates, including the keyboard parity tests (R34.145) in Chromium.

## 14. Amendment: W1 split and first page flip (2026-10-16)

owner: Detoro · authority: in-loop. This records the ruling on Tiësto's challenge on task `roving-collection` (step 0 tripped §10 risk 2). It amends §13 Q5. Q1-Q4 stand.

- **Step 0 measured.** Compiling RovingFocusGroup (Root and Item) on main, after wave A, leaves more than three blocker classes: `hook-shape` (an imported `useId` that reads a module counter; `useDirection` reading `DirectionContext`), `hook-unsupported` (`useCollection`, `useIsHydrated`, `useCallbackRef`), `body-shape` (destructuring in the Item body), `member-tag`, `context-escape`/`context-state`/`context-shape` (a context field named `loop`), `prop-jinja-name`, `jsx-const-child` (`composeEventHandlers` under a Provider), `forwardref-ref` and `browser-global`. Tabs also needs Presence for `TabsContent`.
- **Presence stays an island** (F229 ruling, ledger F288, parked). So does any shape built for tabs only: that would be a Presence recogniser by another name.
- **W1 is split into generic PRs,** in order. Each has battery rows, served == React, and mutation checks; none flips a page by itself.
  - W1a: imported-hook shapes and the `loop` name.
  - W1b: the `useIsHydrated` shape, body destructuring, `composeEventHandlers` as a `jsx-const-child`.
  - W1c: the `createCollection` recogniser and the collection feature, with `b-collection-nested`.
- **W1d, the first page flip, is toggle-group,** not tabs. It uses RovingFocusGroup and no Presence. R34.150's stop rule moves to it: over about 15 KB gzip, stop and report. W1d also reports how far tabs gets with `TabsContent` refused.
- **Tabs and radio-group wait on F288** (radio-group's Indicator uses Presence). W3 (accordion) waits on F288 too.
- **Hook calls inside an expression belong to F286** (lane `presence-general`, knock2): a hook in a returned object property or in the return position. W1a does not reimplement it. A `useCallback` in any other expression position is a new W1a row. Both lanes edit `analyze/hooks.rs` and agree the split on the task before editing.

## 15. W1a record (implementer, 2026-10-16)

W1a of the split ruled on task `roving-collection`: the generic imported-hook shapes the roving group and tabs need, with no page flipped. Ledger numbers are the lead's; the items below are provisional (`W1a-1` ...). Each has a compiler test, a served-vs-React case in `tests/server/native-provider.chromium.test.ts` where it changes markup, battery rows, and a mutation check.

1. **W1a-1, template names as props (R34.142).** A prop named `loop`, `range`, `namespace`, `caller` or `self` is read as `_props.<name>` in the standalone template (an inlined instance binds it by value, so it was never at risk); the refusal `prop-jinja-name` stays for keywords. A context field of such a name needs nothing (`__ctx_<ctx>_loop`). Replaces the F161/F168 refusals; battery rows `b-props-jinja-own-name`, `b-props-jinja-member-loop`, `b-props-jinja-member-range` are native now.
2. **W1a-2, decided React-version fallbacks.** `if (typeof <React hook alias> === 'function') { A } else { B }` (the alias is a module const read off the React namespace, `names.rs` `collect_react_hook_aliases`) is decided: React exports its hooks as functions, so only `A` is read (Radix `useCallbackRef`). `useState(useId())` whose only updates are `setId(r => r ?? X)` effects is the id itself: such an update returns `r` while `r` is not nullish, and a state seeded by `useId()` never is, so the effects (and the module counter `count++` they read) are dropped (Radix `useId`). Any other use of the setter leaves the hook as written.
3. **W1a-3, arrow rest parameter.** The reader kept only the name of `(...args) => ...`, so the chunk declared `(args) => ...` and a call that passes none spread `undefined`. The rest parameter now keeps its `...` in the IR name (found by the Radix `useCallbackRef` forwarder, `useMemo(() => (...args) => callbackRef.current?.(...args))`).
4. **W1a-4, contexts with a literal default read as a value (Radix `useDirection`).** `createContext(undefined | null | bool | number | string)` is a *scalar* context: a consumer that reads the local as a value (not `ctx.field`) reads the hidden prop `__ctx_<ctx>___whole`, a Provider hands one expression as that field (`value={dir}`), and with no Provider above the page the value is the default (a prop default on the page, React's own rule). The two frame shapes are different: a consumer that reads a whole value from a Provider that hands out fields, or a field from one that hands out a value, is refused (`context-shape`), never `undefined`. A field named `__whole` is refused. This changes what the battery's old "React child" trick (`useContext(createContext(1))`) means: those rows now use a `useTransition` child.
5. **W1a-5, contexts and constants of an imported hook's module.** A hook of another module may read a context that module declares (the frames pass carries it, named by that module's tag; the hook's field reads and scalar defaults are the component's needs) and a never-written module `const` of literal shape (`Direction.LTR` is folded into what the hook reads; any use that does not fold fails the hook). `use_scan` gets a precision for the foreign-hook table only: a member read of a primitive literal out of a module-level object literal is not an escape of the object.

Not in W1a: hooks in expression position (F286, knock2), `useIsHydrated` / body destructuring / `composeEventHandlers` (W1b), the `createCollection` recogniser (W1c), `DirectionProvider` as an arrow const (F284, knock2).

## 16. W1b record (implementer, 2026-10-16; stacked on W1a)

Provisional rows `W1b-1..3` (ledger numbers are the lead's). No page flips.

1. **W1b-1, `useIsHydrated` (R34.143, Q3).** `useSyncExternalStore(subscribe, () => true, () => false)` where `subscribe` returns a no-op unsubscribe (inline, or a function declared in the hook's module) is a state that is `false` in the server markup (React's `getServerSnapshot`) and in a hydrated mount, set `true` by a mount effect in a microtask (the component's other effects start first and see `false`, as in React), and seeded `true` in an instance that mounts after the page booted (`BehaviorCtx.late`: an x-if clone, an x-for row, a route swap; nothing of it was server-rendered) (review F1, Mellow + Afrojack). Every other `useSyncExternalStore` stays `hook-unsupported`. The real `@radix-ui/react-use-is-hydrated@0.1.3` is not that source: it exports `const useIsHydrated = typeof useReactSyncExternalStore === 'function' ? useIsHydratedModern : useIsHydratedLegacy`. Two supporting pieces: an exported `const` of that conditional resolves to the branch `hook_presence_test` decides (W1a-2), and the package-source integrity check (R34.62, `pkg-src.ts`) no longer reports a RELATIVE import alias (`import { useIsHydrated as useIsHydratedLegacy } from './legacy'`) as a name the published file lacks when the imported name is in the published file (the bundler resolves the alias to the sibling's declaration; a bare-specifier alias or an unknown imported name stays a refusal). Before this the package was refused outright (`the sources do not match the published ./dist/index.mjs`).
2. **W1b-2, a context local in the body (R34.144).** `const { on, flip } = context` and `const again = context` of a context local are read field by field, like the hook's own result (was `body-shape`, Radix's `RovingFocusGroupItem`).
3. **W1b-3, `composeEventHandlers` under a Provider (`jsx-const-child`).** Gone with W1b-2: it was a consequence of the refused body, not a rule of its own.

Left on the real roving group after W1a + W1b (probe `RovingFocusGroup` Root/Item): `useCollection` (W1c), `Collection.*` / `RovingFocusProvider` `member-tag`, a context value read inside a handler or effect (`context-escape`), `useCallback` in JSX attributes (F286), `forwardref-ref`, and `focusFirst`'s `document` read. The handler/effect context read needs its own row before W1d.
