# spread-live: live keys through a forwarder's `{...props}` spread (F296, design note, no code shipped)

owner: Detoro · authority: in-loop · author: Guetta · task: `spread-live-design` · base: origin/main 2aec3997 (2.0.0-alpha.16); stock-compiler probes ran on origin/main 47339104.
Status: **ACCEPTED (option A), see §12.** Nothing here is committed code: one one-line spike (§4.2) was built and run, never committed.

## 1. Answer

The note was asked what the **runtime** must do so a live value or handler can reach an element through a `Primitive.*` spread. Measured answer: **for the real switch and checkbox BubbleInput, the runtime must do nothing new.** The element the spread lands on is the *parent's* element once the static forwarder is inlined, and the parent already binds live `style` and a composed `onClick` on a hand-written element (`x-bind-style`, `x-on-click`, with the server's `css_decls` first paint). The single thing missing is a **compiler gate**: shipped R34.18 (handlers, S1.3; live values, 2b) forwards live keys through a *static* child's spread, but `live_key_ok` (`children.rs`) lists `style` among the keys it refuses, so `style={{ ...controlSize }}` links the child and the composed `onClick` is refused with it.

**Recommendation: option A (§5): admit `style` through a static child's spread, with the rules the 2b design already has (later-wins by position, one landing element, read-nowhere-else).** Measured with a one-line spike: the real `SwitchBubbleInput` (S1 edit applied) goes Native with `x-on-click`, `x-bind-style` and `x-ref` on its `<input>`, `Primitive.input` stays Static, and the chunk grows **+883 B raw / +443 B gzip** (§6). **Do not build a client spread sink (option C)** and do not build the linked-child binding (option B) until a real page needs it; §4.3 says what each would be and what would force it.

This does **not** flip the switch page alone: Dew's S1, S3 and S4 stand (§8).

## 2. What stops the real switch (restated, measured by Dew, reproduced here)

Dew's step-0 verdict (scratchpad `sbi/verdict.md`): the published `SwitchBubbleInput` holds two live values that reach `<input>` through `Primitive.input`'s spread: `defaultChecked={defaultChecked ?? defaultCheckedRef.current}` (S1: a never-written ref seeded by live state) and `style={{ ...props.style, ...controlSize, position: 'absolute', … }}` (S2: `useSize` is state set in a layout effect). `Primitive.input` is `forwardRef((props, ref) => { const { asChild, ...primitiveProps } = props; const Comp = asChild ? Slot : node; return <Comp {...primitiveProps} ref={ref} /> })`: a static forwarder with one spread landing on one element.

Reproduced with Dew's harness on the real package source (switch page `pages/sw-bi.tsx`, `BubbleInput` alone):

| edit to the published source | `SwitchBubbleInput` |
|---|---|
| none | React: `spread-handler`: `onClick` reaches an element through the spread of `<Primitive.input>`, which is linked (another prop of it changes on the client) |
| S1 only (`defaultChecked={defaultChecked}`) | React: the same `spread-handler` (the live `style` links the child, so the composed `onClick` is refused with it) |
| S1 + `...controlSize` removed | Native (the page still reports `context-no-provider`, an artefact of the probe page having no Provider above it) |
| S1, `<Primitive.input` replaced by `<input` (the element written directly) | **Native**, `x-on-click`, `x-bind-style`, `x-ref` on the input |

The last two rows are the point: the same props on a hand-written `<input>` are Native. The runtime already has what the forwarded element needs; the compiler does not hand it over.

## 3. What exists today (so nothing is designed twice)

