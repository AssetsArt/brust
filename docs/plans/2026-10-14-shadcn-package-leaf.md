# shadcn S3 step 1 — lane `package-leaf` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: knock2 (F153a, F153b); F153c assigned at its start · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: F153a / F153b / F153c (F152 is constant-slots)

Author: knock2. Status: **RULED 2026-10-14 (see §10); F153a may start.** Base: origin/main a4a527a2. Evidence: the read-only task `package-leaf-spike` (probe pages, extracted leaf sources and the probe script live in the spike's scratchpad; every claim below that says "probe" was run through `compileTree` on those files). R-numbers continue after R34.60 (island-prop demotion) and start at R34.61. This is step 1 of R34.7 ("the compiler follows imports into packages and analyses each component like app code"): the **pure leaves** only.

## 0. Givens (from the lead's ruling on the spike)

- **G1 The only analysis input is a package's `sourcesContent`** (the authored TSX in the module's `.map`). A package module without one stays an island, exactly as today.
- **G2 Published ESM with `jsx()` calls is never analysed, and never read as an opaque slot.** A component whose body returns `jsx(...)`, `jsxs(...)` or `jsxDEV(...)` calls from `react/jsx-runtime` (or `-dev`) must fail closed with a named diagnostic, whatever package or app file it is in. Today it does not (§1).
- **G3 Package code is never executed at build time** and package sources are untrusted input to the same printer and sinks as app code.

## 1. What the spike found

| Question | Answer | Evidence |
|---|---|---|
| Can the compiler analyse a published Radix leaf from `sourcesContent`? | **Yes, as TSX it parses and lowers like app code.** All three leaves (`@radix-ui/react-label` 2.1.17, `react-separator` 1.2.0, `react-aspect-ratio` 1.2.0) have the authored `.tsx` in `dist/index.mjs.map`, as do `react-primitive` 2.2.0, `react-slot` 1.5.0 and `react-compose-refs` 1.1.5 | extracted sources, probe pages `p-label`, `p-separator`, `p-aspect` |
| From the published ESM? | **No — and it does not fail, it mis-lowers.** `dist/index.mjs` is esbuild output: `jsx()` calls, `__name(function X2(){…}, "X")` wrappers, a `"use client"` banner. The JSX reader keys on JSX *elements*; probe `q-dist`: `function Plain(p){ return jsx("div",{className:p.cls}) }` compiles as **Static with the whole return value as an opaque server slot** (`{{ _s1 \| e }}`), i.e. a React element object printed through `e`. I did not run the server to see the markup; it cannot be correct. That is a latent R34.3/R34.10 hole independent of packages | probe `q-dist`, jinja via the spike's `jin.ts` |
| Which is faithful (R34.3)? | The source is what the authors wrote; the dist is its esbuild transform and is what the React build runs. For all six modules every string/number literal of the transpiled source occurs in the dist, which adds only `__name` artefacts. So they agree here; the lane must not assume it (R34.62) | the spike's fidelity script |
| Which fixture packages publish `sourcesContent`? | **All 47 `@radix-ui/*`** packages of radix-ui 1.8.1, `input-otp` 1.5.0, `react-resizable-panels` 4.14.5, `recharts` 3.10.1 (1 map, 112 tsx), `react-hook-form` 7.90.0 (partial). **Not:** `cmdk` 1.1.1 (minified, mangled), `vaul` 1.1.2, `sonner` 2.0.8, `react-day-picker` 10.0.2, `@base-ui/react` 1.9.0, `next-themes` 0.4.6, `@shadcn/react` 0.3.1, `cn`, `class-variance-authority` | S0 survey "Libraries" + the spike's map census |

### What blocks the three leaves today (per construct, probes)

