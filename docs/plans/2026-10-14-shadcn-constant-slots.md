# shadcn S1 — lane `constant-slots` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Guetta · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F152 (next free)

Author: Guetta. Status: **DRAFT, awaiting the lead's ruling.** Base: origin/main fc7e2f91. Numbers are from `docs/shadcn-coverage.md` at that commit (62 of 64 pages built: 55 static, 1 native, 6 react; 2 refused). R-numbers continue after R34.48 (per-instance-jobs).

What is **confirmed** (read from the generated doc, the fixture sources, or measured on the island-children lane build) and what is **inferred** (read from source, not built on current main) is marked in every claim. The lane's first step turns each inferred row into a measured one; the PR reports any row that does not move.

## 1. What now blocks the 6 react rows and the 2 refused rows

Fixture pages read at `tests/fixtures/shadcn/pages/*.tsx`. "Confirmed" = I measured the cause on the island-children lane build (base 8304a923; the causes below did not change in #204/#205, which touch other diagnostics).

| Row | JS gzip | What makes the PAGE react / refused | Basis |
|---|---|---|---|
| table | 81 KB | `instance-list-path` (a fed child inside `.map`). **Not this lane:** per-instance-jobs (F142, Dew) is in review and predicts react → static, 0 JS. | doc + plan 2026-10-14-shadcn-per-instance-jobs |
| scroll-area | 92 | `{tags.map(...)}` inside the `<ScrollArea>` children, where `tags = Array.from({ length: 20 }).map((_, i, a) => \`v1.2.0-beta.${a.length - i}\`)` is a computed module const. Lowering refuses a list (`Node::For` → "a list", `children.rs:1468`). | confirmed (island-children lane) |
| carousel | 96 | `{[1,2,3,4,5].map((n) => <CarouselItem>…)}` inside `<CarouselContent>` children: the same "a list". The embla hooks stay in the React `Carousel` island (R34.5). | confirmed |
| sidebar | 116 | `{items.map((item) => <SidebarMenuItem>…<a href={item.url}>{item.title}</a>…)}` (module const of object literals) inside `<SidebarMenu>` inside `<SidebarProvider>` children: "a list". `SidebarProvider` itself (state, `browser-global`, `hook-shape`) is a genuine island. | inferred (the page was a refusal on the island-children base; read from source) |
| chart | 239 | `<ChartTooltip content={<ChartTooltipContent />} />`: an element-valued prop, so "prop `content` of <ChartTooltip> is not a constant" (`children.rs:1439`). The 170 KB above the floor is recharts: a genuine island (R34.5), the page can still be static around it. | confirmed |
| combobox | 158 | `<ComboboxList>{(item) => <ComboboxItem …/>}</ComboboxList>`: a **render prop** (function child) over `items={frameworks}`. base-ui calls it per item at render time. | confirmed; **stays React by design** (§5) |
| calendar | — (refused) | `error:island-prop`: prop `components` (an object of inline components) on `<DayPicker>` at `calendar.tsx:31:5`. | doc |
| form | — (refused) | `error:island-prop`: prop `render` (a function) on `<FormField>` at `form.tsx:11:9`. | doc |

So 4 of the 6 react rows (scroll-area, carousel, sidebar, chart) are one remaining shape: **a constant the compiler can compute, written as a list, a computed const, or an element-valued prop, inside the children of an island.** That is the natural completion of island-children (F138e), which handles only literal trees.

## 2. Ranking: the next lanes by measured rows and bytes

The 45 pages that ship JS pay a **~69 KB floor** (react + react-dom + runtime; `direction`, the smallest non-zero page, is 69 KB) plus 10–50 KB per Radix family. 17 pages ship 0. The biggest pages are chart 239 KB (recharts), combobox 158 (base-ui), select/dropdown-menu/context-menu/menubar/sheet ~116–118 (Radix compounds). The ~170 KB of chart and the base-ui bytes are libraries R34.5 keeps as islands; they are not a target for any lane below.

| # | Lane | Tier flips (rows) | Client JS removed | Cost / risk | Basis |
|---|---|---|---|---|---|
| 1 | **constant-slots** (this plan): lists, constant folding and element-valued props inside lowered children | 4: scroll-area, carousel, sidebar, chart (react → static; each keeps its genuine island) | 0 (the islands stay) | low; extends F138e, same files; no new trust boundary beyond one extra revive path | confirmed (3 of 4), inferred (sidebar) |
| 2 | **package-leaf** (R34.7 step 1): follow imports into `@radix-ui/*`; compile the leaf primitives (`forwardRef` + `Primitive.*` + rest props: Label, Separator, AspectRatio) | 0 tiers (these pages are already static) but **5 rows to 0 JS**: aspect-ratio 73, label 84, separator 84, field 86, button-group 86 | **≈ 413 KB** across the 5 rows (inferred from the page imports; built numbers in the lane) | **high and needs a ruling first** (Q1): the product has no path from a published package to the compiler today; the survey reads source maps, which not every package publishes | doc (library table: `react-label`, `react-separator`, `react-aspect-ratio` = `Primitive.*`, `forwardRef`, rest props only) + inferred (which pages) |
| 3 | fold `cn`/`cva`/`clsx` of literals at build (F149, R34.4) | 0 | 0 (removes the server precompute job on every flipped static page; the worker stops being required) | medium | F149 |
| 4 | island-prop demotion: a non-serializable prop under a host that can itself be React demotes the host instead of refusing the build | 2 refused → built React: calendar, form (62 → 64 built); no tier or byte win | 0 | small, but a semantics change on a hard error (Q4) | doc |
| 5 | context lane (S2): `createContext` / `useContext` / `Provider` across the compiled tree | the Radix compounds (~30 rows) can only move after 2 and after Presence / Portal / controllable state / focus / popper | the bytes of the whole Radix tail (the real prize) | very high; genuinely complex parts stay islands by design | library constructs table: useContext 187, Provider 137, forwardRef 286 |

**Recommendation.** Plan and run 1 now (it is concrete and low risk). 2 has the largest byte value of any small lane, but it cannot be planned without the Q1 ruling, so I propose a **time-boxed read-only spike for 2 in parallel** (no product change, a task note with the answer, one day): can a published Radix leaf component be analysed from its source-mapped `.tsx` or from the published `jsx()` ESM, and what does the compiler need to accept `Primitive.label`? If the lead prefers 2 first, say so in Q1 and I draft it next.

## 3. Design (recommended): one pure folder, three uses

Today `RawExpr::json_literal` (`ir/expr.rs:189`) folds literals, arithmetic and arrays/objects of literals. `lower_nodes` (`children.rs:1345`) uses it for every attribute, prop and text slot, and refuses `Node::For`, `Node::If`, and a non-constant prop. Replace the refusals by evaluation in a closed subset.

### 3.1 The folder: `RawExpr::fold(&Env) -> Option<Folded>`

`Folded` is `Json(Value)` or `Undefined` (only so a `.map` callback can bind `_` to `undefined`; `Undefined` renders nothing, omits a prop, and makes arithmetic fail closed). `Env` binds names to `Folded` (callback params) and resolves a module-level `const NAME = <init>` that is never reassigned, by folding its initializer (memoised, depth-limited, cycle → fail closed).

Subset (JS semantics, numbers formatted by the existing `num_json`):

- literals, templates with foldable parts, `+ - * / %`, unary `- + !`, comparisons, `&& || ??`, ternary `?:`;
- member and index access on folded objects/arrays (`item.title`, `row[0]`, `a.length`, `s.length`);
- array and object literals, with a folded element/field;
- `Array.from({ length: N })` (N foldable, 0 ≤ N ≤ 10 000; elements `Undefined`) and `.map(cb)` on a folded array, where `cb` is an arrow with 1–3 params (`item, index, array`) whose body folds or lowers to nodes;
- nothing else: **any other call, `new`, optional-call, tagged template, spread, closure over a non-constant name, `this`, assignment, getter** returns `None` and the node fails closed with the name of the construct.

It evaluates by interpreting the IR; it **never runs user code**, so there is no code-execution surface at build. A step budget (100 000 evaluations per island instance) and the `Array.from` length bound cap compile time; exceeding either is a fail-closed message (`island-children`, "the constant is too large to fold").

### 3.2 Use 1: lists (R34.50)

`Node::For { source, item, index, key, body }` where `source` folds to an array, and every iteration lowers: the body is lowered once per element with `item`, `index` (and the callback's third param) bound in the `Env`, and the results are spliced into the parent's `"c"` array. `key` is folded (so a non-constant or duplicate-by-fold key is checked) and then dropped from the tree: the revive uses `createElement(type, props, ...children)` (varargs), so React sees static children and never asks for keys. Size is counted after unrolling against the same 64 KB cap (so 20 or 50 rows are fine, 5 000 are refused, with the count in the message).

### 3.3 Use 2: constant conditions (R34.51)

`Node::If { test, then, else_ }` with a foldable `test` lowers only the chosen branch. (This is what `{cond && <X/>}` and `{cond ? <A/> : <B/>}` lower to; it is needed by list bodies such as `{item.active && <Badge/>}`.) A `test` that reads state, a store or a prop stays "a condition".

### 3.4 Use 3: element-valued props (R34.52)

A prop of a lowered **component** node whose value is JSX (an element or fragment: `content={<ChartTooltipContent />}`, `icon={<Icon/>}`, `fallback={<Spinner/>}`) is lowered with the same `lower_nodes` into a marker tree and placed in that node's `p`. The node gains `"x": ["content"]`, the **list of prop names whose value is a marker tree**. Revive (one function, island entry and `jobs.js`, as today) revives **only the names in `x`** and leaves every other prop as plain JSON. That keeps the F138e rule that data can never be mistaken for a marker: a prop is revived because the compiler declared it, not because its value has a `$brust` key. Names `children`, `key`, `ref`, `dangerouslySetInnerHTML`, `__proto__` stay refused in `x` as they are in `p` today.

Only a **component** takes element-valued props: a host element with a JSX attribute is not a thing React renders.

### 3.5 What this does not change

No change to the tiering rule, the registry, the 64 KB cap, `ChildRef.nested`, or to anything outside the children of a React-tier child. A list that is not a child (a page-level `.map` over a props path, a loader list) keeps `instance-list-path` and is the per-instance-jobs lane's. Prop-path children (`{props.title}`) stay out (F148a: they need a data-path security review first; the folder never reads a prop).

## 4. Requirements (R34.49–R34.55)

- **R34.49 The folder (§3.1).** `RawExpr::fold` exists with the subset above, with Rust unit tests for each production, for JS-semantics edge cases (`0.1 + 0.2`, `"a" + 1`, `a.length - i`, `-0`, out-of-range index = `Undefined`), for the budget and length bounds, and for "any other call fails closed". `json_literal` becomes `fold` with an empty `Env` (one implementation; F148c's doc comment lists the users).
- **R34.50 Lists in lowered children (§3.2).** A list over a foldable array (inline literal, module const of literals or objects, `Array.from({length:N})`, `.map` chains of the subset) lowers by unrolling. Output identical to the React build's HTML (R34.3).
- **R34.51 Constant conditions (§3.3).**
- **R34.52 Element-valued props (§3.4)** with the `"x"` list, in both revive sites and the Cloudflare re-bundle (the S1.1 `exposePlugin` lesson: check every bundler).
- **R34.53 Fail closed (§5).** Each remaining shape keeps `fallback:island-children` with its own message.
- **R34.54 Battery + Chromium (§5).** `scripts/battery/rows.ts` rows `b-island-slots-*`; each builds AND hydrates in Chromium; HTML equality against the React build for the four fixture pages' lowered subtrees.
- **R34.55 Proof and docs (§6).** `docs/shadcn-coverage.md`, `docs/react-coverage.md`, `m1-exit-report.md` regenerated; the PR names every row that moves and every row that does not; the F-row (F152) records the folder's users, the budgets, and the follow-ups (prop-path children, F148a).

## 5. Fail-closed list and battery rows

Each is a battery row expecting `fallback:island-children` and parent React, with the message shown (new messages in bold).

| Input in the children of a React island | Result |
|---|---|
| list over a literal / module-const array, `key` and body constant | **lowers** (flip) |
| list over `Array.from({length:N}).map((_, i, a) => \`…${a.length - i}\`)` | **lowers** (flip; the scroll-area shape) |
| list over a props path, a loader value, a state/store read | `island-children`: "a list over data that is not a constant" (the same message class as today, now precise) |
| list longer than the bound, or unrolled tree over 64 KB | **"the list has N items / the lowered tree is B bytes, over the cap"** |
| `Array.from` with a non-foldable length, `N > 10 000` | **"Array.from needs a constant length"** |
| callback with a block body, two returns, or a call outside the subset (`.filter`, `.sort`, `.join`, `Object.entries`, `String(x)`) | **"the list callback uses `<construct>`, which the compiler does not fold"** |
| condition on a constant | **lowers** (chosen branch) |
| condition that reads state / store / a prop | "a condition" (unchanged) |
| element-valued prop on a component | **lowers** (flip; the chart shape) |
| element-valued prop whose element reads state, has a handler, a ref, a spread, or a non-constant prop | the existing message for that construct, now naming the prop |
| function-valued prop that returns JSX (`render={(x) => <…/>}`) and a function child (the **combobox** shape) | **"a render prop is called with data the compiler does not have"** (battery row `b-island-slots-render-prop`, pins combobox as React) |
| a module const whose initializer is not in the subset | "`NAME` is not a constant the compiler can fold: `<construct>`" |
| `{"$brust":…}` appearing in a data prop, or a prop named like a marker key | stays plain JSON (tested), because only `x` names revive |
| `x` naming `children` / `ref` / `key` / `dangerouslySetInnerHTML` / `__proto__` | refused at compile time, and ignored by revive if forged (hostile-input test) |

Positive rows: unrolled list (literal), unrolled list (module const of objects with member reads), `Array.from({length}).map` with index and array params, nested list in a list, list inside a component with its own children, constant `&&` and ternary, element-valued prop (component), element-valued fragment prop, two instances of the same island with different lists, a list producing 0 items, the real `scroll-area`, `carousel`, `sidebar`, `chart` page bodies as fixtures.

## 6. Proof — the rows that move

- **Expected to flip react → static (1 island each, the library island stays):** scroll-area, carousel, sidebar, chart. A flip is counted only if `brust build <row>` succeeds, the SSR HTML of the lowered subtree equals the React build's (R34.3), and the page hydrates in the Chromium check (R34.54).
- **Expected not to move:** combobox (render prop, by design), table (per-instance-jobs), calendar and form (refusals; Q4), sonner (native, `child-component`).
- **Client JS:** flat for the four. Said plainly in the PR: this lane moves tiers and removes React-rendered page chrome; it does not change bytes. The byte lever is candidate 2.
- **Reported, not gated:** largest lowered tree per row (the F138e cap data), number of unrolled items, main-thread time before/after on scroll-area and carousel (existing Chromium harness).
- If sidebar or any of the four has another page-level blocker I have not seen (the sidebar row is inferred), the PR says which code, and the row is reported as "not moved: <code>".

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/ir/expr.rs` (the folder), `analyze/passes/children.rs` (`lower_nodes`: lists, conditions, element-valued props), `ir/decls.rs` only if a field is needed for module consts, `packages/brust/src/build/bundle.ts` (`reviveSource`, `islandShim`, `buildJobs`) and `cloudflare.ts` only for the `x` revive, tests and fixtures, battery rows, generated docs, ledger.

Gates (targeted): `cargo test -p brust-compiler`; `packages/brust` typecheck + island/bundle tests + `cf-build`; battery; the Chromium island tests; the S0 fixture per-page build for the four rows plus the full `bun run shadcn -- --check`. Heavy runs announced on the task first; no Docker.

## 8. Risks

1. **A second revive path (element props)** widens the surface F148a warned about. Mitigated by `x` (compiler-declared names only), the same untrusted-input rules as `children`, hostile-input tests, and no prop-path data anywhere near it.
2. **Folder drift from JS semantics** (number formatting, string coercion, holes). Mitigated by a closed subset, unit tests of each production, and a differential test: for every positive battery row the lowered-then-revived HTML equals the React build's HTML.
3. **Compile time and payload:** an unrolled list grows the page. Bounded by the 64 KB cap, the `Array.from` bound and the step budget; the lane reports the largest tree.
4. **Hydration fidelity:** unrolled children are static children, so no key is needed, and React's reconciliation of a static array is the same as for hand-written JSX.

## 9. Questions for the lead

- **Q1 Order.** 1 (this plan, tiers) first, or candidate 2 (package-leaf, ≈ 413 KB over 5 rows) first? My recommendation: this lane first, plus a one-day read-only spike for 2 so its plan is evidence-based. If 2 first: how may the compiler obtain a package component's source (source maps `sourcesContent`, the published ESM `jsx()` calls, or both)?
- **Q2 Folder scope.** Is the subset in §3.1 right (no `.filter`, `.join`, `Object.entries`, string methods)? Widening is cheap later, narrowing is not. Recommended: ship it as written; every fail-closed message names the construct so the next widening is data-driven.
- **Q3 Unroll vs a runtime `map` marker.** I unroll at compile time (size is the cost, bounded by the cap). The alternative, a `{"$brust":"map"}` marker the revive expands, saves bytes for long lists but adds a second revive form and makes the folder run at runtime. Recommended: unroll, as above.
- **Q4 Refusals (calendar, form).** Make `island-prop` demote the host to React instead of failing the build, as a separate small lane (candidate 4)? Recommended: yes, separately, after this lane; it is a semantics change on a hard error and deserves its own ruling and battery rows.
- **Q5 Element-valued props on host elements.** Not supported (React does not render them). Confirm that stays out.
- **Q6 F149 (`cn`/`cva` fold).** Keep it as candidate 3 after this lane? It reuses the folder (`cn(<literals>)` is a call the folder could learn), so doing it after R34.49 avoids a second evaluator.
