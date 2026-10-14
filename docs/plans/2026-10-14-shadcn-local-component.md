# shadcn S1 — lane `local-component` / `asChild` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Tiësto · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F138f

Author: Tiësto. Status: **RULED 2026-10-14 (see §10); lane may start.** Base: origin/main 41029938. Numbers are from `docs/shadcn-coverage.md` at that commit (23 measured rows carry `fallback:local-component`, ranked #4). R-numbers continue after R34.27 (island-children). The lead ruled (island-children §9 Q1) that this is the next S1 lane, before member-tag, because it makes the real shadcn `Button`/`Badge` static and unblocks S1.3's real-Button proof (R34.20 amendment).

## 1. What the diagnostic is today

`crates/brust-compiler/src/analyze/passes/children.rs:401-427`, `Walker::local_child`: a JSX tag with no import source (`source == None`) is looked up as a **function declaration in the same module** (`ctx.local(name)`). If there is none, push `Diagnostic::fallback("local-component", "<{name}> is not a function declaration in this module")` and the child is React-tier. The parent becomes React too (`local-component` is not in `CHILD_ONLY`, test `crates/brust-compiler/tests/children.rs:165`).

Two different things reach that branch. Only one is this lane:

1. **The polymorphic tag variable** (shadcn's `asChild`). `const Comp = asChild ? Slot.Root : "button"` then `<Comp data-slot="button" … {...props} />`. `Comp` is a `const` holding a ternary, not a function declaration. This is the shape of **every** `local-component` row that is shadcn's own code. Measured: the generated "App components that block" table has 7 shadcn declarations with `local-component` (button 17 rows, badge 2, breadcrumbLink, bubbleContent, item, marker, chartContainer 1 each); the fixture has 13 `asChild ? Slot.Root : "<host>"` sites in 9 files (`button`, `badge`, `bubble`, `breadcrumb`, `item`, `marker`, `button-group`, `attachment`, `sidebar` ×5).
2. **Arrow / const-bound components and component maps** (`const Arrow = () => <i/>`, `b-component-map`, `d-lazy-component`). A different feature (lowering an arrow component, dispatch by value). **Out of scope**; they keep today's diagnostic and message (fail-closed list, §5).

It is a *symptom for the Radix rows*: the `local-component` code in `dialog`, `popover`, `tooltip` etc. comes from `Button` used inside those pages, while those rows are also `member-tag` / `external-component`. See §2.

## 2. What flips, honestly

Per-row view from the generated table (`Basis measured`). A row flips tier only if `local-component` was its only non-symptom blocker:

- **Expected to flip react → static (9 rows):** button, button-aschild, badge, badge-aslink, bubble, card, empty, item, marker. Each has exactly `island-children, local-component, spread-props`: `Button`/`Badge`/… becomes static, so `island-children` (which fires only when the child is React) and `spread-props` (S1.2's known-shape path needs the child compiled) disappear with it.
- **To verify on the fixture build (1 row):** breadcrumb. It also carries `jsx-expression`; the lane reports whether that one is the `BreadcrumbLink` slot or an unrelated expression.
- **Lose the code but stay React (13 rows):** alert-dialog, button-group, collapsible, dialog, drawer, dropdown-menu, hover-card, popover, sheet, tooltip (`member-tag`/`external-component` remain: the member-tag lane), carousel, chart, combobox (other page-level blockers). Their codes change; the scoreboard does not move for them.
- **Client JS DOES move for the 9:** a static page ships 0 KB of component JS (the runtime features only if used), versus ~85 KB gzip today (the single React island). Unlike island-children this lane is a byte win. It is measured with the S0.1 generator on the lane's fixture build and reported before/after per row. These numbers are predictions until the build says so.

I do not claim `Button` row bytes before the build runs: the `className` is `cn(buttonVariants({ variant, size, className }))` (`cva` + `cn`), which the compiler does not fold today (no `cva`/`clsx` handling in `crates/`). It lowers to a server expression; whether that makes the page need a worker/build-eval slot instead of pure static HTML is Q3.

## 3. Design (recommended): resolve the tag variable at the call site, like the rest spread

`asChild` is decided by the **call site** (`<Button asChild>`), and the component body reads it as a prop. The compiler already expands `rest` spreads at the call site when the shape is known (R34.15, "known shape"); this lane uses the same position.

**Recognition (`analyze`).** In the component body: a `const NAME = COND ? SLOT : "HOST"` (or the swapped ternary) where
- `SLOT` is `Slot`, `Slot.Root` or `Slot.Slot` imported from `radix-ui` or `@radix-ui/react-slot` (resolved through the import, so a local variable called `Slot` is not matched);
- `HOST` is a string literal that is a valid HTML tag name;
- `COND` is a bare prop identifier (destructured, with or without a default: `asChild = false`);
- `NAME` is used as a JSX tag in that component and is not reassigned.

The template keeps a `Node::Element` whose tag is `PolyTag { host, flag_prop }` instead of a `Node::Component`, so it does not reach `local_child` and raises no `local-component`.

**Expansion (lowering, per use site).** The call site (the parent's `<Button …>` element, with the props the compiler already collects for known-shape spread) picks one of three:
- (a) **flag absent or literal `false`** (`<Button>`, the default and the common case): print `<HOST …>`; identical to today's Slot-free Button. `children` as given.
- (b) **flag literal `true`** (`<Button asChild>`) **and exactly one child that is a host-element JSX literal** (`<a href="/login">Login</a>`): print the child element with the polymorphic element's props merged in, React `Slot` semantics (radix `mergeProps`): the slot's props are the base, the child's own props override; `className` is `"{slot} {child}"`; `style` objects merge, child wins; the element's children are the **child's** children (the Slot's own `children` are the child element and are dropped). The result is one element in the parent's template, so the parent stays static (or native when it owns handlers).
- (c) **flag not a literal** (a prop passed through, or read from state): fail closed (`slot-dynamic`); the component stays React exactly like today, with the new precise message instead of `local-component`.

HTML equals the React build's SSR for (a) and (b) by construction; the proof (§6) compares the rendered DOM, not the source.

**Why at the call site and not a runtime `Slot` in the browser.** A browser `Slot` is `cloneElement` + `React.Children.only`: it needs the real element tree, so it can only live in a React island, which is the cost we are removing. The flag is a literal at nearly every call site (`asChild` as a JSX boolean attribute), so the compile-time expansion covers the realistic use. Rejected: re-implementing `Slot` as a native runtime feature (a second Slot semantics to keep equal to Radix's, for a case (c) that is rare and can stay React).

**What stays out.** Radix's *own* internal `Slot` (e.g. `<DialogTrigger asChild>`, `<TooltipTrigger asChild>`): that code is inside the Radix island and is not compiled here; it is the member-tag / S3 native-Radix lane. Only a `Slot` written in the app's source (shadcn's `components/ui/*.tsx`) is handled.

## 4. Requirements (R34.28–R34.34)

- **R34.28 Polymorphic tag recognition.** `const C = flag ? Slot[.Root|.Slot] : "host"` (both orders) with `Slot` imported from `radix-ui` / `@radix-ui/react-slot`, `flag` a destructured prop, is a polymorphic element. No `local-component` for it. Any other initializer (a function call, three or more branches, a non-literal host, a non-prop condition, a reassigned `let`) keeps today's `local-component`, with a message that names why the shape was refused.
- **R34.29 Call-site expansion (a)/(b)/(c)** as §3, in the same pass that expands known-shape spreads (R34.15), including: React's later-wins order for `{...props}` around the tag; `key` and `ref` are not props (`ref` on either side of an `asChild` merge fails closed, §5); `data-*`/`aria-*`/boolean/`style` values merge as plain attributes.
- **R34.30 Slot merge semantics are Radix's, written down.** `className` concatenated slot-first; `style` merged child-wins; every other prop child-wins; handlers: see Q2. Each rule is a battery row **and** a Chromium comparison against the real Radix `Slot` rendering the same input (so a Radix change shows up as a failing test, not as silent drift).
- **R34.31 Fail closed (own message each, parent React).** Listed in §5. Each is a battery row expecting the named code.
- **R34.32 Battery + scoreboard.** New rows in `scripts/battery/rows.ts` (→ `docs/react-coverage.md`, `docs/plans/m1-exit-report.md`), §5. `docs/shadcn-coverage.md` regenerated on a fresh addon + install, twice identical. The PR names every row that flips, every row that does not, and states the measured gzip delta per flipped row (§2).
- **R34.33 Security review.** Case (b) is an attribute-merge sink: the merged attributes go through the same printer as hand-written ones (`x-*` dropped, F94; attribute-name grammar, F144; the url guard on `href`/`src`; `html_raw` as the only raw sink). Tests: `javascript:` in a slot `href` and in a child `href`, `onmouseover` smuggled as a key through `{...props}`, `</script>` in text, `dangerouslySetInnerHTML` on the child (stays the child's own literal, the existing rule applies).
- **R34.34 Parity proof.** The real fixture `components/ui/button.tsx` (unmodified, **with** the `asChild` branch) and `badge.tsx`: Chromium comparison of the built page's DOM against the React-build DOM for `button`, `button-aschild`, `badge`, `badge-aslink`; a click on `<Button>` with `onClick` from a native parent (the S1.3 R34.20 proof the amendment moved here), if S1.3 has merged by then (Q4).

## 5. Fail-closed list and battery rows

Each is a battery row (`knownGap` is not allowed; each must hold its code). All keep the component React:

| Row | Source shape | Code |
|---|---|---|
| polymorphic default | `<Button>` (flag absent) | none, static (flips) |
| polymorphic explicit false | `asChild={false}` | none, static |
| asChild literal child | `<Button asChild><a href>…</a></Button>` | none, static |
| className merge | slot `className` + child `className` | none, order asserted |
| style merge | object `style` on both | none, child wins |
| child attr wins | slot `target` vs child `target` | none, child wins |
| spread then override / override then spread | around the tag | none (R34.15 order) |
| `asChild` dynamic | `asChild={isLink}` / `asChild={props.x}` | `slot-dynamic` |
| `asChild` from state | `asChild={open}` | `slot-dynamic` |
| asChild, no child / text child / 2 children | `<Button asChild>text</Button>` | `slot-child-shape` |
| asChild, component child | `<Button asChild><Link/></Button>` | `slot-child-component` (Q1) |
| asChild, child has `ref` or Slot side has `ref` | | `slot-ref` |
| asChild, same handler on both sides | `onClick` on child and on the slot | `slot-handler` (Q2) |
| unrecognised initializer | `const C = cond ? A : B`, `let C`, 3 branches, non-literal host | `local-component` (renamed message) |
| arrow component / component map / lazy | `const Arrow = () => <i/>`, `b-component-map`, `d-lazy-component` | `local-component` (unchanged) |

## 6. Proof — the rows that flip

By §2: button, button-aschild, badge, badge-aslink, bubble, card, empty, item, marker (page `Tier` react → static, 0 islands); breadcrumb to be verified. A flip is counted only if `brust build <row>` succeeds on the fixture app **and** the Chromium comparison (R34.34) shows the same DOM as the React build. Rows that only lose the `local-component` code are listed in the PR as "unchanged tier, code removed". The `Slot` import must not appear in any client or jobs file of a flipped row (dead-import check on the built `dist/`).

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/{names,jsx,component}.rs` and `analyze/passes/children.rs` (recognition + the new diagnostics), `lower/template.rs` (the expansion, next to the R34.15 spread expansion), `crates/brust-compiler/tests/**`, `packages/brust/src/build/**` only if the polymorphic element needs a manifest/bundle change (expected not), `scripts/battery/**` + `docs/react-coverage.md` + `docs/plans/m1-exit-report.md`, `docs/shadcn-coverage.md` (regenerated), `docs/plans/m1a-followups.md` (F138f). It does **not** touch `crates/brust-core`, `packages/runtime-dom` or `bundle.ts`.
Gates (targeted): `cargo test -p brust-compiler`, clippy `-D warnings`, fmt; the battery script; `bun test scripts/shadcn` + the generator twice identical; the Chromium DOM comparison for the four rows; the full S0 fixture per-page build before/after table. Heavy runs announced on the task first (load rule).

## 8. Risks

1. **Slot semantics drift.** Radix's `mergeProps` is third-party behaviour (the same-behaviour rule R34.3). Mitigated by R34.30's comparison against the real `Slot`.
2. **`cva`/`cn` classes.** The page may still need a server evaluation for `className`; it is static *HTML* but not necessarily zero-slot (Q3). The rest-props lane's known-shape path should fold it when the call-site props are literal; to be measured, not assumed.
3. **Spread residue.** `spread-props` disappearing is predicted from S1.2; if `Button`'s `{...props}` still falls back at some call sites (non-literal rest), those rows do not flip and the PR says which.
4. **Ordering with S1.3.** Handlers through `{...props}` (`onClick` on `<Button asChild>`) need the S1.3 parent-scope binding. See Q4.

## 9. Questions for the lead

- **Q1 Component child of `asChild`** (`<Button asChild><Link href="/x"/></Button>`, `<DialogTrigger asChild><Button/></DialogTrigger>`). Radix merges the props into the child component's props. Recommended: **v1 host-element children only**; a component child is `slot-child-component` (React). Needs the child's own props shape; a follow-up F-row.
- **Q2 Same handler on both sides.** Radix composes them (child first, then slot). Recommended: v1 fails closed when both sides define the same `on*` (`slot-handler`); a handler on only one side is allowed (it lands on the one element, S1.3 path). Compose is a follow-up.
- **Q3 `cva`/`cn` and zero-slot.** Is "static page, class computed by a server slot" acceptable for the flipped rows in this lane, or must the class be folded to a literal at compile time (a separate lane for `cva`/`cn`, as R34.4 describes)? Recommended: accept the server slot; the byte win is the island removal either way.
- **Q4 Order with S1.3 (`spread-handlers`).** Real-button click proof (R34.20) needs S1.3 merged. Recommended: this lane starts now (it does not depend on S1.3 for the 9 flips); the click row is added when S1.3 is on main, and `<Button asChild onClick>` is `slot-handler` fail-closed until then.
- **Q5 Scope of recognised imports.** `radix-ui` and `@radix-ui/react-slot` only. Any other `Slot` (a hand-rolled one, `@base-ui` `render` prop) keeps `local-component`. OK?

## 10. Lead ruling (2026-10-14)

The design in §3 is accepted: recognise the polymorphic tag variable and expand it at the call site, next to the R34.15 known-shape spread; no browser `Slot`. Ledger row is **F138f** (the shadcn lanes share F138), not F146. Rulings on §9:

- **Q1 Component child of `asChild`: host-element children only in v1.** A component child is `slot-child-component` (React). The follow-up (merge into the child component's props when its shape is known) gets an F-row in this lane.
- **Q2 Same handler on both sides: fail closed (`slot-handler`).** A handler on one side only is allowed once S1.3 is on main; composition is a follow-up F-row.
- **Q3 `cva`/`cn`: accept the server slot.** A flipped row is static HTML with no component JS; whether its class is a compile-time literal is not part of the flip. `cva`/`cn` folding is a separate lane (F-row in this lane, R34.4 named as the target). The PR states, per flipped row, whether the class was folded or computed by a slot.
- **Q4 Order with S1.3: start now.** The 9 flips do not depend on S1.3. `<Button onClick>` / `<Button asChild onClick>` stay on whatever S1.3's main state gives; the R34.20 real-Button click row is added only if S1.3 is on main before this PR, else it moves to an F-row. **Merge order is readiness order** across S1.3, island-children and this lane (they share `children.rs` / `lower/template.rs`): the lane that is ready second merges `origin/main` in, resolves, and regenerates the two generated docs; the lead integrates.
- **Q5 Recognised imports: `radix-ui` and `@radix-ui/react-slot` only.** Any other `Slot` keeps `local-component` with the renamed message.

Additional ruling: §5's table is binding as written: no `knownGap` rows. The dead-import check in §6 (no `Slot` in any client or jobs file of a flipped row) is a gate, not a report.

## 11. Implementation amendments (Tiësto, review round 1)

- **Server defaults and `null` (review N1).** The real shadcn Button exposed that a precompute job never saw an omitted prop as `undefined`: `brust-core`'s `Projection::eval` hands every input root the context lacks as JSON `null` (`Path::get` is "`Null` when absent"), so `const { size = "default" } = props` never defaulted and `cva` dropped every variant class. `lower/server.rs` now emits `const size = props.size ?? (default)` for a prop with a default. Consequence: an explicit `null` also takes the default, where React keeps `null` (`<Button size={null}>`). The server cannot tell the two apart (JSON), so the omitted case, by far the common one, wins; a precise fix is a projection that leaves absent keys absent (`crates/brust-core/src/inputs.rs`, outside this lane): F151.
- **`asChild` with any function is refused (review N2).** A function prop on `<X asChild onClick>`, or an `on*` on the child, is `slot-handler` (parent React) even though S1.3 can bind a handler through a spread; composing both sides is F150.
- **Fallback, never a build error (review F1).** When the polymorphic element spreads an object of keys known only at render and the `asChild` child brings a class or style, the caller falls back with `slot-merge` (decided in `check_poly`); the printer's own `slot-merge` error is a compiler-bug backstop. A `<style>`/`<script>` child is `slot-child-shape` (its body is raw text, not markup; review N3).
- **Boundary (review N4).** Files outside §7 that the lane touched: `crates/brust-jinja/src/{lib.rs,filters/spread.rs}` (`class_join`), `crates/brust-compiler/src/lower/server.rs` (N1), `scripts/shadcn/{app.ts,run.test.ts,slot-parity.test.ts}` (the Slot-in-dist gate and the DOM parity test), `tests/fixtures/shadcn/handlers/` and `tests/server/spread-handlers.chromium.test.ts` (R34.20 on the real Button).