- **Server:** a spread prints once, `spread_attrs([...segs])` (`brust-jinja/src/filters/spread.rs`): attribute-name grammar check, `on*`/`x-*`/`srcdoc`/`children`/`key`/`ref` never printed, URL guard, React names mapped, **later-wins** by `omit_attrs([...])` for keys the element writes after the spread (visible in the probe output: `... | omit_attrs(["tabIndex", "style"])`).
- **Client:** per-key directives written by the compiler on elements of the component's own scope: `x-bind-<attr>="_cN"` (value painted by `attr_kind`: `__attr`, `__attrs` for `aria-*`/`data-*`, `__bool`, `__css` for `style`), `x-on-<event>="_hN"`, `x-ref`. Names are compile-time constants; there is no directive whose attribute name is computed at runtime.
- **R34.18 (S1.3 + 2b, shipped):** when a *static, unlinked* child spreads its rest on exactly one element and reads a key nowhere else, the parent binds that key on the child's element **in the parent's scope** (`HandlerDecl.forwarded`, `ComponentIR::live_forwards`, `forward_handlers`, `forward_live` in `analyze/passes/children.rs`); the child stays static, no chunk, no `x-props-bind`. `check_spread` refuses everything else with its own code.
- **`live_key_ok`** is the one gate for a live key's name: attribute-name grammar (React and HTML name), not `on*`, not `x-*`, not a URL attribute, and **not** `class`, `style`, `value`, `checked`, `selected`, `children`, `key`, `ref`, `className`, `dangerouslySetInnerHTML`.

## 4. Measured

### 4.1 Stock compiler: the matrix of live keys through a forwarder

Fixtures: `docs/transcripts/spread-live/app/` (`Fwd.tsx` = `({ ...props }) => <input type="checkbox" {...props} />`; `p_*`/`q_*` are a native parent with `useState` rendering the forwarder with one live prop). Harness: `show.ts` (calls `compileTree` as `brust build` does).

| case | result (stock compiler) |
|---|---|
| `data-w={w}` + `onClick`, static `Fwd` | **Native** (R34.18 works; the child is Static) |
| `style={{ width: w }}` | React, `spread-props` ("a value that changes on the client … HTML only") |
| `style` when the child writes its own `style` before / after the spread | React, `spread-props` (both) |
| `className`, `value`, `checked`, `href` | React, `spread-props` (all four are on `live_key_ok`'s list) |
| `data-w` through a forwarder that spreads on two elements | React, `spread-props` (one landing element is a rule) |
| `style` that the forwarder also **reads by name** (`({ style, ...props })`) | Native: the key is a prop of the child (the linked path), not a spread key |
| live `data-w` through a **Native** child (it has its own state; spread before its own attrs) | React, `spread-props` |
| `onClick` through that Native child | React, `spread-handler`: "`<FwdNative>` is not static (a handler can be bound only on a static child's element)" |
| a constant key through that Native child | Native (`spread_attrs` prints it once; nothing live to bind) |
| the same `style` on a hand-written `<input>` | Native: `style="{{ css_decls("position", "absolute", "width", w) | e }}" x-bind-style="_c1"`, client `_c1 = computed(() => __css({ width: w(), position: "absolute" }))` |

### 4.2 The one-line spike

Spike: remove `"style"` from the refused list in `live_key_ok`. Built once (debug, 12 min; announced on the task), run on the same fixtures and on the real package source.

| case | result with the spike |
|---|---|
| `style={{ width: w }}` through `Fwd` | **Native**; the markup and the client chunk are byte-identical to the hand-written `<input style={…}>` of §4.1 |
| child writes `style={{ color: 'red' }}` **before** `{...props}` | Native; prints `style="…width…"` and binds it (React: the spread's `style` replaces the child's, it does not merge) |
| child writes `style` **after** `{...props}` | Native; prints the child's `style="color:red"` and binds **nothing** (React: the child's own value wins; `child.spread.lands(k)` is false) |
| child reads `style` by name | unchanged (Native, the linked path) |
| the real `SwitchBubbleInput`, S1 edit | **Native**: `x-on-click="_h2"`, `x-bind-style="_c1"`, `x-ref="_rf1"` on the `<input>`; `Primitive.input` **Static** |

So the existing machinery (`lands`, spread-after, `onward.reads`, the 2b link check) already decides the position and ownership questions; `style` was excluded by a conservative list, not by a missing mechanism.

### 4.3 What the linked child needs, and why not now

A *Native* child that forwards (the `FwdNative` rows) cannot take parent-scope bindings: its root is its own host, so a directive written by the parent resolves in the child's scope (2b amendment §2, shape A, rejected). Two designs exist:

