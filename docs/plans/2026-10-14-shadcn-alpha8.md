# shadcn S1/S3 — alpha.8 ranking and next lanes (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Guetta (lane `icon-shapes`) · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: F153c (package source, ruled), F159 (`icon-shapes`, next free)

Author: Guetta. Status: **DRAFT, awaiting the lead's ruling.** Base: origin/main e970250c (alpha.7). Numbers are `docs/shadcn-coverage.json` at that commit: 64 pages, 64 built; 61 static, 1 native, **2 react**; 53 islands; 18 pages with 0 JS; client JS gzip min 0 / median 87 / max 240 KB. R-numbers continue after R34.68. **Confirmed** = read from the generated doc/json or the fixture source; **inferred** = read from source, not built; every inferred row is a measured row at the start of its lane, and the PR reports any row that does not move.

## 1. Where the scoreboard stands

**The two react pages.**

| Page | JS | Blocks the PAGE | Basis |
|---|---|---|---|
| combobox | 158 KB | `{(item) => <ComboboxItem/>}` is a render prop that `@base-ui/react` calls per item at render time with data the compiler does not have (battery row `b-island-slots-render-prop` pins it); plus `slot-dynamic`, `spread-props` on the wrappers | confirmed |
| form | 101 KB | `react-hook-form`: `useForm` in the page (`hook-unsupported`) and `render={({ field }) => …}` on `<FormField>` (`island-prop`, demoted to React by #207) | confirmed |

Neither moves a byte if it flips: both keep their library (base-ui, react-hook-form) as an island. They are **tier-count rows, not byte rows**.

**Where the bytes are.** 46 pages ship JS, 4 584 KB gzip in total. The smallest non-zero page is 69 KB (`direction`): that is the **floor**, react + react-dom + the runtime, paid once per page as soon as ONE island is left. So the floor is 3 174 KB (69 %) of the total, and 1 239 KB (27 %) is the per-family tail above it (chart's 240 is the outlier: recharts, an island by R34.5). Consequence for ranking: a lane that removes part of a page's islands saves almost nothing; **only a lane that removes the LAST island of a page saves ~70–90 KB.** The ranking below counts pages that reach 0 JS (or the native floor), not components.

## 2. Is F153c (package source) the next lane? **Yes.**

It is already ruled (package-leaf plan §10: F153a → F153b → F153c; a and b are on main: #208, #212), nothing has surfaced that changes the order, and it is the only candidate with certain, measured bytes: the five pages whose only island is a **pure Radix leaf** (`Primitive.*` + `forwardRef` + rest props; spike: source is in `sourcesContent`) go to 0 JS. I do not re-plan it; §3 lists what it flips so the lead can rank it against the others.

## 3. Ranking by measured rows and bytes

"Bytes" = JS removed if the page reaches 0 JS (its current gzip). 

| # | Lane | Pages that reach 0 JS | Bytes | Risk | Basis |
|---|---|---|---|---|---|
| 1 | **F153c package source** (R34.61, R34.62, R34.65) | aspect-ratio 73, separator 84, label 84, button-group 86, field 86 | **413 KB** | medium: new build step + integrity check (ruled) | doc (library table: `react-label`, `react-separator`, `react-aspect-ratio` carry only `Primitive.*`, `forwardRef`, rest props) + fixture imports |
| 2 | **`icon-shapes`** (this plan, §4) | spinner 82, breadcrumb 85, button-alias 85; pagination 87 and input-group 87 to be measured | **252 KB sure, 426 KB if all five** | low: compiler-only, extends L23 icons and existing folders; no package, no runtime | confirmed cause for spinner, breadcrumb, button-alias; pagination and input-group inferred (§4.4) |
| 3 | **Radix non-overlay compounds** (S2 context lane: `createContext`/`useContext`/`Provider`, `useControllableState`, `Presence`, `useId`) | progress 85, switch 89, toggle 86, collapsible 89, avatar 87, direction 69, checkbox 91 and tabs 94 / accordion 94 / toggle-group 93 / radio-group 96 / slider 93 / scroll-area 92 only if roving focus and collection compile (they need client state: they land **native**, ~5 KB, not 0) | up to ~1 100 KB (13 pages × ~85 KB), at the cost of a native client script per page | **high**: needs a spike; the package-leaf plan's Risk 1 gate applies | library table (constructs per package) |
| 4 | render-prop template (combobox) | combobox (react → static, **0 bytes**: base-ui stays) | 0 | medium: a new template language for a function child | confirmed |
| 5 | form (react-hook-form), recharts, cmdk, vaul, embla, react-day-picker, base-ui, sidebar provider | none | 0 | genuinely complex: stay islands by R34.5 | doc |
| — | the 28 overlay compounds (dialog … menubar, select, popover, tooltip, drawer, sheet, hover-card, command, navigation-menu, 99–118 KB) | none soon | 0 | `DismissableLayer`, `FocusScope`, `Popper`, `Portal` (document globals, layout effects) are not compiler-shaped | doc |

**Recommendation.** Rule #1 (F153c) as the next lane, as already ordered, and run #2 **in parallel**: they share no files (F153c is `analyze/modules.rs` + build; #2 is `icons.rs`, `jsx.rs`, `placement.rs`, `modules.rs` path resolution is the only touch point and is a different function). #3 is the real prize but cannot be planned from the survey; I propose a **read-only spike** (no product change, a task note, one working session) answering §7 Q3 before its plan. #4 and #5 are not recommended before #3: a tier flip without a byte change is bookkeeping.

## 4. Design: lane `icon-shapes` (R34.69–R34.75)

Four small, independent compiler shapes. Each one removes an island whose page is otherwise static; each keeps every existing fail-closed rule.

### 4.1 `tsconfig` `paths` alias (R34.69) — button-alias, 85 KB, **and every real shadcn app**

The shadcn CLI writes `import { Button } from "@/components/ui/button"`. The compiler reads `@/…` as a package (`external-component`), so the component is an island. The S0 fixture **rewrote** these imports to relative ones (documented in the generated doc) precisely because of this; a user who runs `shadcn add` gets the un-rewritten form, so the measured table understates the real-world cost: every shadcn page imports through `@/`. Resolve `compilerOptions.paths` (and `baseUrl`) from the nearest `tsconfig.json`/`jsconfig.json` in `modules.rs::resolve`, exact and single-`*` patterns only, first existing file wins; a target outside the app root, a pattern that is not exact/single-star, or a missing file keeps today's behaviour (a package). The island build already resolves aliases through the bundler (`bun` reads tsconfig `paths`); the compiler must agree with it, so the rule is "the compiler's answer equals `Bun.resolveSync` for the same specifier" and a build-time check fails the build if they differ (Q1).

### 4.2 Rest/spread onto a lucide icon (R34.70) — spinner 82 KB (confirmed), pagination (inferred)

`<Loader2Icon className={cn(…)} {...props} />`: L23 inlines an icon whose props are constants or the four `DYNAMIC_PROPS`; any spread keeps the icon a component (`external-component` + `spread-props`). The inlined icon is an `<svg>` element, so a spread of a known-shape rest object lands on that `<svg>` exactly as R34.15 does on a host element (`spread_attrs`, later wins). Extend `icons.rs`: a spread on an inlined icon becomes a spread on its root `svg`; the icon's own computed attributes (width/height/stroke…) keep React's precedence (the icon's defaults first, call-site props after, as `lucide-react` does). Spread of an unknown shape keeps today's fallback.

### 4.3 Element fallback in `??` / `||` (R34.71) — breadcrumb 85 KB (confirmed)

`{children ?? <ChevronRight />}` is `jsx-expression` today (JSX inside an expression that is not a list, a condition or a child). `a ?? <X/>` and `a || <X/>` over a prop or constant are conditions in disguise: lower to `If(a is not nullish / falsy) { slot a } else { <X/> }`, evaluated by the existing `If` machinery (server: `{% if %}`; native: `x-show`/`x-if`). Only when the left side is a prop, a constant or a state read, and the right side is JSX; everything else keeps `jsx-expression`. Needs the nullish test to be `is none/undefined` and the falsy test to match JS truthiness for the shapes the template can render (string, number, element); `0` and `""` follow JS (`??` keeps them; `||` drops them), pinned by battery rows.

### 4.4 pagination and input-group (R34.72) — to be measured first

`pagination` (87 KB, 2 islands: `PaginationPrevious/Next` = icon + `PaginationLink {...props}`; `PaginationEllipsis` = icon) and `input-group` (87 KB, `InputGroupButton`: `<Button … {...props}/>` with `slot-dynamic`, and `InputGroupInput`) are probably covered by 4.2 and the local-component/asChild + spread rules already on main, but I have not built them on e970250c. Step 0 of the lane builds both and names the remaining code; the PR claims only what moves. `slot-dynamic` on `InputGroupButton` (a dynamic `asChild` forwarded to `Button`) is out unless step 0 shows it is the only blocker; then it is a separate Q (Q2).

### 4.5 What does not change

No new tier rule, no runtime change, no bundler change, no new revive path. Lucide's rendering still happens at build with `react-dom/server`; the spread only adds attributes to the rendered `svg`.

## 5. Requirements

- **R34.69 `paths` alias.** §4.1, with the agreement check against the bundler and the existing fallbacks.
- **R34.70 Spread on an inlined icon.** §4.2.
- **R34.71 Element fallback in `??`/`||`.** §4.3.
- **R34.72 Measure pagination and input-group; claim only what moves.** §4.4.
- **R34.73 Fail closed.** §6; each row holds its named code, no `knownGap`.
- **R34.74 Battery rows** (`scripts/battery/rows.ts`, built AND, where a behaviour changes, served and compared with the React build's HTML per R34.3).
- **R34.75 Proof and docs.** `docs/shadcn-coverage.md`/`.json`, `docs/react-coverage.md`, `m1-exit-report.md` regenerated; the PR lists every page that changes tier or code and the gzip delta per row; ledger F159.

## 6. Fail-closed list and battery rows

| Row | Input | Expected |
|---|---|---|
| alias exact | `"@app": ["./src/app.tsx"]` | resolves to the file; static |
| alias star | `"@/*": ["./*"]`, `import … from '@/components/ui/button'` | resolves; same tier as the relative import |
| alias to a package-looking path | `"@/*": ["./node_modules/x/*"]` | not followed (outside the app sources): island, message names it |
| alias with two stars / `*` in the middle | `"a/*/b/*"` | not supported: today's behaviour (package) |
| alias missing file | `@/nope` | build error as for a relative import that does not exist |
| alias disagrees with the bundler | compiler picks A, `Bun.resolveSync` picks B | build error naming both |
| icon + literal spread | `<Icon {...{ role: 'status' }} />` | static, attribute on the `svg` |
| icon + rest spread, className after | later wins as React | pinned |
| icon + spread of an unknown value | `{...x}` from a call | `spread-props`, island (unchanged) |
| icon + spread carrying `on*` | `{...{ onClick }}` | island (handler on an inlined svg: out) |
| `a ?? <X/>` with a prop `a` | present / absent | both branches pinned, `0` and `""` kept |
| `a \|\| <X/>` with a prop `a` | `0` and `""` | fall to `<X/>` as JS |
| `a ?? <X/>` where `a` is a call | `f() ?? <X/>` | `jsx-expression` (unchanged) |
| `a ?? <X/>` inside an island's children | | folds or fails closed with the existing message |
| pagination / input-group | as measured in step 0 | whatever the build says; rows added for the shape that blocks |

## 7. Proof — the rows that move

- **Expected to reach 0 JS:** spinner, breadcrumb, button-alias. **To be measured:** pagination, input-group. A move counts only if `brust build <row>` succeeds, the page is **served** and its HTML equals the React build's (R34.3) for the changed subtree.
- **Expected not to move:** everything else; in particular combobox (render prop), form, chart, sonner, and the overlay compounds.
- **Reported, not gated:** gzip delta per moved row (spinner 82 → 0, breadcrumb 85 → 0, button-alias 85 → 0); and the **un-rewritten fixture** (a second, `@/`-importing copy of three pages) before and after 4.1, which is the honest real-world number.

## 8. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/{modules,jsx,placement}.rs` and `analyze/passes/{icons,children}.rs`, `lower/template.rs` (the `If` for 4.3), `crates/brust-compiler/tests/**`, `packages/brust/src/build/{compile,bundle}.ts` only for the alias-agreement check, `scripts/battery/rows.ts`, `scripts/shadcn/**` (the unrewritten pages), generated docs, ledger. Gates (targeted): `cargo test -p brust-compiler`; `packages/brust` typecheck + bundle tests; battery; `bun run shadcn -- --check`; the Chromium island tests the changed rows touch. Cold builds and the shadcn run are announced on the task first.

## 9. Risks

1. **Alias resolution drift** between the compiler and the bundler (two resolvers). Mitigated by the agreement check and its error; a `tsconfig` `extends` chain is not followed in v1 (Q1).
2. **JS truthiness in a template.** `||` over a string or number must match JS (`0`, `""`, `NaN`); the rows pin it, and any value the template cannot test the same way keeps `jsx-expression`.
3. **A spread onto an icon changes what the icon renders** (props the icon sets itself, `aria-hidden`). Precedence follows `lucide-react`'s own (defaults, then call-site); pinned by rows rendered through the real package.
4. **Claims.** The doc says "expected" for pagination and input-group; the PR says what moved.

## 10. Questions for the lead

- **Q1 `tsconfig` scope.** `paths` + `baseUrl` of the nearest `tsconfig.json`/`jsconfig.json`, no `extends` chain, exact and single-`*` patterns. Recommended. Widen only on a real app that needs it.
- **Q2 `slot-dynamic` on `InputGroupButton`** (dynamic `asChild` forwarded to a wrapped `Button`): in this lane only if step 0 shows it is the one remaining blocker; otherwise a ledger row. OK?
- **Q3 Order and parallelism.** F153c first and `icon-shapes` in parallel (no shared files), plus a read-only spike for #3 (Radix non-overlay compounds) by a third agent so its plan is evidence-based. Or `icon-shapes` first because it is cheaper and certain? Recommended: parallel.
- **Q4 Hydration timing as a separate lever.** 69 % of the JS is the per-page floor of pages that keep an island. Deferring the island chunk to idle/visible/first interaction would cut load cost on all 41 overlay and compound pages without compiling Radix, but it risks hydration fidelity (React replays only discrete events at a dehydrated Suspense boundary) and is a runtime change. Not in this plan; do you want it scoped as its own plan?
- **Q5 The two react pages.** Confirm they stay tier-count rows (combobox, form) and are not scheduled until #3's spike says whether a template for render-prop children is worth its language.
