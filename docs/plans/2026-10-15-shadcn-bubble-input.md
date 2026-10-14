# shadcn — can Radix's BubbleInput compile as written? (spike, read-only; for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · author: knock2 · task: `bubble-input-spike` · base: origin/main 68fa859a (2.0.0-alpha.12)

Question (Detoro's Q2 ruling): can the `BubbleInput` of Radix `switch` and `checkbox` (a ~100-line effect: `window.HTMLInputElement.prototype` descriptor, a bubbling `click`, `ResizeObserver` through `useSize`, five refs for controlled parents) compile **as written**, with **general** machinery: browser globals in effects, refs in effects, `useSize` as an ordinary inline hook, and no new recogniser and no runtime feature that ports it?

Everything below was run, not read. Probes, harness and outputs are in `docs/transcripts/bubble-input-spike/`. Source read: `@radix-ui/react-switch` 1.4.1 and `@radix-ui/react-checkbox` 1.4.1 from their source maps (the version `radix-ui` ^1.8.1 resolves to in the shadcn fixture).

## 1. Answer

**Yes for the BubbleInput itself; no, not by the compiler as it is today.** The part everyone worried about already compiles with no change: the effect with `window.HTMLInputElement.prototype`, `Object.getOwnPropertyDescriptor(...).set.call`, `new Event('click', { bubbles })`, `dispatchEvent`, five `useRef`s read and written inside the effect, and `useSize` (a `useLayoutEffect` with `ResizeObserver`, `requestAnimationFrame`, a cleanup, and `window.*` calls) inlined as an ordinary custom hook. No `browser-global`, no `hook-unsupported`, no diagnostic at all (probes p2, p4). The S0 `browser-global` rule fires for render-time reads only, as plan 2026-10-14-shadcn-context-lowering §3.6 guessed (that **[verify]** is now settled).

What blocks it is **six small, general gaps around the effect**, and one of them is silent. Four are lowering rules, one is a render-prop (`internal_do_not_use_render`), one is a parity bug. With those applied **by hand** to the same code, the component compiles Native, the page builds Static with 0 islands, and Chromium shows React's behaviour (§4). Nothing in the six is Radix-specific, none needs a recogniser, and none needs a runtime feature (the runtime's `x-ref`, `effect`, `onCleanup` already carry it).

Measured: switch page **90,955 B → 5,675 B gzip (−85.3 KB)**; the bubble input itself costs **1,169 B gzip** of that. See §5.

## 2. The as-written blockers (exact places)

Method: Radix's own `SwitchBubbleInput` and `SwitchTrigger` copied verbatim into the shadcn fixture with only two things replaced: `useSwitchContext(...)` (context lowering's job, Tiësto's lane) by a declaration, and `Primitive.x` (already a recogniser) by the plain tag. `useComposedRefs`, `useSize` and `composeEventHandlers` are the real package code. Line numbers are the line of the file in `docs/transcripts/bubble-input-spike/probe/` (`bubble-real.tsx`, `trigger-real.tsx`, `switch-real.tsx`); "Radix" is the package's `src/switch.tsx`.