| Construct in the leaf | Today | Blocks |
|---|---|---|
| `const Label = React.forwardRef(function Label(props, forwardedRef) {…})` then `export { Label, Label as Root }` | the module's export is "not a function declaration": an opaque React island; the use site raises `fallback:child-component` | **every** leaf (first blocker; app code with `forwardRef` hits it too, battery `b-forwardref`) |
| `<Primitive.label …>` (`Primitive` imported from `@radix-ui/react-primitive`) | a member of an import: `member-tag` when the import resolves inside the project (relative), an external island when it stays a bare package specifier | every leaf |
| `Primitive` itself: `NODES.reduce((primitive, node) => { const Slot = createSlot(…); const Node = React.forwardRef(…); … return { ...primitive, [node]: Node } }, {})` plus `window[Symbol.for('radix-ui')] = true` | a computed object of forwardRef components; not analysable | every leaf |
| `const { decorative, orientation: o = D, ...domProps } = props` **in the body** | `fallback:body-shape` ("destructuring in component body") + `spread-props`; the identical code as a *parameter* pattern compiles Static (probes `a3`, `s3`) | separator, aspect-ratio |
| `{...semanticProps}` with `semanticProps = decorative ? { role: 'none' } : { 'aria-orientation': x, role: 'separator' }` | `fallback:spread-props` ("only the props object, its `...rest`, a props path or an object literal can be spread natively"); module consts, a helper function and body consts around it all compile (probe `s4`) | separator |
| `onMouseDown={(event) => { …event.target.closest(…); props.onMouseDown?.(event); if (!event.defaultPrevented && event.detail > 1) event.preventDefault() }}` | **compiles Native** (probe `l2`: page Static, Label Native) | none; it is real behaviour (double-click selection guard), so `Label` is native, never plain static |
| `ref={forwardedRef}` | a static page can drop it; no ref exists in HTML | needs a rule (R34.64) |
| `asChild` branch of `Primitive` → `Slot` (`React.Children.forEach`, `cloneElement`, `isValidElement`, `useComposedRefs`, lazy unwrapping, `React.use` lookup) | `hook-unsupported` / `jsx-expression` territory | must **not** be compiled; `asChild` is expanded at the call site (R34.28 / the local-component lane) |
| `window[Symbol.for('radix-ui')] = true` (Primitive render) | `browser-global` | a write-only marker: nothing in the installed tree reads it (grep over every `@radix-ui/*` dist), so dropping it from static/native output is harmless here (Q2) |

## 2. What it buys, honestly

Client JS gzip per page (today = `docs/shadcn-coverage.md`; "after" is **inferred** unless marked):

| Page | Today | If the leaves compile |
|---|---|---|
| aspect-ratio | 73 KB | 0 (the leaf is pure: a wrapper div and `paddingBottom` arithmetic) |
| separator | 84 KB | 0 (pure) |
| label | 84 KB | ~4.4 KB **measured** on a scratch page with a native Label: runtime 3,116 + `rt-basics` 955 + chunk 281 = 4,352 B gz; it stays native because of the handler |
| field | 86 KB | ~4.4 KB (the Label) |
| button-group | 86 KB | 0 (Separator static; the Buttons are already static) |

Preconditions: the shadcn wrapper that renders the leaf also compiles (its rest spread onto a compiled leaf is the S1.2 mechanism; `cn`/`cva` stay server slots, which carry no client bytes).

**Reach.** Of the 47 `@radix-ui/*` packages only about five are pure leaves (`label`, `separator`, `aspect-ratio`, `visually-hidden`, `arrow`). `progress`, `avatar`, `toggle`, `switch`, `checkbox`, `tabs`, … need `createContext`, controllable state and effects (the context lane and later). So this step moves roughly **5–8 of 64 rows** (the Label / Separator / AspectRatio users). Its main value is the pipeline every later Radix step reuses: package resolution, source extraction, integrity, `Primitive`, `forwardRef`.

## 3. Design (recommended)

### 3.1 Order: three app-level lanes first, then the package lane

The three blockers that are not about packages help user code too and ship on their own: (i) `forwardRef` const components, (ii) body destructuring of props, (iii) spread of a local const of known shape (a ternary of object literals), which shares the constant-slots folder. The package lane then only adds resolution, source, integrity and `Primitive` (Q5).

