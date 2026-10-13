# shadcn S1 — lane `member-tag` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: TBD · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F138g (proposed)

Author: knock2. Status: **DRAFT for the lead's ruling; no lane started.** Base: origin/main 91ed5f2c. Numbers are from `docs/shadcn-coverage.md` at that commit (36 measured rows carry `fallback:member-tag`, ranked #4) and from a count over `tests/fixtures/shadcn/components/ui/*.tsx`. R-numbers continue after R34.34 (local-component).

## 1. What the diagnostic is today

`crates/brust-compiler/src/analyze/jsx.rs:60` (`tag_of`): a JSX tag that is not a string, a fragment or a plain identifier is `Tag::Member`, and `read_element` (`jsx.rs:90`) pushes `Diagnostic::fallback("member-tag", "member-expression component tags (`<Ctx.Provider>`) are not supported natively")`. The node becomes `Node::Component { name: "<member>", source: None, … }`, which `resolve_child` can never resolve (no import source), so the **parent component becomes React**; `member-tag` is not in `CHILD_ONLY`.

It is one code for two different things:

| Kind | What it is | Sites in the fixture |
|---|---|---|
| **A. A member of an imported binding** | `<DialogPrimitive.Root>` with `import { Dialog as DialogPrimitive } from "radix-ui"`; also `import * as X from "pkg"` + `<X.Y>` | **201** |
| **B. A member of a local object** | `<FormFieldContext.Provider>`, `<ChartContext.Provider>`, `<SidebarContext.Provider>`, `<CarouselContext.Provider>`, `<ToggleGroupContext.Provider>`, `<FormItemContext.Provider>` (6), and `<itemConfig.icon />` (2, chart) | **8** |

209 member tags in 40 files. Kind A by package: `radix-ui` 158 (menubar/dropdown/context-menu 17 each, select 15, dialog 10, sheet 9, alert-dialog 9, navigation-menu 8, tooltip 6, …, plus `Direction.DirectionProvider` and one `Slot.Root`), `@base-ui/react` 19 (combobox), `vaul` 8 (drawer), `cmdk` 6 (command), `@shadcn/react` 6 (message-scroller), `react-resizable-panels` 3, `recharts` 1. Kind B is `createContext` provider syntax: **the context lane (S2), not this one.**

Three module-level aliases of a member also exist: `const Combobox = ComboboxPrimitive.Root`, `const ChartTooltip = RechartsPrimitive.Tooltip`, `const ChartLegend = RechartsPrimitive.Legend`. They are used as `<Combobox>` (an identifier tag: `local-component`, not `member-tag`) and are Q2.

## 2. What the 36 rows look like

From the generated table (`Basis measured`, codes per row):

| Group | Rows | Codes besides `member-tag` |
|---|---|---|
| A. only `island-children` | 10: aspect-ratio, avatar, context-menu, direction, label, menubar, scroll-area, switch, tabs, toggle | `island-children` |
| B. `member-tag` only (tier already static) | 3: progress, separator, slider | none |
| C. + `external-component` | 6: accordion, checkbox, navigation-menu, radio-group, resizable, select | `island-children`, `external-component` |
| D. + `local-component` / `spread-props` | 12: alert-dialog, button-group, collapsible, drawer, dropdown-menu, hover-card, popover, tooltip, command, dialog, sheet, field | depend on the local-component lane (`Button`) and S1.2 |
| E. other page-level blockers | 5: carousel, chart, combobox, message-scroller, toggle-group | `event-capture`, `hook-unsupported`, `jsx-expression`, … |

## 3. What flips, honestly — this lane is a **prerequisite**, not a size win

Resolving `<DialogPrimitive.Root>` to the package export it names turns the node into the same thing `<Root>` imported by name already is today: an **external component island** (`fallback:external-component`, L22). So:

