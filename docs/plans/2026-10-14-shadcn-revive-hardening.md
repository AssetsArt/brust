# shadcn S1 — lane `revive-hardening` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Tiësto · reviewer: Mellow (security path, risk 4) · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F158

Author: Tiësto. Status: **RULED 2026-10-14 (see §10); lane may start, priority over other S1 work.** Base: origin/main e970250c. R-numbers continue after R34.68 (package-leaf). Origin: Mellow's N1 residual on constant-slots (PR #209), recorded as F158 in `docs/plans/m1a-followups.md`: *before any revive v2 (prop-path children, F148a), prove no request value can reach the revive switch.* Everything below was read from the code at the base; the two points I could not settle by reading are marked **[probe]** and are step 0 of the lane.

## 1. What the revive is today (read from `packages/brust/src/build/bundle.ts`)

`reviveSource` (L384) is one string pasted into two places: each island entry (`islandShim`, L429) and the SSR jobs bundle (`buildJobs`, L552). It defines:

- `__rv(n)`: turns a JSON marker tree (`{$brust:'el'|'fr'|'cmp'}`) into React elements. `el`: tag must match `^[a-zA-Z][a-zA-Z0-9-]*$`; props go through `__props` (drops `__proto__`, `dangerouslySetInnerHTML`, `children`, `ref`, `key`). `cmp`: the id must be an own key of this island's registry `__reg` (only components the host's lowered children name, `nestedOf`).
- `__xs(o, x)`: for every string `k` in `x` that does not start with `$` and is an own key of `o`, **`o[k] = __rv(o[k])`**.
- `__mk(C, props)` (the entry used when the host receives lowered JSX): `const { children, $x, ...rest } = props; __xs(rest, $x); createElement(C, rest, ...children.map(__rv))`.

Two inputs of `__mk` are therefore *revive switches*: the prop `$x` (which names get revived) and the prop `children` (always revived, no switch). Both arrive in `props`, and `props` is whatever the island was invoked with: on the server the SSR job's `inputs`, on the client the `data-props` JSON of the `<brust-island>` marker. Today the only writer of a legitimate `$x`/`children` is the compiler (`children.rs`: `X_KEY`, `lower_children`), and the call-site guards hold: a written or spread-inlined `$…` prop on an island fails closed (`island-prop`, `island_slots.rs` x-written/x-spread/x-nested), a `$`-named prop of a lowered component does not lower, `x` naming `children`/`ref`/`key`/`dangerouslySetInnerHTML`/`__proto__` is refused at compile time and ignored by revive if forged (`build-island-slots.test.ts`).

## 2. Threat model: which request/loader data can reach a revive

The attacker controls some JSON that the app's loader returns (a database field, a query param echoed, a CMS value). The question is whether that JSON can land in the `props` of an entry that runs `__mk`.

| # | Path | Reaches `__mk` props? | Status |
|---|---|---|---|
| P1 | A call-site island instance in a static/native template: `<Tip data={loader.x} />`. Props are enumerated by the compiler; `$x` is a compiler literal; a data prop is not in `x`, so it stays plain JSON (tested). | data never in `$x`/`children` | **safe today** |
| P2 | An island instance fed by a non-literal spread: `<Tip {...data} />`. If a spread of data could inline keys, `data.$x` would write the switch. | **[probe]**: read-only check of how an island instance with a non-literal spread is demoted; the `island-prop` rule covers only literal/inlined spreads (x-spread fixture). Must be a fixture, not an assumption. | **unproven** |
| P3 | A **route-root React host**: a route file whose component is React tier receives the loader value as its `props` (the whole-page React path: `jobs[target].ssr(inputs)`, protocol.rs L201; client hydrate from the same JSON). If that component is *also* a revive host (some other file passes it lowered children, so `nestedOf(id)` is defined), its jobs entry and island shim use `__mk`, and the loader JSON is the `props` of `__mk`. Loader data `{ "$x": ["a"], "a": {"$brust":"cmp",...}, "children": [{"$brust":"el",...}] }` then revives. This is Mellow's N1. | **yes, if the same component id is both a route root and a host** | **open (F158)** |
| P4 | A layout (`<Outlet/>` React layout) fed route data: same as P3 when the layout is a host. | same | open, same fix |
| P5 | `children` revive (no `$x` needed): `__mk` revives `children` unconditionally, so P3 is exploitable through plain `children` data, without the `$x` switch. **This widens F158: stripping `$x` alone is not enough.** | yes, same condition as P3 | open |
| P6 | Client-side: `data-props` JSON in page markup is attacker-influenced only through P1–P5 (it is the server-built props), plus DOM clobbering by third-party script, out of scope. | follows P3 | covered by P3 fix |