### 3.2 Package source (R34.61, R34.62)

The build resolves a bare import that the app's component graph reaches (Node resolution: `exports`, `module`), reads the resolved module's `.map`, and takes the tsx files from `sourcesContent`. They are **materialised on disk** under the app (`.brust/pkg-src/<name>@<version>/<path>`), keyed on the resolved **real path** (bun's store installs one `react-primitive` per dependant; the name is not a key). `compileTree` then reads ordinary files; no new napi parameter (Q4). A module with no map, no `sourcesContent`, or no tsx stays an island.

**Integrity (R34.62).** The React build runs the dist, not the map. Before a package module is analysed, the build checks that the normalised skeleton (string/number literals and identifier set) of the Bun-transpiled `sourcesContent` is contained in the dist, ignoring `__name` and the banner. A mismatch, or a dist that cannot be parsed, keeps the module an island and the coverage doc names the package (Q3).

### 3.3 `forwardRef`, `ref`, aliases (R34.63, R34.64)

`const X = React.forwardRef(function X(props, ref) {…})` (also the `/* @__PURE__ */` and `__name` wrappers esbuild leaves) is a function component whose second parameter is the `ref`. `export { X, X as Root }` and `export const Root = X` bind the same component under each name. A static or native use drops `ref={ref}` onto a **host** element (no ref in HTML). A call-site `ref={…}`, a read of the ref other than `ref={ref}` on a host, or `useImperativeHandle` fails closed (`forwardref-ref`). This lane is app-level too (§3.1).

### 3.4 `Primitive` (R34.65)

`@radix-ui/react-primitive` builds its nodes with `NODES.reduce(…)`, `createSlot` and `forwardRef`. A general evaluator for component factories is out of scope. The compiler recognises the factory **structurally**: a module whose `Primitive` export is `<constant array of string literals>.reduce((acc, node) => …forwardRef(… asChild ? Slot : node … <Comp {...rest} ref={ref}/> …), {})`. Then `Primitive.<tag>` is a host element `<tag>` with `asChild` expanded at the call site by the same code as `Button` (local-component lane: flag absent/false → host; literal true + one host child → merge; dynamic → island). No hash pin: a radix bump must not silently disable it, and a changed shape must fail closed (Q1). Rejected: a table of tags per package (a second Radix), compiling `Slot` (cloneElement, lazy elements, `React.use`).

### 3.5 Body destructuring and union spread (R34.66)

`const { a, b = 1, ...rest } = props` as the leading statement(s) of the component body reads exactly like the parameter pattern (R34.14 semantics, same fail-closed escapes). `{...x}` where `x` is a module/body `const` whose value is a conditional of object literals with literal keys lowers to the matching branches (`{% if %}` around the attribute lists), via the constant-slots folder; any other value keeps `spread-props`.

### 3.6 Reading `jsx()` calls (R34.67)

Not supported as a feature (G1/G2). The reader hardens: a call to `jsx`/`jsxs`/`jsxDEV` imported from `react/jsx-runtime(-dev)` that is not a lowered JSX element becomes a fallback diagnostic (`jsx-runtime-call`) and the component is React. Battery row. This lands first and alone (Q5): it closes the hole in §1 for app code that imports the runtime by hand.

## 4. Requirements (R34.61–R34.68)

- **R34.61 Package source.** Resolve, read `.map`, extract tsx `sourcesContent`, materialise under `.brust/pkg-src` by real path; no source ⇒ island. Never execute package code (G3).
- **R34.62 Integrity.** Skeleton containment of the transpiled source in the dist; fail closed and name the package in the doc.
- **R34.63 forwardRef components.** `const X = forwardRef(…)`, esbuild wrappers, alias exports; `ref` rules of §3.3.
- **R34.64 `ref` and fail-closed.** `forwardref-ref` for call-site refs, ref reads, imperative handles.
- **R34.65 `Primitive`.** Structural recognition and call-site `asChild` expansion as §3.4; the dropped `window[Symbol.for('radix-ui')]` marker is documented in `docs/shadcn.md` (Q2).
- **R34.66 Props shapes.** Body destructuring and known-shape union spread (§3.5).
- **R34.67 `jsx()` calls fail closed.** `jsx-runtime-call` (G2), landing before everything else.
- **R34.68 Battery, scoreboard, proof.** §5, §6. `docs/shadcn-coverage.md` and `docs/react-coverage.md` regenerated twice identical; the PR lists every row that changes tier, every row that only changes a code, and the measured gzip delta per row.

## 5. Fail-closed list and battery rows

A stub package in `node_modules` (not real Radix) per construct, so the battery does not depend on a release; each row holds its code, no `knownGap`:

| Row | Source shape | Expected |
|---|---|---|
| leaf, pure | stub `forwardRef` leaf over a stub `Primitive.div` | Static, no island |
| leaf with handler | stub label with `onMouseDown` | Native |
| `asChild` literal false / absent | `<Leaf>` | host element |
| `asChild` literal true + host child | `<Leaf asChild><a/></Leaf>` | merged host |
| `asChild` dynamic | `asChild={x}` | `slot-dynamic`, island (local-component rule) |
| call-site `ref` | `<Leaf ref={r}/>` | `forwardref-ref`, island |
| ref read in the body | `ref.current` | `forwardref-ref` |
| no sourcesContent | package with a map without `sourcesContent` | island, named in the doc |
| map ≠ dist | source changed against the dist | island, integrity message |
| dist-only package | `jsx()` calls, no map | island (G1) |
| `jsx()` in app code | `import { jsx } from 'react/jsx-runtime'; return jsx('div', {})` | `jsx-runtime-call`, React |
| Primitive shape changed | the reduce body altered | not recognised: island |
| dynamic spread | `{...x}` with `x` from a call | `spread-props` |
| body destructuring with a nested pattern | `const { a: { b } } = props` | `prop-pattern` |
| `Primitive` with `useState` added | | not recognised |

## 6. Proof — the rows that move

`aspect-ratio`, `separator`, `button-group` (static, 0 KB), `label`, `field` (native, ~4.4 KB), and the `external-component` code leaves their wrappers. A flip counts only when `brust build` succeeds, the page is **served** (build, start, fetch 200) and the Chromium comparison agrees: the Label double-click selection guard and click-through to its input, the Separator's `role`/`aria-orientation`/`data-orientation` and AspectRatio's wrapper styles against the React build's DOM. Dead-import check: the package files of a flipped row appear in no client or jobs file. Security tests: a hostile `sourcesContent` (`javascript:` href, `</script>`, `dangerouslySetInnerHTML` of a prop, a key smuggled through `{...props}`) goes through the same sinks as app code; a source that tries a dynamic `import()` or `eval` stays an island.

## 7. Boundary and gates

Boundary: `packages/brust/src/build/**` (resolution, extraction, integrity, `.brust/pkg-src`), `crates/brust-compiler/src/analyze/**` (forwardRef components, body destructuring, union spread, `Primitive` recognition, `jsx-runtime-call`) and `lower/**` for the union spread, the compiler tests and fixtures, `scripts/battery/**` + the generated reports, `docs/shadcn-coverage.md`, `docs/shadcn.md`, `docs/plans/m1a-followups.md`. Not `crates/brust-core`, `packages/runtime-dom`. Shared files with other lanes: `children.rs`, `names.rs`, `bundle.ts`: merge order is readiness order; the later lane merges `origin/main` in and regenerates the generated docs.
Gates: `cargo test -p brust-compiler`, clippy `-D warnings`, fmt; the battery script; `bun test packages/brust/test/build-*.test.ts`; `bun test scripts/shadcn` + the generator twice identical; the Chromium rows of §6; the S0.1 per-page table before/after. Heavy runs announced on the task first.

## 8. Risks

1. **`Primitive` recognition becomes a second Radix.** One structural recogniser for one factory is defensible under R34.7; if every primitive (`Presence`, `Portal`, `createContextScope`, `useControllableState`) needs its own, the lane has become the withdrawn shim. The step-2 plan must say how those are compiled (as code, by general features) or not at all.
2. **Source/dist drift.** The map is not what the React build runs. R34.62 mitigates it; unproven on wider packages, so the doc reports per package whether integrity held.
3. **Resolution identity.** One `react-primitive` per dependant in bun's store, and different versions in a real app: key on the resolved real path and version, and never merge two.
4. **Small reach.** ~5–8 rows. The step is worth it as the pipeline, and the plan says so rather than selling bytes it cannot deliver.
5. **Shared compiler files** (`children.rs`, `names.rs`, `bundle.ts`) with the lanes in flight.

## 9. Questions for the lead

- **Q1 `Primitive` recognition.** Structural (recommended) vs a per-version hash pin (breaks at every radix bump) vs a general component-factory evaluator (large, risky).
- **Q2 The write-only `window[Symbol.for('radix-ui')]` marker.** Recommended: dropped from static/native output, documented. Alternative: a native `window` write in a tiny chunk (costs bytes on every leaf page).
- **Q3 Integrity check.** Mandatory (recommended) or trust the map? It needs the dist parsed at build time (no execution).
- **Q4 Package sources on disk (`.brust/pkg-src`, recommended) vs a new napi parameter carrying virtual files.** Disk keeps `compileTree` unchanged and makes the sources inspectable; the parameter avoids a build artefact.
- **Q5 Order.** Land `jsx-runtime-call` (R34.67) first and alone, then `forwardRef` / body destructuring / union spread as app-level lanes, then the package lane (recommended) — or fold them into the package lane (one big PR, three shared files).
- **Q6 Scope of step 1.** Pure leaves only (`label`, `separator`, `aspect-ratio`, `visually-hidden`, `arrow`); `progress`, `avatar`, `toggle`, … wait for the context lane and controllable state. Confirm.

## 10. Lead ruling (2026-10-14)

Accepted, with the givens G1–G3 binding. The spike's §1 finding (a hand-written `jsx()` call compiles Static as an opaque server slot) is a correctness hole in app code today, independent of packages, so it ships first. The work is split into three lanes, each its own task, PR and ledger row:

- **F153a `jsx-runtime-call` (R34.67), now, alone.** Small; knock2. Fail closed on `jsx`/`jsxs`/`jsxDEV` from `react/jsx-runtime(-dev)`; battery row; nothing else.
- **F153b app-level component shapes (R34.63, R34.64, R34.66), next.** `forwardRef` const components (with the esbuild wrappers and alias exports) and the `ref` rules, body destructuring of props. These help ordinary React apps (`forwardRef` is everywhere), not only packages, so they are app features first. The **union spread** part of R34.66 waits for the constant-slots folder (F152) to be on main and reuses it; if F153b is ready first it ships without union spread and the union spread follows as a small PR. knock2.
- **F153c package source (R34.61, R34.62, R34.65, R34.68).** Resolution, `sourcesContent` extraction to `.brust/pkg-src`, integrity, `Primitive`. Starts after F153b merges; owner assigned then.

Rulings on §9:

- **Q1 `Primitive`: structural recognition.** A changed shape fails closed (island). No hash pin, no general factory evaluator.
- **Q2 The `window[Symbol.for('radix-ui')]` marker: dropped** from static/native output and documented in `docs/shadcn.md`, with the grep evidence that nothing in the installed tree reads it.
- **Q3 Integrity check: mandatory.** No "trust the map" option.
- **Q4 Sources on disk** under `.brust/pkg-src`, keyed by resolved real path + version; the build cleans the directory it owns (stale `.brust` content must never be read: a past trap).
- **Q5 Order: as above** (F153a → F153b → F153c).
- **Q6 Step 1 scope: pure leaves only**, confirmed.
- **Risk 1 is a gate for step 2:** the step-2 plan must say how `Presence`, `Portal`, `createContextScope` and `useControllableState` are compiled by general features, or state that they stay islands. No per-primitive recognisers beyond `Primitive`.