- **On its own this lane flips no row's tier.** In every row `member-tag` is replaced by `external-component` (rows that already carry it lose one code). The measured table shows the next blocker instead of hiding it behind `member-tag`; that is the point of the lane (R34.1: measure, then build).
- **With island-children merged (ruled, #1 in the order)** the group-A rows (10) become `static|native` pages whose Radix root is one island and whose children travel into it as a JSON tree (island-children §3, children resolved through the registry, so `TabsList`, `TabsTrigger`, … run as React **inside** the island). Group B (3) stays static; its one island changes from the shadcn wrapper to the bare primitive (smaller chunk: no `cn`).
- **Client JS does not move for the Radix rows.** The island is still `radix-ui` + react + react-dom (~85-95 KB gzip, measured). The byte win needs R34.7 (the compiler follows the package and compiles Radix), a later lane. This lane must not be read as one; the PR states per row the gzip before/after from the S0.1 generator (expected: ±0 for A/C, a few KB less for B).
- Groups D and E do not change tier here; they lose or swap a code only.

## 4. Design (recommended)

### 4.1 What is compiled and what stays React (explicit)

| Piece | After this lane | Why |
|---|---|---|
| The shadcn **wrapper** (`function Dialog({ ...props }) { return <DialogPrimitive.Root data-slot="dialog" {...props} /> }`) | **Compiled** by brust: static or native like any component; its `data-slot`, `className={cn(…)}` and spread are the S1.2 / `cn` work | it is the user's own copied source |
| The **Radix primitive** (`DialogPrimitive.Root`, `.Trigger`, `.Portal`, `.Content`, …) | **Stays a React island**, imported from the package by export path | Radix internals use `createContext`/`useContext`, `forwardRef`, `Primitive`, `Presence`, `Portal`, `Slot`, `composeRefs`, `useLayoutEffect` (S0 census: 113 `Primitive.*`, 187 context reads, 286 `forwardRef`, 77 `composeRefs`, 58 `Slot`). Compiling them is R34.7, not this lane |
| The shadcn **sub-wrappers inside an island** (`DialogTrigger`, `DialogContent`, … when they are children of a primitive that is an island) | **Run as React inside the island** (children registry of island-children) | they need the primitive's context at runtime; no extra island per part |
| Anything in the fail-closed list (§6) | stays `member-tag` / React | |

### 4.2 Recognition (`analyze/jsx.rs`)

`tag_of` today only sees identifiers. Add: the tag expression is a **single-level dot** `BASE.MEMBER` (`E::EDot`) where `BASE` is an identifier whose binding is an **import from a non-relative source** (`IdentKind::Import { source, imported }`, resolved by ref, so a shadowing local is not matched) and `MEMBER` is a valid JS identifier starting with an uppercase letter or any identifier (Radix exports `Root`, `Trigger`, …; the rule is "not computed"). Three import shapes:

- named, possibly renamed: `import { Dialog as DialogPrimitive } from "radix-ui"` → export path `["Dialog", "Root"]`;
- namespace: `import * as ResizablePrimitive from "react-resizable-panels"` (the compiler records `imported = "*"`, `names.rs:81`) → path `["Group"]`;
- default: `import Primitive from "pkg"` → path `["default", "Member"]`.

The node becomes `Node::Component { name: "DialogPrimitive.Root", source: Some("radix-ui"), imported: Some("Dialog"), member: ["Root"], … }` (a new `member: Vec<String>` field, empty for every existing node) instead of `Tag::Member`, so it reaches `resolve_child`'s existing package branch and gets `fallback:external-component` with the message naming the full path.

### 4.3 IR and build (`ExternalRef`, `componentImport`)

- `ExternalRef { source, export }` (`ir/decls.rs`) gains `member: Vec<String>` with `skip_serializing_if = "Vec::is_empty"`, so every existing IR stays byte-identical. The synthetic component id carries the path (`external_component_id`: `dialogRoot_<hash>` from `package:radix-ui` + `DialogRoot`), so `Dialog.Root` and `Dialog.Trigger` are two islands and the same member used twice is one component.
- `packages/brust/src/build/bundle.ts` `componentImport(c, local)` (used by the island shim and the `jobs.js` SSR imports) emits, for a non-empty path: `import { Dialog as __ns } from "radix-ui"` + `const <local> = __ns.Root` (default import: `import __ns from …`; namespace: `import * as __ns from …`). `packages/brust/src/build/compile.ts` carries the field in the `ComponentIR.external` type. No other build file changes.
- The import binding must be reachable by the bundler from a file of the app (`dist/` entries resolve bare imports from "a component that uses it", `compile.ts` end of `compileApp`); that mechanism is unchanged.

### 4.4 Properties of the island that already hold

`props` of an external island are JSON (literals, state): a function prop (`onOpenChange={…}`, `onClick`) is the existing `island-prop` error; JSX children are `island-children` (the ruled lane). Both behave as for any other external component. The key and the `data-slot`/`className`/rest attributes pass through unchanged.

## 5. Requirements (R34.35–R34.41)

- **R34.35 Member of an imported binding resolves to the export.** `<B.M …>` with `B` an import (named, aliased, namespace or default) from a non-relative source, single-level `M`, is an external component with export path; it raises `external-component` (message names `source`, `B`, the path), never `member-tag`. Any other member tag keeps `member-tag` with a message that names why (local object, computed, deeper than one level, relative source, shadowed binding).
- **R34.36 IR compatibility.** `ExternalRef.member` is absent when empty; no existing fixture's `expected.ir.json` changes; the new field has its own fixture. Component ids for member paths are stable and distinct per path.
- **R34.37 Build.** `componentImport` emits the right import for the three shapes; a member that does not exist on the package is **not** silently `undefined`: see Q1 (build-time check vs runtime error). `brust build` of a page with `<Dialog.Root>` succeeds and the island entry loads the primitive.
- **R34.38 No behaviour change.** R34.3: the page's SSR HTML and hydrated behaviour equal the React build's. For group A/B rows the Chromium comparison covers `tabs` (keyboard arrows, `data-state`), `switch` (click, `aria-checked`), `dialog` once D unblocks; a row only counts as flipped when this comparison agrees.
- **R34.39 Fail closed (own message each, parent React).** §6.
- **R34.40 Battery + scoreboard.** New rows in `scripts/battery/rows.ts` (→ `docs/react-coverage.md`, `docs/plans/m1-exit-report.md`), §6. `docs/shadcn-coverage.md` regenerated on a fresh addon + install, twice identical; the PR lists every row whose codes change, every row that changes tier, and the measured gzip delta per row.
- **R34.41 Honest leftovers.** The census of what the compiled wrapper still needs (`cn` as a server expression, S1.2's rest-spread) and what the primitive keeps (R34.7) is written into `docs/shadcn.md`'s coverage section, not into this lane's code.

## 6. Fail-closed list and battery rows

Each is a battery row (no `knownGap`). All keep the component React with `member-tag`, except where stated:

| Row | Source | Expected |
|---|---|---|
| named alias import | `import { Dialog as D } from "pkg"; <D.Root/>` | `external-component`, island, no `member-tag` |
| namespace import | `import * as P from "pkg"; <P.Group/>` | same |
| default import member | `import P from "pkg"; <P.Item/>` | same |
| member used twice / two members | `<D.Root/>` `<D.Trigger/>` | two island components, distinct ids |
| deeper than one level | `<D.Sub.Trigger/>` | `member-tag` |
| local object provider | `const Ctx = createContext(); <Ctx.Provider>` (`d-createcontext`, unchanged) | `member-tag` |
| local object tag | `<itemConfig.icon/>` | `member-tag` |
| shadowed binding | parameter or local `const D = …` hiding the import | `member-tag` |
| computed member | `<D["Root"]/>` | `member-tag` |
| relative source | `import * as UI from "./ui"; <UI.Button/>` | `member-tag` (Q3) |
| function prop on the island | `<D.Root onOpenChange={fn}/>` | `island-prop` error (existing) |
| children on the island | `<D.Root><x/></D.Root>` | `island-children` (existing rule; flips with the island-children lane) |
| `Outlet`-like special import | `import { Outlet }` | unchanged |

## 7. Proof — the rows that change

By §3, with this lane alone: 36 rows swap `member-tag` for `external-component` (or lose it where present); **0 tier flips claimed**. With island-children on main first: group A (10 rows) is predicted react → static|native with N islands (aspect-ratio, avatar, context-menu, direction, label, menubar, scroll-area, switch, tabs, toggle) and group B stays static with a changed island. These are predictions until the generator runs on the merged tree. A flip counts only when `brust build` succeeds, the Chromium comparison (R34.38) agrees, and the dead-import check passes (no shadcn wrapper chunk for a flipped static wrapper in the page's client files).

## 8. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/{jsx,names}.rs`, `analyze/passes/children.rs` (the existing package branch, id from path), `ir/{decls,mod}.rs` (`ExternalRef.member`), `crates/brust-compiler/tests/**` (+ one new fixture dir), `packages/brust/src/build/{bundle,compile}.ts`, `scripts/battery/**` + `docs/react-coverage.md` + `docs/plans/m1-exit-report.md`, `docs/shadcn-coverage.md` (regenerated), `docs/plans/m1a-followups.md` (F138g). It does **not** touch `crates/brust-core`, `packages/runtime-dom`, or any `lower/**` file. Shared files with other lanes: `children.rs` (island-children, local-component), `bundle.ts` (island-children's registry): merge order is readiness order, the later lane merges `origin/main` in and regenerates the two generated docs; the lead integrates.
Gates (targeted): `cargo test -p brust-compiler`, clippy `-D warnings`, fmt; the battery script; `bun test packages/brust/test/build-*.test.ts`; `bun test scripts/shadcn` + generator twice identical; the Chromium rows of R34.38; the S0.1 per-page table before/after. Heavy runs announced on the task first (load rule).

## 9. Risks

1. **Member existence is not checked by the bundler.** `const Comp = __ns.Root` with a wrong member is `undefined` at runtime (React error on mount), not a build error (Q1).
2. **Package shape.** A member that is a *namespace* (`Menu.Sub` then `.Trigger`) or a non-component helper used as a tag is the user's mistake in React too, but the build must not turn it into a silent blank (Q1).
3. **Group-A flips need two other lanes**: island-children (children registry) and, for any wrapper with a rest spread, S1.2's call-site expansion. If a wrapper still falls back, the row does not flip and the PR says which code held it.
4. **Key/ref/`asChild` inside the island** are Radix's own (it is React); none are compiled here, so no semantics to drift.

## 10. Questions for the lead

- **Q1 Member existence check.** Recommended: v1 = runtime only plus a **build-time check through the bundler**: emit `import * as __ns from "pkg"` + a guarded `if (!__ns.X?.Y) throw` is not enough (it only fires at load). Alternative: have `brust build` `import()` the package once and verify the path (executes package code at build time; Radix is side-effect free, an arbitrary package may not be). Rule on one: (a) runtime error only, (b) build-time `import()` check, (c) `bun build --analyze`-style static export check. Recommended **(a) now, (c) as a follow-up F-row**.
- **Q2 Module-level alias consts** (`const Combobox = ComboboxPrimitive.Root`, 3 sites). Recommended: **out of this lane** (they hit `local-component`, i.e. the local-component lane's recognised-shape list); add the shape `const X = BASE.MEMBER` (never reassigned, `BASE` an import) there if the lead wants it, else leave `local-component` with the renamed message.
- **Q3 Namespace import of a relative module** (`import * as UI from "./ui"; <UI.Button/>`). Recommended: **not in v1** (`member-tag`, a follow-up resolves it to the named export `Button` of that module, which the compiler can then compile, not island). No shadcn file uses it.
- **Q4 Depth.** Recommended single level only (`<D.Sub.Trigger>` keeps `member-tag`); no shadcn site is deeper.
- **Q5 Which packages.** Recommended **any non-relative source**, not only `radix-ui` (cmdk, vaul, `@base-ui/react`, recharts, react-resizable-panels, `@shadcn/react` carry 43 of the 201 sites with the identical shape and the identical diagnostic today). A named allow-list would only keep `member-tag` for them.
- **Q6 Kind B (local object members, 8 sites).** Recommended: unchanged, `member-tag` renamed message "member of a local object (context provider?): S2". They are the context lane.
- **Q7 Order.** Recommended: this lane **after island-children merges** (the user-visible flips depend on it) but its code is independent; it can run in parallel with local-component (disjoint files except `children.rs`).