What an attacker gains when P3 holds: content/markup injection inside the host (any registered component or any plain element name, with attacker-chosen props). Limits that already hold: the registry is the host's own `nestedOf` list (no arbitrary component), `dangerouslySetInnerHTML` is dropped, `javascript:` URLs are rejected by React 19 (**[probe]**: confirm at the pinned React version, with a test, not from memory), string `on*` props are ignored by React. Still real: spoofed UI/content and any *registered component that is a gadget* (one that renders a prop as HTML or navigates on it). That is the reason F158 gates F148a: prop-path children would turn P3 from "compiler-fed only" into "the common path".

## 3. Design (recommended): provenance by construction, then a second lock

The revive code cannot tell a compiler-written `$x` from a data-written one: both are JSON. So do not try to filter data; make the **dangerous entry unreachable from a data-fed invocation**, and shrink what a forged switch can name.

### 3.1 Rule 1: a route-root component is never a revive host (R34.69, R34.70)

The compiler already knows which components are route roots and layouts (the route table / `exports` pass). Add one check where `note_nested` records a host (`children.rs`): if the host id is a route root or layout, or is *invoked by the router with loader data as props* (the P3/P4 set), **fail closed** with a new diagnostic `revive-host-route-root`: "the component <X> is a page/layout and also receives lowered JSX children from <file>; a route component takes request data as props, which brust never revives". The call site falls back to the existing `island-children` path (that is, the **caller** demotes, nothing becomes a build error: ruling "valid React never becomes a build error", challenge 4dc45c45). The fix side is cheap: a component that is both is rare, and the common shadcn case (a wrapper imported by pages) is not a route root.

