# shadcn S1 — lane `island-children` (draft for the lead's ruling)

Author: Guetta. Status: **DRAFT, no code, no lane until ruled.** Base: origin/main 824ce423. Numbers are from `docs/shadcn-coverage.md` at that commit (45 measured rows carry `fallback:island-children`, ranked #1). R-numbers continue after R34.20 (S1.3).

## 1. What the diagnostic is today

`crates/brust-compiler/src/analyze/passes/children.rs:714-723`, in `Walker::component`, for a child that resolved to the **React tier**: if the JSX call has children between the tags, push `Diagnostic::fallback("island-children", "JSX children passed to the React island <X>")`. It is not in `CHILD_ONLY` (`passes/tier.rs`), so it makes the **parent** React too, and the whole page becomes one island (`tier.rs:~55`). It is fail-closed on purpose: an island hydrates from a JSON props object, and JSX children are not JSON.

It is a *symptom*, not a root cause. It fires only when a child is already React for another reason (`member-tag` 36 rows, `local-component` 23, `spread-props` 28, `external-component` 17). Reading the generated table:

- 40 of the 45 rows have exactly one page-level blocker: `pages/<row>.tsx#<row>: island-children`. Examples: button (9 `<Button>` with text), card, tabs, dialog, select, dropdown-menu, tooltip.
- 5 rows add other page-level codes (chart, combobox, carousel, button-alias, input-otp) and will not flip.
- 3 of the 4 refused rows (calendar, form, sidebar, sonner) are `island-prop`, not this lane.

## 2. What flips, honestly

Flip = page `Tier` react → static/native, with the React children as islands (like `progress`/`slider` today: tier static, 1 island).

- **Moves:** ~40 measured rows: page tier, island structure, and the page chrome stops being React-rendered. `docs/shadcn-coverage.md` rows change from `react / 1 island` to `static|native / N islands`.
- **Does NOT move:** client JS. Every island still pulls react + react-dom (~70-85 KB gzip shared chunk) while `Button` (local-component+spread-props), Radix (`member-tag`) and `Slot` stay React. A page with 9 buttons goes from 1 hydration root to 9. **This lane is an enabler: the byte win arrives with the lanes that make the leaf components static** (local-component/`asChild`, member-tag). I flag this so the scoreboard is not read as a size win. (The lead may prefer to order local-component/member-tag first; see Q1.)
- The Radix compounds (dialog, tabs, select, menus; ~30 of the 45) are different: the children are themselves React components that only work inside the parent (context). For them the correct shape is **one island whose children travel with it**, which is what §3 builds. The root `Dialog` becomes the island; `DialogTrigger`, `DialogContent`... render inside that React tree.

## 3. Design (recommended): lower the children to a JSON element tree

An island's props are JSON. Make the children JSON too, when and only when the compiler can prove they are a constant tree.

**Lowering.** For a React-tier child with JSX children, the compiler lowers `children: Vec<Node>` to a JSON tree stored in the job's `literals["children"]` (same channel as every other literal prop, so SSR job, page script and `props` already carry it):

```
Text            "hello"
Element         {"$brust":"el","t":"div","p":{"className":"x","data-a":"1"},"c":[...]}
Fragment        {"$brust":"fr","c":[...]}
Component       {"$brust":"cmp","id":"<component id>","p":{...},"c":[...]}   // any component: React, static or native
```

- `Component` refs resolve through a per-island **registry** the bundler generates from the IR (`ir.children`): `{[id]: Comp}`. Static and native children are valid React components too (the file is unchanged), so the island chunk imports them; this is what makes Radix compounds work without compiling Radix.
- **Revive** is one tiny function used by both sides, in the island entry (`bundle.ts` `islandEntry`, ~l.352) and in `dist/jobs.js` SSR (~l.466): walk `props.children`, `createElement(type, props, ...children)` (varargs, so no React key warning). Only the key `children` is revived; user JSON props can never be mistaken for a marker, because the marker is read from `children` only.
- SSR and the client hydrate from the same JSON, so the markup matches (R34.3: same HTML, same behaviour as the React build).
- Props inside the tree follow the existing island rules: JSON literals only. A prop that is a function, reads state, or reads a store keeps the existing refusal (`island-prop`, with the same message as today for a direct island prop).

**Why not "render the children to HTML on the server and drop them into a slot"** (Astro-style). It breaks hydration fidelity: Radix `Portal`, `asChild`/`Slot`, context consumers and focus management need the children inside the React tree; an opaque HTML slot cannot host a nested context consumer or a nested island. Rejected on R34.3.

## 4. Requirements (R34.21–R34.27)

- **R34.21 Lower constant children.** JSX children of a React-tier child whose whole subtree is constant (host elements, text, fragments, components with literal props, nested children recursively) lower to the JSON tree above and no longer raise `island-children`. The parent keeps its tier (static, or native when it has its own state).
- **R34.22 One revive, both sides.** Island entry and `jobs.js` SSR share one `reviveChildren(props, registry)`; the registry is built from `ir.children` and imports through `componentImport` (the S1.1 binding rule: named / default / re-exported).
- **R34.23 Fail closed (kept as `island-children`, parent React, with a precise message).** Children that: read state or a store; contain an expression the server cannot fold (`{x}` of a non-literal, `.map` of non-literal data); contain a function value, an `on*` handler or a `ref`; are a render-prop function (`children={() => …}`); spread an unknown object; contain `<Outlet/>`; or exceed a size cap (proposal: 64 KB of JSON per island instance, `island-children-size`, so a big page does not double its payload). Each is a battery row with its own message. Prop-path children (`{props.title}`) are **out of v1** (Q2); they are the natural v2 once the prop map can address into a tree.
- **R34.24 Lists.** A React child with children inside a `.map` over a literal or loader list keeps today's rules: a stateful list stays `island-prop`; a props-path list gets one lowered tree per row through the existing per-instance `literals`/job path, or falls back (`instance-list-path`) exactly as a childless island does. No new list semantics.
- **R34.25 Battery rows** (`scripts/battery/rows.ts` → `docs/react-coverage.md`; each builds AND hydrates in Chromium, same pattern as the named-island tests; hydration compared to the React build's HTML per R34.3):
  1. text children into a React island (the `<Button>Text</Button>` shape);
  2. element tree with attrs and nested host elements;
  3. nested React children (Radix-like: parent+child sharing a context, state toggled by a click in Chromium);
  4. `asChild` child inside an island's children (Slot sees the lowered element);
  5. named / re-exported component inside the children (uses S1.1 binding);
  6. same island twice with different children (instance ids, ssr outputs);
  7. static component inside a React island's children (registry import of a non-React file);
  8. fail-closed rows: state read in children, handler in children, render prop, unknown spread, oversize tree, `<Outlet/>` — each expects `fallback:island-children` and parent React.
- **R34.26 Security.** The tree is user-controlled markup serialized into the page. It must (a) reuse the existing island-props JSON embedding and its `</script>` / U+2028 escaping; (b) go through React `createElement`, never HTML strings, so React's own escaping applies; (c) drop `dangerouslySetInnerHTML` from a lowered element unless the same rule as hand-written JSX allows it (the `html_raw` rule); (d) validate `t` against the HTML tag grammar and reject `$brust` keys inside `p`. Tests: tag/attr injection, `javascript:` URLs in `href`/`src` (same url guard as hand-written), `</script>` in text.
- **R34.27 Proof and docs.** `docs/shadcn-coverage.md` regenerated; the PR names every row that flips and every row that does not, with the reason from §2 (client JS flat). `docs/react-coverage.md` regenerated. `docs/plans/m1a-followups.md` gets the F-row (next number) for the prop-path children v2 and the size cap.

## 5. Proof — the rows that flip

By the generated table (page's own blockers = `island-children` only): accordion, alert-dialog, aspect-ratio, avatar, badge, badge-aslink, breadcrumb, bubble, button, button-aschild, button-group, card, checkbox, collapsible, command, context-menu, dialog, direction, drawer, dropdown-menu, empty, field, hover-card, item, label, marker, menubar, message-scroller, navigation-menu, popover, radio-group, resizable, scroll-area, select, sheet, switch, tabs, toggle-group, toggle, tooltip (40).
Expected to stay React for another page-level code: chart (child-component, jsx-expression), combobox (child-component, jsx-expression), carousel (instance-list-path), button-alias (external-component), input-otp. I will verify per row on the lane's fixture build and report any row that does not flip, with its code. A flip is counted only if `brust build <row>` succeeds and the row hydrates in the R34.25 Chromium check (open/close for dialog/tabs/select as the behaviour script).

## 6. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/passes/children.rs`, the lowering code (children → JSON), `ir/mod.rs` if a field is needed, `packages/brust/src/build/{bundle,compile}.ts` (registry + revive in island entry and jobs), `cloudflare.ts` only if it re-bundles island entries (the S1.1 `exposePlugin` lesson: check every bundler: chunks, jobs, Cloudflare, static, dev), tests and fixtures, battery rows, generated docs.
Gates (targeted, as S1.1): cargo for the compiler crate; `packages/brust` typecheck + island/bundle tests + `cf-build`; battery script; Chromium island tests; S0 fixture per-page build for the 40 rows (before/after table). Heavy runs announced on the task first.

## 7. Risks

1. Payload grows: the children JSON duplicates the SSR markup in the page. Mitigated by the size cap; measured per row and reported.
2. More hydration roots (button page: 1 → 9) until the leaf lanes land. Not a regression in JS bytes, possibly in main-thread time; I will measure with the existing Chromium harness and report.
3. A static/native component imported into the island chunk drags its file in; if it holds module-scope state it is now instantiated in the island chunk set (one instance per chunk set, as S1.1). Row 7 covers it.

## 8. Questions for the lead

- **Q1 Order.** Do island-children first (enabler, tier flips, bytes flat) or local-component/`asChild` and member-tag first (those make `Button`/`Badge` static and remove 23+36 rows' reason for the island, which may make island-children vanish for ~15 rows)? My recommendation: island-children first for the Radix compounds (they need it regardless), and run local-component right after.
- **Q2 Prop-path children in v1?** `{props.title}` / `{item.name}` inside the children. Recommended: no (v1 constant only), as a named follow-up.
- **Q3 Size cap** 64 KB per instance, OK?
- **Q4 Native parent with state.** Children are constant, so a native parent may keep state; children never read it (otherwise fail closed). Confirm this is wanted rather than refusing in native parents.