- **B. Child-scope per-key binding.** The compiler gives the child's chunk `x-bind-<k>="_cK"` / `x-on-<ev>="_hK"` on the spread's element for the **union of keys every call site writes** (all known when call sites compile; the S1.2 amendment's objection is the one chunk per component: the union must be the same in every instance, and a call site that does not pass a key gives `undefined`, which React omits). Values read `props().<k>` (props already cross as JSON via `x-props-bind`; function props pass through); no new directive, no new sink. A call site that spreads unknown keys into the component is refused by name (`spread-props`: "may replace it"), as 2b rule 3. Cost: the union's directives and computeds in the child chunk, on every page that uses the component; no runtime change.
- **C. A generic client sink** (`x-spread="_c"` applying a runtime object to the element). Rejected: it is an attribute-name-from-data sink on the client (the F94/R34.17 class), and it must reproduce `spread_attrs` (name grammar, `on*`/`x-*`, URL guard, aliases, booleans, style). A sketch of the least it must do (`docs/transcripts/spread-live/spread-sketch.js`, **not** shipped, not tested for parity) is **1,819 B minified / 1,015 B gzip**, once per page that uses it, before the parity tests it would need.

**What would force B:** a page where the forwarder has state or handlers of its own. None was found on the switch or checkbox pages (Dew's step 0, and the BubbleInput above). The roving-collection plan's `spread-props` rows are described there as inflated by the one-component-at-a-time survey; whether a real roving item forwards through a linked child is **not measured** and should be re-measured on the first roving page (wave B) before B is built.

## 5. Options

| | A. admit `style` (and later `className`) through a static child's spread | B. child-scope per-key binding | C. generic client sink |
|---|---|---|---|
| answers the switch/checkbox BubbleInput | **yes, measured** (§4.2) | yes, more than needed | yes, more than needed |
| runtime change | none | none | new directive + helper (~1 KB gz) |
| new attribute sink | none (`x-bind-style`/`__css` already exist) | none | **yes** (client, name from data) |
| compiler change | one gate (`live_key_ok`) + rows | union of call-site keys per component; link bookkeeping | print + parity with `spread_attrs` |
| linked/native forwarders | still refused (named) | covered | covered |
| cost on the switch BubbleInput chunk | **+883 B raw / +443 B gz** (measured) | not measured (estimate: two directives + two computeds per key) | +1,015 B gz sketch, plus the chunk |

**Recommendation: A now; B only when a measured page needs it; never C** (C re-creates on the client what the compiler gives for free, and it is the one option that adds an injection surface).

## 6. Cost (item 5 of the brief)

Measured on the real `SwitchBubbleInput` chunk (the `bubbleInput` component, S1 edit applied, compiled with the package map; `clientJs` gzip -9):

| variant | client raw | gzip |
|---|---|---|
| `...controlSize` removed (no live style) | 5,387 B | 1,488 B |
| spike: live style through `Primitive.input` | 6,270 B | **1,931 B** |
| `<input>` written directly with live style (what A is equivalent to; the `x-props` plumbing differs) | 6,984 B | 2,055 B |

A's price on this chunk is +883 B raw / +443 B gzip: the `__css` helper (about 600 B raw, once per chunk that binds a style) and one computed. For scale, knock2's whole bubble-input spike measured the BubbleInput + `useSize` at 1,169 B gzip and the switch page at 5,675 B gzip with its six general rules (R34.115's stop rule is ~10 KB).

**Not measured, stated:** the whole switch page with S1/S3/S4 (they are compiler gaps, not package edits, so there is no honest page to build); the checkbox page; Chromium behaviour. The Option B figure is an estimate, labelled so.

## 7. Soundness conditions (for Mellow) and the server contract

Admitting `style` is sound only with all of these (each already holds for the keys R34.18 forwards today unless marked **new**):

1. The child is `Tier::Static` and nothing else live keeps it linked after forwarding (`instance_needs_link` is `None`); otherwise refuse with the existing code.
2. The spread lands on **exactly one** element (`onward.spread_sites == 1`), the child reads the key nowhere else and does not pass it to a component (`onward.reads`, `onward.components`). Two landing elements: refuse (§4.1, `FwdTwo`).
3. **Later-wins by position:** a `style` the element writes after the spread means the key does not land (`spread.lands`), nothing is bound; an unknown spread after the call site's key refuses (2b rule 3).
4. **Replace, not merge** (React): the forwarded `style` replaces the element's own, never merges. **New** (style-specific): a test with the child's own `style` before the spread, which binds the forwarded value.
5. The **name** is the compile-time key `style` through the same gate a written attribute passes; `live_key_ok` stays the single place that decides names, and its refused list shrinks by exactly this one entry. `value`/`checked`/`selected` stay refused (property semantics, a model), URL attributes stay refused (the empty-`href` asymmetry the code comments), `class`/`className` are a **separate row with its own measurement** (same machinery, not measured here).
6. **No new sink:** the value reaches the DOM only through the shipped `x-bind-style` + `__css` (drops non-object values; keys must match `--x|letters`; values containing `; { } \ newline /* expression( @import` are dropped) and, on the server, `css_decls`. `html_raw` stays the only raw sink. A hostile key cannot be minted: the object's keys are the *value's* (data), filtered by `__css`'s key regex, not attribute names.
7. **Question for Mellow (pre-existing, not widened by the code, widened in exposure):** `__css`/`css_decls` do not reject `url(…)`; hand-written `style={{ background: x }}` has the same property today. Values now also arrive through a spread. Confirm that this is acceptable as is, or name a filter to add to both printers.
8. **Server/first-paint contract (served == React):** the element's first paint is the server's `style="{{ css_decls(...) }}"` over the same merged object the client computes (`_cN`), so hydration repaints an equal value. The rest of the spread prints through `spread_attrs` with `omit_attrs([...])` for keys the element writes later; the forwarded key is **not** in that spread (it left `props`), so it is printed once.

**Handler through the instance:** `composeEventHandlers(props.onClick, …)` is evaluated per event in the parent's `_hN`, exactly as 2b §4 specified; this lane changes nothing there. What changes is only that the instance is no longer linked by the live style, so the S1.3 hoist (which required "no link for the rest") applies. The spike shows `x-on-click="_h2"` on the input.

**Attribute vs property per key** (item 3 of the brief): `style` is written as the `style` attribute (a string) by the shipped binder; every other key the compiler may forward is an attribute written through `__attr`/`__attrs`/`__bool`. `value`/`checked`/`selected` are properties and are excluded, so no per-key property table is added.

## 8. What this does not do

The switch page still has S1 (`defaultCheckedRef.current`, a snapshot seeded by live state), S3 (`isFormControl`'s dead branch makes a job) and S4 (the Thumb carried in `__in_rest`); the BubbleInput also needs its callback ref (`composedRefs`) bound (the probe shows `x-ref="_rf1"`, so it does today). The first served test of the BubbleInput effect (`bubbleInput` state set by a ref callback, then the dispatch) is still the first of any lane and is unrun.

## 9. Plan if accepted (tests and rows; no code in this note)

Lane `spread-live`, one commit: the `live_key_ok` change plus rows in `scripts/battery/rows.ts`, `crates/brust-compiler/tests/`, regenerated `docs/shadcn-coverage.*`:

- `c-live-forward-style`: native (the §4.2 case); `…-own-before`: native, binds; `…-own-after`: native, binds nothing; `…-two-elements`: react; `…-read-by-name`: native; `…-native-child`: react, `spread-props`; `…-unknown-spread-after`: react; `value`, `checked`, `href` stay react (rows, today only implied).
- A served test, `served == React`: a native parent with state and a forwarder, first paint equal to `renderToStaticMarkup`, then Chromium: a click changes the style and the composed `onClick` runs first (and `preventDefault` stops ours), as 2b §4.
- The real-package check: `SwitchBubbleInput` (S1 applied) Native with `Primitive.input` Static, in `tests/` against the shadcn fixture.
- Review: Afrojack (parity), Mellow (the sink, §7.7).

## 10. Questions for the lead

- **Q1.** Accept option A (admit `style` through a static forwarder; no runtime work)? Recommended: yes.
- **Q2.** Is `className` in the same lane (one more entry off the list, with its own row and a `class`-binder check), or separate? Recommended: separate row, same lane if its check is green.
- **Q3.** Keep B parked until a roving page measures a linked forwarder? Recommended: yes; C is not proposed.
- **Q4.** Mellow's `url(…)` question (§7.7): a row of its own if the answer is "filter", independent of this lane.

## 11. How to reproduce

`docs/transcripts/spread-live/`: `app/` (the hand-written fixtures), `show.ts` (point it at a worktree with a built addon and run `bun show.ts <root> <page> [componentIdPrefix]`; `PK=1` reads a `.probe-packages.json` for package-source probes), `spread-sketch.js` (the §4.3 size sketch). The real-package probes used Dew's `sbi` harness (`probe.ts`, `bisect.py`: edits `defref`, `size`, plus `<Primitive.input` → `<input`).

## 12. Lead ruling (2026-10-16)

owner: Detoro · authority: in-loop. Mellow and Afrojack both PASS on the note. Status: **ACCEPTED, option A**.

- **Q1: yes, option A.** `style` comes off `live_key_ok`'s refused list, through a static forwarder only, under all of §7's conditions. There is no runtime work. Lane `spread-live`, implementer Guetta (ledger F296).
- **Mellow's added conditions bind the lane:**
  - **C1:** the `asChild`/Slot merge of `style` is refused, with battery rows. Slot merges styles, so "replace" (§7.4) does not hold there.
  - **C2:** a live `style` that becomes `undefined` drops the element's own `style`, as React does. Test it served and in Chromium.
  - **C3:** first-paint parity on style edge values (`0`, unitless numbers, custom properties, an empty object).
- **§7.7, `url(…)`:** acceptable as is (React parity, Mellow). No filter and no row.
- **Q2: `className` is a separate row** (F299) in the same lane, only if its own `class`-binder check is green. Otherwise it gets its own lane.
- **Q3: option B stays parked** until a roving page (wave B, W1d toggle-group) measures a linked forwarder. **Option C: never.**
- **Afrojack's five non-blocking concerns are lane work:** row ids and category; the stale `live_key_ok` comment; `css_decls` vs `style_css` plus the own-before served case; ci.yml wiring of the new tests; a string-`style` row.
- **Gate and review:** PR CI. Reviews: Afrojack (parity), Mellow (the sink and C1-C3).

## 13. Implementation record (lane `spread-live`, Guetta; F296 style, F299 className)

Shipped as option A with the §12 conditions. What the lane found beyond the note, all measured against react-dom 19 in `tests/server/live-style.chromium.test.ts`:

- **The gate:** `live_key_ok` no longer refuses `style` or `className`; `style_may_merge` refuses both when the child may render a Slot (C1; without it a literal `asChild` instance is a compile error, mutation-checked).
- **First paint was not React's for literal styles, also hand-written ones (C3):** the printer sorted a literal object's declarations by key (a later `margin: 0` came before `marginTop: 5`, so the longhand won), listed only nine unitless properties (`aspectRatio: 1` printed `1px`; `WebkitLineClamp` too), did not trim string values, printed `msTransform` as `ms-transform`, and printed `style=""` for an empty object. Now: source order (a repeated key keeps its first place and its last value, `obj_lit`), react-dom's unitless list (also vendor-prefixed; the client's `__css` helper is generated from the same Rust list), trimmed strings, `-ms-`, and no attribute when no declaration is left (`css_attr`, `style_attr`).
- **Cost:** the unitless list adds about 0.6 KB raw to a chunk that binds a style; the real `SwitchBubbleInput` chunk is the §6 figure plus that.
- **C2:** a live `style`/`className` that becomes `undefined` drops the forwarder's own value (React does): the first paint omits it, the binder writes it empty (a hand-written bound attribute does the same), so the DOM compare treats an empty `style`/`class` as absent.
- **Not done, stated:** option B and C stay parked/never; a string `style` is not an error (React throws): brust writes nothing, as for a hand-written element.