| # | Diagnostic (file:line) | Radix construct | Why it fires (compiler site) | General rule that unblocks it (one line) |
|---|---|---|---|---|
| B1 | `fallback:ref-shape` bubble-real.tsx:105, trigger-real.tsx:45 | `ref={composedRefs}`, and `ref={setControl}` in the provider | a `ref` attribute must be a `useRef` binding (`analyze/jsx.rs:918`, `analyze/passes/tier.rs:219`) | **Callback ref:** `ref={x}` where `x` is not a `useRef` desugars to a synthetic `useRef` plus a mount effect that calls `setRef(x, node)` and, on cleanup, `setRef(x, null)` (`setRef` = call if a function, assign `.current` if an object, as `composeRefs` itself does). |
| B2 | `fallback:hook-shape` bubble-real.tsx:37, trigger-real.tsx:32 | `useComposedRefs(...refs)` = `useCallback(composeRefs(...refs), refs)` | custom hook with a rest parameter (`analyze/hooks.rs:1445`) | **Rest parameter of an inlined custom hook:** bind it to an array of the call-site arguments; `composeRefs(...refs)` is then an ordinary imported function call whose value is a function (a derived value, used by B1). |
| B3 | `fallback:forwardref-ref` bubble-real.tsx:19, trigger-real.tsx:15 | `forwardedRef` passed as an argument to `useComposedRefs` | the forwarded ref may only be `ref={ref}` on an element (`analyze/component.rs:496`) | **Forwarded ref as a value is `undefined`:** F153b already drops it and a call site that passes `ref` already falls back (`forwardref-ref` at the call site), so any read inside the component can safely be `undefined`. |
| B4 | `fallback:ref-in-render` bubble-real.tsx:108 | `defaultChecked={defaultChecked ?? defaultCheckedRef.current}`, with `const defaultCheckedRef = React.useRef(checked)` | a `useRef` read during render (`analyze/passes/placement.rs:1023`, owned by Tiësto: **not touched by this spike**) | **Never-written ref:** a `useRef(init)` that has no `.current =` write and no `ref=` binding is a snapshot of `init` at the first render; lower a render read as a once-initialised state cell (`useState(init)` never set). |
| B5 | `fallback:prop-pattern` bubble-real.tsx:125 | `style={{ ...props.style, ...controlSize, position: 'absolute', ... }}` | spread of a rest **key** inside an object literal reads the rest object "as a value" (`analyze/component.rs:554`) | **`...rest.key` in an object literal** is a read of that key (as `rest.key` already is, probe p8 B passes). |
| B6 | *(no diagnostic: a runtime `TypeError`)* | `const hasConsumerStoppedPropagation = event.isPropagationStopped()` in the click handlers of the trigger (and `composeEventHandlers`' consumers) | the handler is printed as written; a compiled handler receives a **native** DOM event, which has no `isPropagationStopped` | **React-only SyntheticEvent members map to DOM ones:** `isPropagationStopped()` → `event.cancelBubble`, `isDefaultPrevented()` → `event.defaultPrevented`, `persist()` → nothing, `nativeEvent` → the event itself; any other synthetic-only member is a named diagnostic, never a silent pass. |
| B7 | *(render prop)* switch-real.tsx:220 `island-prop`, :231 `jsx-outside-render`/`prop-pattern`, :111 `jsx-const-child`; same shape at Radix checkbox.tsx:246 | `Switch` and `Checkbox` render `<SwitchProvider internal_do_not_use_render={({ isFormControl }) => (<><SwitchTrigger/>{isFormControl && <SwitchBubbleInput/>}</>)}/>` and the provider does `isFunction(r) ? r(context) : children` | a function prop that builds JSX is a React island prop (`children.rs`, `island-prop`), and `jsx-const-child` fires on the call inside the provider | **Render-prop inlining:** a prop that the callee only ever *calls* (after an `isFunction`/`typeof` check, which folds to true when the call site passes an arrow) is beta-reduced at the call site, its parameters bound to the context fields. This is the largest item (§6). |
| B8 | *(parity, no diagnostic)* | `aria-checked={checked}` on the trigger | the template prints `aria-checked` only when the value is "present", and `false` is not: first paint omits `aria-checked` where React prints `aria-checked="false"`, and a switch toggled back off loses it (`lower/template.rs:911,915,1265,1269`; client `__attr` `lower/client.rs:199,342`) | **`aria-*` and `data-*` print booleans as `"true"`/`"false"`** (React does; `analyze/jsx.rs:959-963` already does it for the literal `true`). Dynamic `false` must too. |

React's own rendering of the attributes in B8, run in this lane: `renderToString(<button aria-checked={false} data-x={false} aria-hidden={false} hidden={false}/>)` gives `aria-checked="false" data-x="false" aria-hidden="false"` (and `hidden` omitted). The compiled switch served `aria: null` on first paint and again after the second click (probe zzprobe, §4).

What does **not** block, checked: `composeEventHandlers(onClick, (event) => {...})` as an `onClick` value (an imported function returning a handler; probe zzp9 builds and clicks correctly); `isFormControl = control ? !!form || !!control.closest('form') : true` as a derived value, with `{isFormControl && <input/>}` (zz10); `SwitchTrigger`'s form-reset effect (`control?.form`, `instanceof HTMLFormElement`, `addEventListener('reset')`) compiles with no diagnostic (trigger-real.tsx); `input.indeterminate = ...` in the checkbox effect is a plain property write. Checkbox shares the exact BubbleInput shape (Radix checkbox.tsx:321-405), so B1-B6 are the same findings there; `radio`, `radio-group`, `slider` and `select` have the same `*BubbleInput` and the same render prop (scoreboard rows `RadioBubbleInput`, `SliderBubbleInput`, `SelectBubbleInput`); only their `*BubbleInput` sources were checked for the render-prop string, the rules were not run on them (not measured).

## 3. The context dependency (not this spike's to solve)

Everything above assumes the context lowering of wave A (Tiësto): `useSwitchContext` becomes values from the provider's frame, and the provider, trigger and bubble input are inlined under one host, so `setControl`, `setBubbleInput`, `onUserClick` and the five refs live in **one behaviour scope**. If a frame cannot carry a **function** value across components (setters), B1 needs the setters threaded as implicit props too; that is a question for PR 3 of the context lowering, not for the rules here. I did not edit `placement.rs` or `pkg-src.ts`.

## 4. Proof (what I ran)

Probes (all in `docs/transcripts/bubble-input-spike/`, harness `diag.ts`, `measure.ts`, `behaviour-probe.ts`):

| Probe | What it is | Result |
|---|---|---|
| p1 | the Switch (trigger + bubble input + `useSize`) with callback refs and the render read, as Radix writes them | React: `ref-shape` ×2 (callback refs), `ref-in-render` (B1, B4) |
| p2 | p1 with `useRef` refs and no `useSize` | **Native**, the whole effect lowers (no `browser-global`) |
| p4 | p2 plus `useSize` as an inlined local hook, element fed by a mount effect | **Native**; the emitted chunk contains the `ResizeObserver`, rAF, `window.cancelAnimationFrame` and the cleanup, unchanged |
| p5 | p1 with B1, B3, B4, B6 applied by hand (a `useRef` + mount effect with cleanup instead of a callback ref; a state snapshot instead of the never-written ref; `event.cancelBubble`) | **Native**; page builds **Static, 0 islands** |
| zzprobe (p5 page) in Chromium | click the button twice inside a `<form>` with a `click` and a `change` listener | `aria-checked` true/null, `data-state` checked/unchecked, hidden `input.checked` true/false, the form saw **exactly one `click` per user click, from the INPUT** (the button stops propagation, as Radix does), no console error. `useSize` ran: the input's style carries `width:40px;height:20px` from the button |
| zzprobeb (same, `event.isPropagationStopped()` kept as written) | B6 | builds and serves **without a diagnostic**, then every click throws `s.isPropagationStopped is not a function`; the switch is dead, `data-state` never changes |
| zzp9 | p5 with `composeEventHandlers(onClick, fn)` from the package as the handler | builds, behaves like zzprobe |
| zz10 | p5 with `isFormControl` derived from `control.closest('form')` and the input conditional | builds, behaves like zzprobe |

The probe for B7 is the real source (`switch-real.tsx`): React tier with the three diagnostics in the table, and the trigger and the bubble input are never reached because they hide behind the render prop.

Not run (stated, not hidden): the form-`reset` effect and a controlled parent (`checked` changed by the parent, which is what the five refs are for) were compiled but not clicked; the Checkbox Indicator/Presence (wave A PR 3's runtime feature) and `indeterminate` were not built; no probe used a non-form parent.

## 5. Bytes (measured with the real `brust build`, `scripts/shadcn/app.ts` `buildPage`)

| Page | Client JS today (gzip) | With the rules (gzip) | Saved |
|---|---|---|---|
| switch | **90,955** (react-switch 85,817 + runtime 3,116 + rt-basics 955 + rt-island 787 + root 280) | **5,675** (runtime 3,116 + rt-basics 955 + chunk 1,604) | **−85,280** |
| checkbox | **93,142** | about 7–8 KB **[estimate: the switch chunk + the Indicator and the `presence` feature (plan estimate 1–1.5 KB) + `indeterminate`; not built]** | about −85,000 |

Cost of the bubble input alone: the same switch without the bubble input (button, thumb and a static hidden `<input>`, no `useSize`, no effect) is 4,441 B total with a 370 B chunk; with it the chunk is 1,539 B (1,604 B with `composeEventHandlers`). **The BubbleInput + `useSize` + the reset-less effect cost 1,169 B gzip (2,443 B raw).** That is the whole price of keeping the exact Radix behaviour; porting it by hand would save at most that.

## 6. Recommendation

1. **Do not build a per-primitive BubbleInput shim.** It would save at most 1.2 KB gzip per page and would be a recogniser, which the lead limited to two. Compile Radix's own code.
2. **Land four general rules and two fixes**, each its own small PR or a commit of wave A PR 3, in this order of value and risk:
   - **B8 `aria-*`/`data-*` boolean `false` prints `"false"`** and **B6 synthetic-event members**: both are correctness bugs that exist on main today independent of Radix (a native component with `aria-pressed={on}` loses the attribute when off; a handler calling `e.persist()` or `e.isDefaultPrevented()` throws). Smallest, no design risk; ship first with battery rows. B6 must also add a diagnostic for unknown synthetic-only members.
   - **B1 + B2 + B3 callback refs, rest-parameter hooks, forwarded ref as a value.** One desugaring and two relaxations in `jsx.rs`/`hooks.rs`/`component.rs`. `ref={fn}` is ordinary React (`react-use-measure`, `useCallbackRef` patterns, RHF `register`), so this serves users, not just Radix.
   - **B5 `...rest.key` in an object literal.** One line in `component.rs`.
   - **B4 never-written ref read in render.** `placement.rs` is Tiësto's: hand this one to him as a bullet in his PR 3, or have him allow it.
   - **B7 render-prop inlining.** The one real piece of design. It is also what any hand-written "slot as a function" in user code needs, so it is a general feature, not a Radix patch. It gates every BubbleInput page: the same `internal_do_not_use_render` string is in the sources of `radio`, `radio-group`, `slider` and `select` (checked in their source maps), so B7 is the critical path for all five primitives, while B1-B6 and B8 can ship earlier and are useful on their own.
3. **Then switch and checkbox flip with context lowering PR 3** (as Tiësto's plan §5 Q5 already orders). Expected: **switch −85 KB, checkbox about −85 KB** per page; the stop rule (R34.115, first flipped page above ~10 KB) holds with 5.7 KB measured.
4. The plan's R34.108 text ("the effect lowers to the component's behaviour as an effect with an `x-ref` and a DOM call") is confirmed as written; the only edit it needs is to name B1-B8 as its prerequisites.

## 7. Boundary if the lead accepts

`crates/brust-compiler/src/analyze/{jsx,hooks,component}.rs`, `analyze/passes/tier.rs`, `lower/{template,client,common}.rs`, `crates/brust-compiler/tests/**`, `scripts/battery/**` (rows for B1-B6, B8), `scripts/shadcn` scoreboard, `tests/server/*.chromium.test.ts` (a switch and a checkbox behaviour test: toggle, form sees one click, `aria-checked` false/true, reset, controlled parent). **Not** `placement.rs` (B4's change is a request to the owner). Review: Afrojack (parity), Mellow (B1's desugaring executes a user function at mount; B6 rewrites handler code). Gates: Illenium; one warm build.

## 8. Questions for the lead

- **Q1.** Accept "compile Radix's BubbleInput as written, no shim" (§6.1)? Recommended: yes.
- **Q2.** Ship B8 and B6 as a separate small correctness PR before wave A PR 3 (they are bugs on main)? Recommended: yes, today; I can take it.
- **Q3.** Who owns B7 render-prop inlining: Tiësto inside PR 3 (he is already in `children.rs`), or a separate lane? Recommended: Tiësto, because the context frame is what its parameters bind to.
- **Q4.** B4 touches `placement.rs`: Tiësto adds it to PR 3, or he rules it out and I do it after his PRs merge?

## 9. Lead ruling (2026-10-15)

owner: Detoro · authority: in-loop.

- **Q1: yes.** Radix's BubbleInput is compiled as written. There is no shim and no recogniser, because the spike shows the effect and `useSize` compile with general rules.
- **Q2: yes, now.** B6 and B8 are wrong output on main, so they ship as a small correctness PR (task `event-aria-correctness`, knock2) before wave A PR 3.
  - **B6:** `event.isPropagationStopped()` throws at runtime.
  - **B8:** a dynamic `aria-*` or `data-*` value of `false` is dropped, where React prints `"false"`.

  Ledger **F195** (B6) and **F196** (B8). Each comes with a served test equal to React, and with the class of names checked, not only the two found: every attribute where React stringifies booleans.
- **Q3: Tiësto owns B7** (render-prop inlining) inside PR 3, because the context frame is what its parameters bind to.
- **Q4: B4 also goes in PR 3,** but it is sequenced after `plain-wrapper-predicate` (Dew, also in `placement.rs`) merges. Tiësto rebases onto it, so the two lanes never edit `placement.rs` at the same time.
- The other enabling gaps (B1–B3, B5) belong to PR 3 under the same rule: each is a general rule with its own battery row, and nothing is specific to BubbleInput.