In `bundle.ts`, the same fact is used defensively: `buildJobs` and `islandShim` take `hosts` from `nestedOf`; they additionally exclude any id the manifest marks `route_root` (a field the manifest already derives from the route table; **[probe]**: confirm the manifest/IR carries it, else the compiler adds one boolean to `ir.children`'s owner, no wire change to the Rust core). Belt and braces: even if the compiler check is bypassed, a route-root id gets `createElement(C, props)`, never `__mk`.

### 3.2 Rule 2: a forged switch can only name compiler-known names (R34.71)

`__mk(C, props)` becomes `__mk(C, props, X)` where `X` is a per-host constant emitted at build time: the union of the `x` names the compiler wrote for **that host id** across all its call sites (`ir.children[].x`, today only on the node). `__xs` revives `k` only if `k ∈ X`. A data `$x` can no longer select a data-bearing prop such as `title`; it can only re-select a name the compiler already declared an element prop of that component, and P3 is already closed by Rule 1 for the route-root case. `children` stays revived only for hosts (it is the lowered-children channel by definition).

### 3.3 Rule 3: strip the reserved keys where data enters a host (R34.72)

Whether a host invocation is data-fed cannot be decided inside the entry, so reserve at the source: the SSR job inputs of a host are built from the compiler's enumerated props only (`pipeline.rs` `plan_one`, the `_ssr_<childId>` inputs). Add a runtime assertion in `buildJobs`: an `ssr` job for a host receives no key starting with `$` other than the compiler's own `$x`; a loader value that produced one throws a plain `Error` (a 500 on that request, not a silent revive). It is the P2 net: one `Object.keys` pass per host SSR, turning an unproven path into a loud one.

R34.72 stays optional until the lead rules Q3 (see §9): Rules 1 and 2 close P3–P5; Rule 3 only guards P2, which the **[probe]** may show is already closed.

### 3.4 What is explicitly not done

No signing/nonce of `$x` (the page JS is public, a nonce readable by data authors proves nothing). No allowlist of tags beyond today's regex. No change to `__props` or the 64 KB cap. No change for P1 (safe).

## 4. Requirements (R34.69–R34.75)

- **R34.69 Route-root hosts fail closed.** New diagnostic `revive-host-route-root` on the file passing lowered children to a component that is a route root or layout; the call site falls back (no new build error).
- **R34.70 Bundle never revives a route root.** `islandShim` and `buildJobs` use `createElement(C, props)` for any route-root id regardless of `nestedOf`, so a missed compiler check cannot reach `__mk`.
- **R34.71 `X` allowlist per host.** `__mk(C, props, X)`; `__xs` revives only names in `X`; `X` is emitted per host from the compiler's `x` names, in both revive sites and the Cloudflare re-bundle (the S1.1 `exposePlugin` lesson: check every bundler).
- **R34.72 Reserved-key guard on host SSR inputs** (only if Q3 = yes): a host's `ssr` inputs may carry no `$`-key but the compiler's `$x`; else a plain thrown error.
- **R34.73 Hostile tests are gates** (§5). Forged `$x`, forged `children`, forged marker through a route-root host, non-literal spread, `javascript:` href.
- **R34.74 Docs.** `docs/shadcn-coverage.md`, `docs/react-coverage.md`, `m1-exit-report.md` regenerated twice identical; the F158 row closed with the rule list; a security note in the revive docs (what data can and cannot reach the switch) so F148a starts from a written invariant.
- **R34.75 Proof and honest leftovers.** The PR states what the lane proves (no loader value reaches `__mk` props for a route root; a forged `$x` names only compiler names) and what it does not (a registered gadget component fed through a **call-site** `$x` name remains the compiler's responsibility; DOM clobbering is out of scope).

## 5. Fail-closed list and tests (rows)

| Case | Expected |
|---|---|
| a page that is also a host (another file passes it lowered children) | `revive-host-route-root` fallback at the caller; the page keeps its tier; the build succeeds |
| a layout that is also a host | same |
| hostile loader JSON `{ $x:['a'], a:{$brust:'el',t:'b',...}, children:[...] }` into a route-root React component | rendered as **text/props, never as elements**; SSR HTML and the hydrated DOM contain no revived element (Chromium + SSR string check) |
| same JSON into a non-route-root host fed from a call site | `$x` forged to name `title` throws (existing test) and, with Rule 2, `title ∉ X` is ignored even if it is a valid marker |
| `<Tip {...data} />` where `data.$x` exists | **[probe]** result pinned as a fixture: either the `island-prop` fallback fires, or the build refuses; never a revive |
| `href: 'javascript:…'` on a revived element | no navigation (React 19 guard) — test pins it at the pinned version |
| route-root id is excluded from `hosts` in a hand-built manifest (bundle-level test, compiler check bypassed) | `createElement` entry, no `__mk` in the chunk |
| battery rows | `b-revive-route-root-host` (compile-level: demotes, builds); `b-revive-hostile-loader` (served page, Chromium: hostile data stays text); existing `b-island-slots-*` rows unchanged (no row flips; this lane moves none) |

## 6. Proof

- Cargo: unit tests in `island_slots.rs` for `revive-host-route-root` (page, layout, ordinary wrapper not flagged).
- Bun: `build-island-slots.test.ts` additions: bundle-level (route root never gets `__mk`), `X` allowlist (forged name ignored), spread fixture.
- Served-page gate (R34.73): `brust build` + `brust start` of a hostile-loader fixture, curl the SSR HTML and load it in Chromium (`tests/server/island-slots.chromium.test.ts` style); the memory rule applies: a build alone proves nothing.
- Differential: all 9 + 4 existing island-slots/S1 rows keep identical HTML (no behaviour change for compiler-fed paths); `docs/shadcn-coverage.md` numbers unchanged (**no row moves**).
- Heavy runs announced on the task note first; one cold `cargo test -p brust-compiler` plus the shadcn served-pages gate.

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/passes/children.rs` (host check), `ir/` only if a `route_root` flag is needed, `packages/brust/src/build/bundle.ts` (`reviveSource`, `islandShim`, `buildJobs`) and `cloudflare.ts` for `X`, tests and fixtures, battery rows, generated docs, ledger F158. Nothing in `crates/brust-core` (the job protocol is unchanged). Gates: Mellow signs off (revive is the one data→elements path), Illenium runs the gate set; reviewed rounds capped at 2.

## 8. Risks

1. **A host that is legitimately also a route root** (rare) loses the lowered-children path and its callers fall back to React. Acceptable and loud (diagnostic names both files), and it is the only safe answer until F148a defines data children.
2. **`X` drift**: the per-host list must come from the same compiler pass as `x` on nodes, else a legitimate element prop is no longer revived (hydration mismatch). Mitigated by the differential gate over every existing `b-island-slots-*` row, in Chromium.
3. **The `route_root` fact** might not be available where `note_nested` runs (route table resolved later). If so, the check moves to the build step that already joins components and routes, still compile-time, still a fallback.

## 9. Questions for the lead

- **Q1 Rule 1 shape.** Fail closed at the caller (`revive-host-route-root`, fallback) as drafted, or refuse the build? Recommended: fallback (ruling 4dc45c45).
- **Q2 Scope of "route root".** Pages and layouts only, or any component that a native route can reach with loader props (e.g. a React component rendered inline by a loader-fed native template with a spread)? Recommended: pages/layouts in this lane; the spread case is P2 and is pinned by the **[probe]** fixture.
- **Q3 Rule 3 (R34.72).** Include the reserved-key assertion, or leave it out if the P2 probe shows the path is closed? Recommended: include only if the probe finds a path; otherwise drop R34.72 and keep the fixture.
- **Q4 Order vs F148a.** This lane lands before any prop-path children work, and F148a's plan must cite R34.69–R34.71 as its preconditions. Recommended: yes.
- **Q5 `javascript:` URLs.** Pin React 19's behaviour with a test, or add our own scheme guard in `__props` for `href/src/action/formaction`? Recommended: test only; a second guard is the kind of drift that bites later.

## 10. Lead ruling (2026-10-14)

Accepted. The P5 finding (`__mk` revives `children` with no switch) makes this more than Mellow's N1: it is the one data→elements path, it shipped in 2.0.0-alpha.7, and it is reachable only when one component is both a route root/layout and a host of lowered children (rare; React escaping, the dropped `dangerouslySetInnerHTML` and the own-registry rule still hold). So: **no hotfix release, but this lane has priority for review and gates, and it is a blocker for 2.0.0-alpha.8.** The alpha.8 release notes carry a short security note (what could reach the revive, which versions, what changed). Rulings on §9:

- **Q1 Fallback at the caller** (`revive-host-route-root`), never a build error.
- **Q2 Pages and layouts in this lane;** the non-literal spread case (P2) is settled by the probe fixture, whatever it shows.
- **Q3 R34.72 is IN, regardless of the probe.** The assertion is one `Object.keys` pass on top-level SSR input keys of a host (not nested values, so data such as `{ "$oid": … }` inside a prop value is untouched); defense in depth on the only data→elements path is worth that cost.
- **Q4 Yes:** F148a's plan cites R34.69–R34.72 as preconditions; no prop-path children work starts before this lane is on main.
- **Q5 Test only, with a condition:** pin React 19's handling of `javascript:` for `href`, `src`, `action` and `formAction` at the pinned version. If any of the four is not neutralised, add the scheme guard in `__props` for that attribute in this lane.

Step 0 (the three probes) is reported as a task note before any code.

## 11. Lane result (Tiësto, 2026-10-14)

**Step 0 probes** (reported on the task before code): P2, a non-literal spread of data onto an island, demotes the page to React (`spread-props`) and never yields a `$x` literal (pinned: `a_nonliteral_spread_onto_an_island_never_reaches_the_revive`). React 19.3.0 `renderToString` rewrites `javascript:` to a throwing URL for `href`, `src`, `action` and `formAction` (case and whitespace variants too), so no `__props` scheme guard was added; a test pins it (`video poster` passes it through, but is not an executable context and not in the ruling). Route components are known at build time (`compile.ts` `routeComponent`) but not inside the compiler pass.

**As built, and where it differs from the draft:**
- R34.69: the build passes the route files to the compiler (`AnalyzeOptions.route_roots`, a new napi argument). The check is by **component id**, not by file: a route component is the default export of its file (`component_id(path)`), so a same-file or named component of a route file is not one (the first cut compared files and broke `cf-build` R34.22, whose host sits in the route file). A caller passing children or an element prop to it gets `revive-host-route-root` and falls back.
- R34.70: `nestedOf`/`islandShim`/`buildJobs` take the route-root set; a route component always gets `createElement`. `index.ts` also throws a `BuildError('revive-host-route-root')` if a route component is still a host after compile (a compiler bug, fail closed; mutation-tested).
- R34.71: `ChildRef.x` (the element-prop names per call site) feeds a per-host list; `__mk(C, props, X)` revives only `$x` names in `X` (default `[]`: nothing).
- R34.72: `__mk` throws on any top-level `$`-key except `$x` (nested `$oid` stays data).
- R34.73: tests in `build-island-slots.test.ts` (allowlist, reserved key, javascript: URLs, route-host build + SSR job with hostile data, `nestedOf`/`islandShim` unit), `island_slots.rs` (route component, same-file host, spread), and a served check: `brust build` + `brust start` of `fixtures/island-slots-route-host`, `GET /` with a loader returning a marker, `$x` and `$brust` renders the data as text in `<pre>`, `GET /other` (the caller, now React) renders.
- **Battery rows: none.** The battery compiles one snippet, which is always the route root, so a "route component is also a host" shape cannot be expressed; the proof is the compile test plus the build test above. `docs/react-coverage.md` is unchanged.
- **Extra fix (found by the route-root invariant being blind):** `nestedOf` returned `undefined` for `nested: []` (a host whose lowered children are plain elements only), so that island got no revive code. Fixed; five shadcn rows (aspect-ratio, checkbox, direction, label, toggle) move +1 KB gzip because they now carry it. No row changes tier.
- Release note for alpha.8 (lead's request): what could reach the revive (loader data into a component that is both a route component and a host of lowered children), which versions (2.0.0-alpha.1 to alpha.7), what changed (above).
