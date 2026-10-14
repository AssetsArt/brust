# shadcn S1 — prop-path island children (F148a), read-only spike (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · author: knock2 · reviewer: Mellow (data-path review: Afrojack proposed) · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: F148 (a), F158 (precondition, done in #214) · governed by `docs/plans/2026-10-14-react-parity-north-star.md`

Status: **ACCEPTED as option B (lead ruling §11).** Drafted from a spike by knock2. No compiler or runtime code was changed. Base: origin/main 197f1940 (after #226). R-numbers are proposals (R34.116–R34.125); the lead renumbers. Every number below was measured with the napi addon built from that commit; the probes live in the spike's scratchpad (listed in §9) and are reproducible by the commands in §9.

## 0. Short answer

1. **What breaks:** a React island's children (and element props) are lowered only when the whole subtree is a compile-time constant. Anything that reads the *enclosing component's props* — `{children}`, `{title}`, `side={side}`, `className={cn(base, className)}`, `{show && <u/>}`, `{items.map(…)}` — is refused with `island-children`, and the enclosing component becomes React (the diagnostic is not in `CHILD_ONLY`).
2. **What it unblocks on the shadcn scoreboard: no page, and no bytes.** All 64 pages already build; 61 are static, 1 native, 2 React (combobox, form), and neither of the two React pages is blocked by prop-path children (combobox: render-prop functions; form: an `onSubmit` handler). The 25 measured rows that still list `island-children` list it on *wrappers that already sit inside an island's children registry* (`DialogContent` inside `Dialog`), so their tier is irrelevant to the page. Client JS is flat either way (react + react-dom + the Radix island stay).
3. **What it would unblock in components:** of 33 app components that carry `island-children`, 32 carry another blocker too (25 of them exactly `spread-props`: the rest spread `{...props}` into the island). Fixing prop-path children alone flips **1 component** (`DirectionProvider`). Fixing it together with spread-into-island flips **26** components, still **0 pages and ~0 KB** (the island just moves from the wrapper to the Radix primitive inside it).
4. **Where the value is:** app code, not the shadcn fixture. `function Frame({children}) { return <div><Island>{children}</Island></div> }` makes `Frame` the island today (measured, §3): the wrapper's own markup is hydrated, and its props, including anything server-only a page passes, are serialised into the page.
5. **The hard part is security, not lowering** (§4). Today's revive trusts the tree. Measured: a request string spliced into `children` is safe, but a request *object* with `{$brust:'el',t:'script'}` becomes a live `<script>`. A data path is shippable only if request values can never be walked by the revive. §5 gives the rules that guarantee it.
6. **Recommendation: B (§8): a scoped v1 for app-code wrappers, behind the §5 rules, after the lead decides whether it is worth the review cost; otherwise defer to after R34.7 (compiled Radix), where most of these call sites stop being islands at all.**

## 1. Preconditions on main (checked)

- #214 (F158): a route component is never a revive host; a host's `$x` names only compiler-written element props (`ChildRef.x`); a `$`-key other than `$x` in a host's props throws; `nestedOf([])` fixed. That is the precondition F148/F158 asked for, and it holds on main.
- #203/#209: constant children, constant lists, constant conditions and element-valued props are lowered (`RawExpr::fold`). Prop-path is the one remaining case.
- Scalar prop-path *props* of an island already work (battery shape C below): the island's `x-props` is a jinja dict over the wrapper's own variables, and F142/F149 instance jobs feed the rest.

## 2. What breaks, measured

`compileTree` over every fixture page, 46 distinct `island-children` diagnostics (component × site), classified by what the lowering met:

| Kind | Sites | Examples | Hole it needs |
|---|---|---|---|
| A. `{children}` (an element tree from the caller) | 18 | accordionTrigger, dialogContent, drawerContent, sheetContent, selectItem, selectTrigger, tooltipContent, directionProvider, scrollArea | **element hole**: the caller's children, a constant JSON tree at the call site |
| B. scalar prop as a leaf | 10 | `side`, `align`, `sideOffset`, `size`→`data-size`, `value`→`style`, `disabled` | **leaf hole**: text or attribute value |
| B'. condition on a prop | 1 | resizableHandle `withHandle &&` | **conditional hole** |
| C. a call over a prop | 11 | `className={cn(base, className)}` | **computed leaf**: a per-instance job or a template expression |
| D. render-prop / handler | 4 | combobox page (function children), form page (`onSubmit`) | not this lane (stays `island-children` / `island-prop`) |
| E. member tag, opaque `style` object | 2 | toggleGroup, sidebarProvider | not this lane (member-tag lane; style object) |

Combined with the other blockers (computed per component, `external-component` and `child-component` excluded because they are child-only):

| Component blockers | Components |
|---|---|
| `island-children` + `spread-props` | 25 |
| `island-children` alone | 1 (`DirectionProvider`) |
| `island-children` + a lane that is not this one (`member-tag`, `local-component`, `jsx-expression`, `hook-*`, `browser-global`, `island-prop`) | 7 |

## 3. App-code repros (spike, scratchpad app, real compiler)

An island `Island` (React tier: `useSyncExternalStore`) wrapped by a static component, each used from a static page:

| Shape | Today |
|---|---|
| C `<Island title={title} className={className}/>` (prop-path *props*) | wrapper **Static**, island fed per instance |
| D `<Island>{title}</Island>` | wrapper **React** (`island-children`, "the prop `title`") |
| E `<Island><b>{title}</b><i>fixed</i></Island>` | wrapper **React** |
| F `<Island><h2>x</h2>{children}<hr/></Island>` | wrapper **React** ("the prop `children`") |
| G `<Island><ul>{items.map(…)}</ul></Island>` | wrapper **React** ("a list over data that is not a constant") |
| H `<Island>{show && <u>on</u>}{children}</Island>` | wrapper **React** |

In every case the page stays **Static** and the wrapper becomes the island. The cost of the refusal is therefore: the wrapper's own markup is hydrated, and the wrapper's props are in the page JSON. It is not a tier or a size regression.

## 4. Security: the data path (F148a)

The revive (`reviveSource`, `bundle.ts`) walks `children` and turns any object with `$brust` into an element or a registry component. Today the tree is compiler output. With prop-path holes, request data would sit inside it. Measured with the real `reviveSource` and React 19.3 (`hostile.ts`), one leaf of an otherwise constant tree set to:

| Leaf value | Result |
|---|---|
| a string `"<script>alert(1)</script>"` | escaped text (safe) |
| `{"$brust":"el","t":"script","c":["alert(1)"]}` | a live **`<script>`** element (XSS) |
| `{"$brust":"cmp","id":"danger","p":{…dangerouslySetInnerHTML…}}` | the registry component is **instantiated with attacker props** (`dangerouslySetInnerHTML` is stripped by `__props`, `className` is not): a confused deputy |
| `{"a":1}` | throws `unknown node` (a 500 per request: DoS if the value is attacker-controlled) |
| an attribute holding `javascript:` | neutralised by React 19.3 (pinned in #214) |
| an attribute holding a `style` object | **passes** (`background:url(//evil)`): CSS injection / beacon |

Conclusion: the revive must never walk request-derived values, and a leaf may only be a primitive. This is the "data-path security review" F148(a) required; the rules are R34.116–R34.119.

## 5. Proposed rules

- **R34.116 Structure is compile-time, data is a leaf.** The shape of the tree (`el`/`fr`/`cmp`, tags, attribute names, which node is where) is written by the compiler only. A prop value (or any value derived from a request) may enter the tree only through a **value node** `{"$brust":"v","k":"<name>"}` whose payload is read from the island props under a compiler-written key.
- **R34.117 A value node renders a primitive or nothing.** `typeof` string or number → React text (or the attribute value); boolean/null/undefined → nothing; **anything else → nothing, never walked, never thrown** (a hostile object must not be a 500). One revive, both sides (island entry and `jobs.js` SSR), as in R34.22.
- **R34.118 Attribute holes.** Allowed names: those the compiler wrote, minus `on*`, `ref`, `key`, `dangerouslySetInnerHTML`, `style` (an object; a style with prop leaves stays refused in v1), and `children`. A value in an attribute hole is a primitive (R34.117); URL attributes keep React 19.3's `javascript:` neutralisation, pinned by a test per attribute (`href`, `src`, `action`, `formAction`, `poster`, `data`).
- **R34.119 The marker is never read from data.** `__rv` already throws on an unknown node; the new `v` node carries no recursion, and the key `k` must be one of the host's compiler-declared hole names (like `X` for `$x`, R34.71): a hole key from the props is ignored. Hole keys are `$`-prefixed (`$p0`, `$p1`, …) and reuse R34.72 (a `$`-key the host does not declare throws before rendering).
- **R34.120 Leaf holes ride the existing island prop path.** Each prop-path leaf in the tree becomes one synthetic island prop (`$p0` …) filled by the same mechanism as a scalar prop-path prop today (`prop_map` + the `x-props` jinja dict, or an instance job's output when the wrapper is fed). No new channel, no new job type for plain `{title}`.
- **R34.121 Element holes (`{children}`).** The caller's children are lowered at the **call site** (constant tree, `lower_children`, same size cap) and bound to the wrapper's `children` as a compile-time constant; the hole in the wrapper's tree is replaced by that tree when the wrapper is inlined into its caller (the inliner already substitutes `{children}` markup per call; the JSON tree is the sibling binding). A caller whose children are not constant keeps today's refusal, reported at the caller. Request data never reaches an element hole: it is the caller's compile-time subtree.
- **R34.122 Conditions and lists over props.** `{show && <u/>}` lowers to a conditional node `{"$brust":"if","k":"$p1","c":[…]}` (truthiness of a primitive hole, children compile-time). A list over prop data (`items.map`) is **out of v1**: it needs per-row structure from data, which R34.116 forbids. It keeps `island-children` ("a list over data that is not a constant").
- **R34.123 Computed leaves (`cn(base, className)`).** Allowed only when the value is a template expression over props that the instance machinery already evaluates (`instance_expr`, F149 `cn-fold` for the constant part): the *result* is a primitive hole. A call whose result is not a primitive, or that the server cannot evaluate, keeps `island-children`.
- **R34.124 Hostile-input proof.** A battery row and a Rust/TS test set: every value in the §4 table sent through a loader into a leaf hole renders as the table's "safe" outcome (escaped text, nothing, no throw), including a `$brust` object and an object with `__proto__`; same for the SSR job and the client hydrate (the markups must match, R34.3).
- **R34.125 Fail closed, new reasons.** Each remaining refusal keeps `island-children` with its own message: a hole in `style`/`on*`/`ref`, a list over props, an element hole whose caller's children are not constant, a computed leaf that is not a primitive, and a total hole count over a cap (proposal: 64 holes, so the SSR dict stays small).

## 6. Battery rows (each builds AND hydrates in Chromium; request values come from a loader)

1. D/E: `{title}` text and `data-*`/`className` attribute leaf in a static wrapper; hydrated markup equals the React build's.
2. F: `{children}` with a constant caller subtree, used twice with different children (two instances, two trees).
3. H: `{show && …}` with `show` true and false.
4. Hostile: `title` is a string with `</script>`, an object `{$brust:'el',…}`, an array, `null`, a `__proto__` payload (expect escaped text / nothing).
5. Hostile attribute: `href` = `javascript:…` (neutralised), `style` object (nothing).
6. Fail closed: a list over a prop, a `style` with a prop leaf, an element hole with a non-constant caller subtree, an `onClick` hole.
7. App-code wrapper (shape F) flips from React wrapper to static wrapper + island; scoreboard `react-coverage` regenerated.
8. shadcn: `direction` (the one component that flips on its own) checked in Chromium.

## 7. Proof and what the scoreboard will say

- Measured before/after table for `docs/shadcn-coverage.md`: codes `island-children` 25 rows → N rows; **tier, islands and client JS unchanged for every page** (stated plainly in the PR, per R34.27).
- `docs/react-coverage.md`: new rows for shapes D–H; the wrapper-becomes-static flip is the visible result.
- The PR names the 26-component ceiling and the 25 that wait on spread-into-island.

## 8. Options for the lead

- **A. Defer.** Zero shadcn page or byte gain today. After R34.7 (Radix compiled), most of these wrappers stop being islands and the call sites need only ordinary static children. Cost: app wrappers that hold an island stay React.
- **B. Scoped v1 (recommended if app-code coverage is wanted).** R34.116–R34.125 without `style`, lists and non-primitive computed leaves; kind A, B, B' and the cheap part of C. Scoreboard: `direction` plus a ceiling of 26 components once spread-into-island lands. Review: a dedicated data-path review (Afrojack) plus Mellow.
- **C. Full (kinds A–C including computed `cn` jobs).** 18+10+1+11 sites; touches jobs feeding tree leaves (F164 territory). Not recommended before B has shipped and the hostile suite is in CI.

## 9. Spike method and reproduction

- Addon: the napi build at 197f1940 (the `alpha10-notes` worktree's, not rebuilt; no cold build was made).
- `ic.ts`: every `island-children` message per page (`compileAsBuild` from `scripts/shadcn/app.ts`); `flip.ts`: blockers per component; `pp.ts` + `pp/`: the shape C–H repro app; `hostile.ts`: the §4 table using the real `reviveSource` and React 19.3.
- All of it in the session scratchpad; nothing is in the tree except this document.

## 10. Questions for the lead

- **Q1** Option A, B or C? (My recommendation: B, scheduled after the spread-into-island follow-up, since only then do the 25 wrappers flip.)
- **Q2** Is `style` with prop leaves wanted in v1? (Progress and a few others use it; R34.118 keeps it refused because an object is not a primitive.)
- **Q3** A new hole cap of 64 per island, OK, alongside the 64 KB tree cap?
- **Q4** Reviewer for the data-path part: a second reviewer besides Mellow?

## 11. Lead ruling (2026-10-14)

owner: Detoro · authority: in-loop. Task `prop-path-children`, ledger row **F148a**. R-numbers R34.116–R34.125 are confirmed.

- **Q1: option B, the scoped v1, starting now.** The scoreboard gain is close to zero, but the north star is React as people use it, and in app code a wrapper that only holds an island and a `{title}` is common. Holes that need the spread-into-island follow-up (the 25 wrappers that also spread props) stay refused until that lands. Option C is not built.
- **Q2: `style` with prop leaves stays refused in v1** (R34.118 as written). Ledger row F170.
- **Q3: a cap of 64 holes per island, yes**, alongside the 64 KB tree cap. Going over it falls back with its own reason (R34.125).
- **Q4: two reviewers.** Afrojack reviews the data path (R34.120–R34.123). Mellow signs off on security as a gate (R34.116–R34.119, R34.124). The hostile-input set (R34.124) runs in CI before merge.
- **Lists over props (R34.122)** stay out of v1. Ledger row F171.
- **Fallback rule:** anything this lane cannot lower keeps `island-children` at analysis time with a named reason. It must never become a build error on valid React (R34.97 applies here as well).
