# v2 gaps round: G2–G13, response size, run() cors

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @62f5d76 · flow: lane → PR → CI → lead merges

## Why

On 2026-10-13 the human approved this round: "ไปทำ brust gap", after the docs-site work. It covers:

- Gaps found by porting the docs site (ledger F95; blackboard key `gaps:docs-site`).
- Two follow-ups the human asked for on 2026-10-13:
  - loader/job responses larger than the 256 KiB SAB slot;
  - `run({ config: { cors } })`.

Every finding below was reproduced on 2026-10-13 by research agents against v2 @62f5d76. The file:line references are their evidence.

**Gap numbering.** It follows the F95 ledger row. The blackboard entry numbers some items differently:

- Blackboard G5 is the same root cause as G9 here.
- Blackboard G9 (effect order) shipped as F97.

## Rulings that apply to every lane

- **R0.1 Fail closed.** When a new path cannot prove something safe, it keeps today's behaviour: job, react tier, or error, plus a diagnostic that names the construct. It never silently renders wrong output.
- **R0.2 Real diagnostics.** Every new or changed diagnostic carries a real source location. Locations like `:0:0` are a bug; fix them wherever a lane touches the code.
- **R0.3 Rebuild the addon before testing.** Any compiler change needs `packages/brust` `bun run build:debug` first. A stale addon makes tests lie.
- **R0.4 Battery and coverage stay in sync.** `scripts/battery/rows.ts` and `docs/react-coverage.md` change in the same lane as any tier change.
- **R0.6 Ledger numbers (ruled, so lanes don't collide).** Each lane writes only its own row:

  | Row | Lane | Row | Lane | Row | Lane |
  |---|---|---|---|---|---|
  | F99 | gap-route-graph | F105 | gap-child-literals | F111 | dev-server |
  | F100 | gap-custom-hooks | F106 | gap-transparent-root | F112 | dev-trace |
  | F101 | runtime-response-size | F107 | gap-ssg | F113 | devtools-ui |
  | F102 | gap-store-ssr-snapshot | F108 | gap-island-in-inlined | F114 | actions-standalone |
  | F103 | gap-const-fold | F109 | gap-build-eval | | |
  | F104 | gap-map-cond | F110 | gap-ssg-actions | F115 | react-coverage-api |
  | F116 | css-pipeline | F117 | css-module-fold | F118 | tailwind |
  | F119 | external-island | F120 | lucide-native | F121 | route-nonascii |
  | F122 | hydrate-flake (L26, plan `2026-10-13-hydrate-flake.md`) | F123 | blank-template (L25) | F124 | ci-speed (L27, plan `2026-10-13-ci-speed.md`) |

  When two lanes add rows, the second one to merge resolves the textual conflict by keeping both rows.
- **R0.5 Each lane updates its own docs.** Update `docs/*.md` where the behaviour is documented, and add a `docs/plans/m1a-followups.md` row (F99+) marked DONE with the PR number.
  The docs site (`website/`) is updated afterwards on the docs-site branch by the lead. Lanes do not touch `website/` except where a lane below says so.

## Lanes

### L1 `gap-const-fold`: module consts fold at compile time (G5, G9, G10). Wave 1, size S–M

**Problem.** A module `const` reads as `IdentKind::Local` (`analyze/names.rs:203-206`). `try_server` accepts a Local only if placement placed it (`analyze/passes/server_expr.rs:30-33`), but `place_of` (`placement.rs:359,390-398`) only knows body-derived values. So the value becomes a precompute slot with no inputs (`placement.rs:498-506`), and the component gets `needs_worker:true` (`tier.rs:109`).

Each gap shows the same cause:
- **G9:** `useState(CONST)` takes the same path through `painted` (`placement.rs:121-125`).
- **G10:** the resulting job makes `<List>` "fed", and a fed component inside an inlined one fails `nested-instance` (`template.rs:1196-1206`).

**Fix.**
1. `module_scope` (`analyze/expr.rs:370-388`) also reads the expression tree of each `const` with a plain identifier binding, into `ModuleDecl.value: Option<RawExpr>` (`ir/mod.rs:247`). Call it from `component.rs:363` with a mutable reader.
2. `Placer::painted` and `place_of` substitute a foldable module const (one not shadowed by a body local) and then run `try_server`.
   - Server value → keep the substituted expression. Lowering already prints literals, arrays and objects into Jinja (`lower/server_expr.rs:96-207`) and escapes strings (`:62`).
   - Not a server value → keep the original slot.
   - The client chunk is unchanged: it still references the const.
3. Template lowering prints `UNDEFINED` for a non-derived local (`lower/template.rs:246-253`). Substitution, not merely marking the local placed, is what avoids that.

**Foldable values:**
- literals and template literals;
- unary `!`/`-`, binary operators and ternaries over foldable operands;
- arrays and objects of foldable values;
- member access or literal-index access on a folded value;
- other module consts, with depth ≤ 16 and a cycle guard;
- consts imported by relative path (named or default): reuse the exported-const resolver (`analyze/stores.rs:250`) and `analyze/modules.rs`.

`as const` and `satisfies` need nothing; the parser drops them.

**Not foldable:** calls, globals (`process.env`, `Date`, …), `new`, regex, functions, JSX, `let`/`var`, destructured consts (F28), and package imports.

**R1.1 Mutation (ruled).** An array or object const folds only if the name is never mutated in its module:
- no assignment to it or its members;
- no call to a mutating method (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`, `set`, `delete`, `add`, `clear`);
- not passed as a call argument other than to the template-subset array methods.

Otherwise it stays a job, which is today's behaviour. Primitives always fold.
Why: folding freezes the initial value. A long-lived worker today shows mutations, and we will not silently change that.

**R1.1a (lead ruling 2026-10-13, after Mellow's review of `gap-const-fold`, round 1).**

The mutation check is an **allowlist** of read-only uses, not a denylist. It applies to the name and to every alias of it. Allowed uses:
- member or index read;
- the target of the template-subset methods that do not mutate (`map`, `filter`, `find`, `some`, `every`, `includes`, `indexOf`, `join`, `slice`, `concat`, `at`, `length`), provided their callbacks write nothing reachable from their parameters;
- the argument of `Object.keys`, `Object.entries` or `Object.values`;
- spread into a new literal;
- a `useState` argument;
- a JSX or template read.

Every other use counts as a mutation, so the const stays a job. That includes:
- the source of a `for-of` or `for-in`;
- an element of another literal;
- the right-hand side of an assignment;
- a return value;
- any other call or method target.

Fixtures `module-const-mutated-*` cover for-of, `forEach` and a literal container. All three must stay jobs.

**R1.1b (lead ruling, Mellow N1).** An **imported** const folds only if its value is a primitive: a string, number, boolean or null, or a template literal or operator expression whose result is one of those.

Imported arrays and objects stay jobs. Another importer could mutate them, and a whole-graph scan (including dynamic imports) is not worth it this round. Record a graph scan as a possible follow-up in the ledger row. Consts defined in the same module still follow R1.1a.

**R1.2 NaN and Infinity.** Folding renders `NaN`/`Infinity` the way React does (the text `NaN`). Today's job path turns them into `null` through JSON, which is the bug, not the contract. Pin this with a dual-eval test.

**R1.3 Size cap.** If a folded value prints to more than 8 KiB of Jinja per use, it stays a slot.

**R1.4 Verify a suspected bug.** Research saw an inlined static child with a job inside a native parent: the parent reports `needs_worker:false` while its template reads `__list_…_1["_s1"]`.
- After L1 the const case no longer produces a job.
- Write a fixture where the child's job is a genuine one (e.g. a call). Verify the server still plans it, and fix it if not.

**Tests:**
- Golden fixtures `crates/brust-compiler/tests/fixtures/module-const-*`: attr, template literal, `.map`, `useState`, chain, cycle, shadowed, mutated (job), `Date.now()` (job), size cap, imported.
- `tests/placement.rs`; `tests/lower_template.rs` (escaping `"`, `</script`, newlines); `tests/dual_eval.rs`.
- A build-manifest case (static/native, `needs_worker:false`, `jobs:[]`).
- G10 repro `Page → Panel → List` builds.

### L2 `gap-build-eval`: evaluate pure helper calls at build time (G4). Wave 3 (after L1), size L

**Scope v1 (ruled).** Only helpers defined in the same file or a relatively imported file, called with arguments that are all compile-time constants after L1.

- **Compiler:** a slot qualifies when it has no inputs, is not state-dependent, is not per-item, has no guard, and is pure. Purity uses the transitive deps (`deps.rs:403-420`):
  - Globals are allowlisted: `Math` (not `random`), `JSON`, `String`, `Number`, `Array`, `Object`, `RegExp`, `encodeURIComponent`, `decodeURIComponent`.
  - Denied: `Date`, `Intl`, `crypto`, `performance`, `process`, `fetch`, `Bun`, `globalThis`.
  - Also denied: module `let`/`var` captures, and package imports.
- **Build:** `buildJobs` (`packages/brust/src/build/bundle.ts:355`) evaluates the qualifying slots once in a Bun subprocess with `TZ=UTC`, a 2 s timeout per slot, JSON-only values and a 64 KiB cap. It then recompiles through napi with slot → literal overrides, reusing L1's path from a literal to a server value. A job left with no outputs is dropped.
- **On throw, timeout or a non-JSON value:** keep the job and emit warning `build-eval` with the reason and location.

**H1 in scope (human 2026-10-13, "เพิ่มทั้ง 3 ข้อ").** Package imports and async helpers are evaluated at build only through an explicit marker.

- **API.** `import { buildTime } from '@brust/core'`, used as `const html = buildTime(() => highlight(code, 'ts'))`. It may be `async`.
- **Compiler.** It recognises the call only when `buildTime` is imported from `@brust/core`; there is no name-based guessing.
- **Purity.** Inside the closure, package imports are allowed: the opt-in is the user's statement that the call is pure. The global denylist still applies, and so do the time/random rules.
- **Ambient build-host input is never pure (ruled 2026-10-13 on Mellow's F1/F1b review findings).** `process.env`, `Bun.env` and every `import.meta.*` (`env`, `url`, `dir`, `file`, `path`) are build-machine values; a candidate that reads any of them, directly, through a same-file helper or through an imported helper, stays a job. The compiler walk must record `E::EImportMeta` explicitly (no catch-all), and the build-time runner's subprocess env is an explicit allowlist (`PATH`, `HOME`, `TZ: 'UTC'`, `NODE_ENV: 'production'`), never `...process.env`. Fixtures cover both helper shapes for `import.meta.env` and `import.meta.url`.
- **When the closure reads only compile-time constants (after L1):** it is evaluated once at build in the same Bun subprocess as the v1 path (awaited, 10 s timeout, JSON-only, 256 KiB cap). The result is baked into the template.
- **When the closure reads props or state:** it cannot be evaluated at build. It stays a precompute job, i.e. today's per-request path. With L3, a literal prop keys the job, so it is effectively computed once per distinct literal. Warn with `build-time-input`, naming the input.
- **At runtime** (the server's job, or the client chunk if it ever runs in the browser), `buildTime(fn)` just returns `fn()`, so behaviour is identical. Never ship the closure to the client: a `buildTime` call in a native or react client path is an error `build-time-client`.
- **On throw, timeout or a non-JSON value:** a build **error** naming the call site. The user asked for build time explicitly, so failing open would hide the problem.
- **Tests:**
  - shiki highlight baked into a static template (no job, no worker);
  - an async closure;
  - a props-reading closure stays a job and warns;
  - a throwing closure is a build error;
  - a client-path use is an error.
- **Docs-site follow-up (lead):** `CodeBlock` may then highlight its literal code itself.

**Tests:** baked pure helper; impure helper keeps its job; throwing helper warns; output identical to the job path (dual run).

### L3 `gap-child-literals`: F96 fallback fix + literal and expression props to a jobbed child (G2). Wave 2 (after L1), size M

**Step 1, bug (S).** The F96 fallback is defeated:
- `linked-prop-precompute` makes the parent react (`tier.rs:55-60`).
- `react_jobs` (`tier.rs:84-104`) replaces `jobs` but keeps `instances` and `child_links`, so the build still fails with `instance-prop-path` (shared-state case). In the per-row case the server runs the child's jobs for nothing.

Clear both in `react_jobs`. Regression fixture: a page with state passes `code={src + n}` → warning and builds; manifest has no child instances.

**Step 2, literal props.** `children.rs:577-596` only records `prop_path()` (`:661`).
- Record JSON literals as `literals`, as the island arm does (`children.rs:520`).
- Extend `ChildRecord` (`brust-core/src/manifest.rs:137`) and `build/manifest.ts:232-235`.
- The server merges literals into props in `PropsMap::eval` (`brust-core/src/inputs.rs:218`) **before** `job_inputs` and `plan_key`.

**R3.1 Literals belong in the key (ruled, security).** Never merge literals worker-side the way island literals are merged (`handlers.ts:172`). A child job's key is (child id, job id, projected inputs) and is shared by every instance. `<CodeBlock code="a"/>` and `<CodeBlock code="b"/>` would collide and serve each other's output.

**Step 3, template-subset expressions (ledger F60).** Ship the compiled expression in `ChildRecord.exprs`.
- The server evaluates it with minijinja `compile_expression` against the parent ctx (the row item for per-row instances), then merges and hashes it as in step 2.
- Expressions outside the subset keep a sharper error that suggests a loader or `cache()`.
- **R3.2** Reactive props (state, re-created rows) stay F96's job: the parent falls back to react. Never accept them here.

**R3.3 Manifest version.** Bump the manifest version for `literals`/`exprs`; the server refuses an older manifest version mismatch with a clear message. Keep the F88 lockstep check.

**Tests:**
- Two literal instances → distinct outputs and distinct keys (collision regression).
- Literal plus `cache((p) => p.code)`.
- A per-row expression; a manifest round trip; F96 regression.

### L4 `gap-island-in-inlined`: a react island inside an inlined component (G11). Wave 3 (after L3), size M

**Problem.** The island's ssr job is declared on the inlined component (`children.rs:548-568`), and lowering refuses `self.inline.is_some()` (`template.rs:1157-1173`).

**Fix.**
- `fed`/`is_fed` (`children.rs:315-318`, `template.rs:1532`) also count non-`client_only` ssr jobs, so the wrapper becomes a child instance record.
- The inlined printer emits the island through the instance slot dict.
- `render.rs:354-364` also walks `children[].id → jobs[].target` when injecting assets.
- An ssr job with props sets `prop_precompute`, so a linked wrapper falls back through F96 (fixed in L3).
- Keep `nested-instance` for a per-item island inside an inlined child (`pipeline.rs:1572`).

**Tests:**
- `Page → Tiers → <Search label="go"/>` builds and hydrates, with the island not bound by runtime-dom inside a nested `x-data` host (chromium e2e).
- An island's `useId` across instances stays a known issue (F63); note it in the PR.

### L5 `gap-custom-hooks`: inline native-safe custom hooks (G3). Wave 1, size M–L

**Problem.** `hook_target` (`analyze/hooks.rs:95-111`) treats any `useX` as a hook. `read_decl` (`:583-588`, statement form `:730-735`) sends every non-React hook to `hook-unsupported`. A hand-inlined body already compiles to native.

**Fix.** Inline the hook at the call site while reading the body.
- **Callee:** a module `function` in the same file, or a named or default import from a **relative** path (`modules::resolve`, `modules.rs:173`; parse it the way stores do, `stores.rs:150`).
- **Reader:**
  - A fresh `Reader` over the hook body with a hook-mode `NameTable` constructor (`names.rs:69` treats param 0 as props).
  - `read_body` (`hooks.rs:332-431`) is refactored into a shared `read_stmts(mode)`, so every existing statement rule applies.
  - `nested_hooks` (`:436`) also runs on hook bodies.
- **Hygiene:**
  - A symbol → name alias map in `NameTable` (`name()`/`kind_of`, `names.rs:156/162`), honoured by the printer through `print_with` (`analyze/expr.rs:880-891`).
  - **R5.1 (ruled).** Hook locals are named `<local>_<hookName><n>`, e.g. `d_useDebounced1`, with `n` unique per call site. Names must be checked against every symbol in both modules, and must have no leading `_` (reserved by the compiler) and no `$` (invalid in Jinja).
- **Arguments:**
  - An identifier argument aliases the parameter to the caller's name and kind.
  - Any other argument becomes a `DerivedDecl` at the call site.
  - Default or destructured parameters → fallback `hook-shape`.
- **Returns:**
  - `const d = useH()` becomes derived from the returned expression.
  - An array or object pattern is matched against a literal `return [..]` or `return {..}`.
  - Any other return shape → `hook-return-shape`.
- **Nesting:** hooks calling hooks recurse, resolving names relative to their own module. A (path, symbol) stack gives `hook-recursive`, with depth cap 8.
- **R5.2 What still falls back (ruled):**
  - unsupported React hooks inside the hook;
  - JSX or an early return in the hook body;
  - an imported hook that captures its own module's locals or imports (other than `react` and globals), or that uses `useStore`. We do not rebase import paths this round.
- **Diagnostic:** reported at the call site, naming the chain, e.g. `hook useReducer is not supported (in custom hook useCart, hooks/useCart.ts:4)`. Locations from another file are re-pointed to the call site.

**Coverage.** Battery row `c-custom-hook` (`scripts/battery/rows.ts:192`) goes react → native. Add rows: imported hook (native) and unsupported hook inside a custom hook (react, `hook-unsupported`). Update `docs/react-coverage.md`.

**Tests:**
- `tests/hooks_reader.rs`: same-file; name collision; two calls; hook calling hook; recursion; useReducer inside; imported hook.
- Golden `tests/fixtures/custom-hook-debounce/`.
- Browser case `tests/browser/cases/custom-hook-debounce.test.ts` (fake timers).

**Docs-site impact (lead).** The landing's react demo (PokemonSearch) will turn native. The lead adapts the site after the merge; the lane does not touch `website/`.

### L6 `gap-map-cond`: a `.map` returning a conditional element (G6). Wave 1, size S

**Problem.** `read_list` takes `jsx_call(&body_expr)?` (`analyze/jsx.rs:466`), so `c ? <a/> : <h4/>` and `c && <a/>` are rejected with `jsx-expression`, plus bogus `key-outside-list` warnings (`expr.rs:248`, `jsx.rs:76-85`). Inside a layout, only `outlet-in-react` at loc 0 remains (`tier.rs:85-93`).

**Fix: desugar in the reader.**
- The body may be JSX, `c ? A : B` or `c && A`, recursively. Each arm is JSX or `null`/`undefined`/`false`.
- It lowers to `[Node::If{cond, then, else_}]`. The For+If lowering already works for Jinja and `x-for`.
- Apply the same arm rule at `expr.rs:248`.

**R6.1 Keys (ruled).**
- The same key in both arms → that key.
- Different keys → `Cond(test, kA, kB)`.
- A keyed arm next to a null arm → **guarded**: `Cond(test, kA, undefined)`.
  - This is the lead amendment of 2026-10-13, after Mellow's review of `gap-map-cond` round 1, F1. An unguarded `it.link.id` throws for a row whose `link` is null, and the whole list dies.
  - `runtime-dom/directives/for.ts` treats an `undefined` key as a positional empty row, key `__nil_<i>`, **with no duplicate-key warning**. This matches React, where a `null` element carries no key.
  - Browser case: a list mixing null-link and linked rows renders, reorders, and toggles a row's link on and off.
- A JSX arm without a key → the existing `list-key` error at that arm.

**Shapes still refused** (block body, pattern/default parameter, `?.map`, non-array `Array.from`): fallback `list-shape` with the reason, e.g. "`.map` callback has a block body; return one JSX expression". Placement then skips `jsx-expression` at that location. `outlet-in-react` names the island's reason and location.

**Tests:**
- `jsx_reader.rs`.
- Fixtures `list-cond-element` (static) and `list-cond-element-state` (native).
- Browser case: toggling `href` swaps `<a>`/`<h4>` in the row.
- Battery rows `a-list-cond-element`, `a-list-cond-state`, `e-list-block-body`.

### L7 `gap-route-graph`: route Components resolved through the import graph (G7). Wave 1, size S

**Problem.** `build/scan.ts:8,24-40` reads only the entry's own default imports; `compile.ts:94-99` throws `component-source`.

**Fix.** Walk the import graph from the entry:
- Use `Bun.Transpiler.scanImports`, following import statements that resolve inside appRoot and outside `node_modules`.
- Import each `.tsx` and map `default` function identity → file.
- Post-order, first file wins, so the original definition beats a barrel re-export. Dynamic imports are skipped.
- Prototype: 90 files in 85 ms on website/.

**Errors:**
- A function found only as a named export → "export it as default".
- Outside appRoot or in `node_modules` → say so.

**Tests:** fixtures for a nav module, a barrel re-export, a named-export error, and a component outside the root.

### L8 `gap-transparent-root`: no `<brust-host>` for static roots (G8). Wave 2, size M

**Problem.** `analyze/component.rs:383` → `host_root` (`:499-526`) wraps every non-element root before the tier is known. That breaks child combinators, and content models (`<tr>` inside `<tbody>`, `<li>`, `<option>`).

**Fix.**
- `host_root` marks the wrapper `synthetic` (a new flag on `Node::Element`) and no longer warns.
- Lowering (`lower/template.rs` `element()` ~`:503-560`) prints only the children when the root is synthetic and has no host attributes (static).
- `inline_root_is_element` (`:1074`) returns false for a synthetic host.
- A component root whose inlined child is one element collapses the same way.
- Interactive (`x-data`) fragment roots keep `<brust-host>` plus the warning, reworded to mention child combinators and table/list parents.
- Comment-range hosts for interactive roots are deferred: L, needs range-aware runtime-dom.

**Snapshot churn (expected):** `tests/fixtures/payload/team.before.jinja`, `dex.after.jinja`, `hooks_reader.rs:168`, `dual_eval`.

**Tests:**
- Static fragment page; fragment `<tr>` rows in `<tbody>`; component root.
- e2e: an interactive counter still mounts.

### L9 `gap-ssg`: static output (G12). Wave 2 (after L7 preferred), size L

**R9.1 CLI (ruled; names approved by the human 2026-10-13).** `brust build routes.tsx --target static` builds the normal dist, then writes `<out>/static/`. `brust start` keeps working on the same dist.

**R9.2 Route field (ruled).** `ssg?: { params?: () => Rec[] | Promise<Rec[]> } | false`, added to `ALLOWED_ROUTE_FIELDS` (`routes.ts:40`) with validation. The server and Cloudflare targets ignore it.

**Render.** A child Bun process boots the real napi server on loopback (`startServer({host:'127.0.0.1', port:0})` + `localAddr()`) with the normal workers, fetches each path with `Accept-Encoding: identity`, then drains.
- Output is byte-identical to `brust start`.
- A child process avoids the `SERVER` singleton (`brust-napi/src/server.rs:224-229`).
- Keep a `renderPaths()` seam so an in-process host can replace it later.

**Planner** (pure, `build/ssg.ts`):
- A static pattern is rendered.
- `{p}` is substituted from `params` (URL-encoded in the request, decoded in the file name). Pin `%25` and Thai cases.
- Errors: a missing or empty value; a `/` in a value.
- **R9.3** A dynamic route without `params` is an error (`ssg-params-missing`). `ssg:false` opts the route out and is listed in the report.
- The top-level `*` route renders at a sentinel path, expects status 404, and is written to `404.html`.

**R9.4 Refused before rendering (ruled):**
- `[actions]` configured → error `ssg-actions` naming L12's hybrid output. This error is replaced by the hybrid output when L12 lands.
- A cache `prefix`/`bypass` that reads `header`/`cookie`/`query`/`request(host)` → error `ssg-varies`. Expose the grammar's read-set through a small napi helper; never re-implement it.
- `ttl` and `[cache]` are ignored (info).

**R9.5 Request reads (ruled).** With `BRUST_SSG=1`, loaders get `req = {method:'GET', url, headers:{}, cookies:{}, search:{}}` behind a proxy that records reads.
- A read → warning `ssg-request-read` (route, field, key). `--strict` turns it into an error.
- The page written is what a visitor with no cookies and no query sees.

**Responses:**
- 200 → file.
- `redirect()` → a line in `_redirects`.
- Any other status on an enumerated path → error `ssg-render` with a body excerpt.
- Loader response headers → dropped with a warning.
- HTML containing the loopback origin → error.

**Output layout:**
- `/` → `index.html`, `/docs` → `docs.html`, `/docs/x` → `docs/x.html`.
- `404.html` is always written; with no `*` route, a default one plus a warning (Pages without 404.html goes SPA mode).
- Assets come from `layoutAssets` (`build/cf-assets.ts:39`): `_brust/client/*`, `public/*`, `_headers`.
- Also `_redirects` and an `ssg.json` report. No manifest, jinja or jobs files.
- The output works on Cloudflare Pages and on Workers Static Assets (`not_found_handling="404-page"`). Document both.

**Tests:**
- Planner unit tests and validation errors.
- e2e on fixtures: redirect, 404, request read (warn and `--strict`), actions error, varies error.
- Port the reference test `git show 4ab7b15:website/test/export.test.ts` into `packages/brust/test` against a fixture app.

The docs site switches to `--target static` afterwards (lead, docs-site branch).

### L10 `runtime-response-size`: heap transfer for loader/jobs, slot knob, `run()` cors, comment fix. Wave 1, size M

**Step 1, heap reply for loader/jobs/planned.**
- **Wire.** A heap reply puts the 5 bytes `[0x00][u32 LE n]` in the slot. JSON never starts with 0x00, so the deserializers are untouched.
- **Rust.**
  - A `heap_reply: Mutex<Option<Bytes>>` per pool `Slot`, cleared in `RenderClaim::drop`.
  - `put_fetch_reply` (`brust-server/src/actions.rs:29-67`) gains a branch: slot claimed and the cell is neither Fetch nor Cache → store it, capped. The early cap check (`:34`) includes the loader cap.
  - `call_worker_decoded` (`dispatch.rs:457`) and the `call_worker_planned` closure decode the marker and verify the length, else `BadResponse`.
- **Planned path.**
  - New napi `planJobsBuf(slot, buf: Uint8Array)`: `plan_in_call` (`brust-server/src/pipeline.rs:37-73`) is refactored to take `&[u8]`.
  - Planning declined → `putFetchReply` + marker.
  - The final `{planned, results}` reply uses the same fallback.
- **TS.** `writeSlot(view, slot, slots, json, io?, cap?)` (`worker.ts:26-36`). When the reply does not fit: encode it; over the cap → today's error, naming the cap; otherwise `io.putReply` → marker.
- **R10.1 Limit (ruled).** `[server] max_loader_response_bytes` / `BRUST_MAX_LOADER_RESPONSE_BYTES` / `config.maxLoaderResponseBytes`. Default 8 MiB, range 256 KiB..64 MiB, matching the actions limits (`brust-core/src/config.rs:152`). It applies to loader and jobs replies.
- **Cloudflare.** The Cloudflare target has no slots (`brust-wasm/src/host.rs:149-163`) and gets no new limit this round; document that.
- **ABI.** The marker byte and `planJobsBuf` change the TS↔native ABI, so the F88 lockstep check must cover it.

**Step 2, slot size knob.** The human approved it (2026-10-13, items 2a+2b+2c).
- Rust already derives the slot size from the SAB length (`brust-napi/src/server.rs:249-262`, `dispatch.rs:109-128`).
- Add `slotBytes`: env `BRUST_SLOT_BYTES`, `run({config:{slotBytes}})`, and `[workers] slot_bytes`. Range 64 KiB..16 MiB, default 256 KiB.
- `run.ts:118` and the worker's fallback allocation (`worker.ts:140`) use it.
- Fix the comments that assume 256 KiB (`config.ts:51-53`, `actions-bridge.ts:25,142`, `build/config.ts:14`). `ACTION_INLINE_BODY_BYTES` stays independent.

**Step 3, `run({ config: { cors } })`.** Today `config.ts:88` uses only toml, and `checkCli` ignores `cli.cors`.
- Split `parseCors` (`:157-190`) into `corsFromToml` (snake_case mapping) and `checkCors(c, where, file|null)`.
- Unknown keys in the programmatic object are rejected (e.g. `expose_headers`).
- **R10.2 (ruled).** cli > toml as a whole-object replace, never a merge. `cors: null` turns off a toml `[cors]`.
- The Cloudflare target reads `[cors]` from toml only (`loadCors`); document that.

**Step 4, comment fix.** Replace `crates/brust-core/src/cache/key_expr.rs:9-13` with:
- headers and cookies are verbatim;
- query names and values ARE decoded (`routing/routes.rs::decode_search`, `+` → space), the same pairs as `req.search`;
- the L1 key keeps the raw sorted query (raw spellings split entries, never merge them);
- params are decoded.

Credit: knock2.

**Tests:**
- Rust: decode table (marker without reply, length mismatch, trailing bytes); put during loader/jobs; over cap; idle; `single_roundtrip.rs` planned with an oversized ctx.
- Bun: `makeDispatch` at 300 KB for loader, jobs and planned → marker; over-cap → `{error}`; config knob and cors cases with exact messages.
- e2e: a 1 MB loader page answers 200; 70 MB answers 500 naming the cap.
- Update `docs/` and the size section of the website Configuration page afterwards (lead).

### L11 `gap-store-ssr-snapshot`: islands hydrate against the SSR store snapshot (G13). Wave 1, size S

**Problem.** `packages/runtime-dom/src/store/react.ts:11-18` passes the live `store.snapshot()` as `getServerSnapshot`. Native mount effects run before idle island hydration (`island.ts:65`), so a write in between causes React #418. Reproduced under happy-dom.

**Fix.**
- In `resolveRecord` (`registry.ts:61-63`), right after `create` + `seed`, set `rec.ssr` to the computed snapshot (including computeds) and reuse it as `rec.snap`, so identity is stable.
- `react.ts` may only import types from the core. Expose the snapshot as `handle[Symbol.for('brust.ssrSnapshot')]()`; the proxy passes symbols through (`define-store.ts:107`).
- The fallback (no `rec.ssr`, server resolver) is today's `snapshot()`.
- **R11.1** If a store-snapshot application path exists for SPA navigation (`applyStoreSnapshot`), it refreshes `rec.ssr`.
- Watch the runtime-dom bundle budget (18 KB).

**Tests:**
- runtime-dom: the `hydrateRoot` repro (no recoverable errors, final DOM equals the live value), a computed key, identity.
- chromium (`tests/server/hydrate.chromium.test.ts`): a native mount effect writes the store before an island hydrates; assert no #418.

### L12 `gap-ssg-actions`: static pages + actions on Cloudflare Pages (H3). Wave 3 (after L9), size M

The human added this on 2026-10-13. `--target static` with `[actions]` configured writes the static pages exactly as L9 does, plus a Pages advanced-mode `_worker.js` that serves **only** the action prefix.

- **Worker.** The Cloudflare target build (`docs/cloudflare.md` §6: actions already run on Workers, with admission in Rust) is bundled into `_worker.js`.
- **R12.1 Routing (ruled).** A `_routes.json` lists only `"<prefix>/*"` in `include`, so pages and assets are served free as static files and never invoke the Worker. Any request that reaches the worker but is not an action falls through to `env.ASSETS.fetch(request)`.
- **Secrets and bindings** are documented for Pages (`wrangler pages` env), not baked. The build refuses `[cache]` adapters that need bindings in this mode with a clear error; ttl/L1 still do not apply to static pages.
- **Tests:**
  - an e2e on a fixture with an action, run under `wrangler pages dev` if it is available in CI, else miniflare: page served static (no worker invocation, asserted via `_routes.json` + a counter), action POST answered by the worker, cross-site guard still 403.
  - CF test deploys only under the standing rule: named `brust-test-<slug>-<sha>`, deleted every time, and only if the lane needs a real deploy. Prefer local.
- **Docs:** extend `docs/cloudflare.md` with a "Static pages + actions on Pages" section.

### L13 `dev-server`: `brust dev` for the Bun target with hot reload and an inline TUI. Wave 2, size M

The human asked for this on 2026-10-13: "เพิ่ม host reload ตอน dev", plus "ใช้ TUI แบบไม่ full screen". On the TUI, the human chose an inline terminal TUI **plus** a browser overlay (L15).

Today `cli.ts:99-100` accepts `brust dev` only with `--target cloudflare`. `dev.ts:35-84` already builds in a child process, keeps the old process on failure, and reruns through an `again` flag. Factor that into a shared watch/build loop.

**Prior art (0.1.x, `main`).** Dev reload broke in three ways that a curl soak never caught (post-mortem `a2bf5e9`):
- native pages got no client script;
- the reload frame was lost on a socket owned by a terminated worker;
- a use-after-free in the dead worker's close handler.

Two later crashes came from swapping workers in-process (`983fb16`, and `docs/superpowers/reports/2026-07-19-hot-reload-syntax-crash-diagnosis.md`). An edit during a rebuild was dropped (`8f29c26`). Error pages lost the client script, and a reconnect had no catch-up. The rulings below avoid each of these by construction.

**R13.1 Architecture (ruled).**
- A long-lived **Bun parent** owns the user's port with `Bun.serve` and acts as a proxy.
- Each successful build is booted as a **new child**: `brust start --dist-dir .brust/dev/g<N> --workers 1` on a free loopback port, with `BRUST_PORT` in its env because env beats flags (`cli.ts:13-15`).
- Swap is blue/green: wait for `[brust] ready`, switch the proxy, send `reload`, stop the old child (`run.ts:106-112`), and delete its directory.
- A failed build **or a failed boot** (template error, worker import or syntax error, timeout) keeps the old child serving.
- Never reload in-process. Reasons:
  - one `SERVER` per process (`brust-napi/src/server.rs:27`);
  - workers never restart (`run.ts:114-135`);
  - SABs are never freed (`run.ts:46-47`).

**R13.2 Browser channel (ruled).**
- WebSocket served by the parent at `/_brust/dev/ws`, with the client at `/_brust/dev/client.js`. WS, not SSE: SSE holds one of six per-host connections, so six or more tabs would stall.
- The proxy injects `<script type=module src=/_brust/dev/client.js?g=N>` into **every** `text/html` response, so native, react and error pages all get it. A plain-text 5xx on a document request is wrapped as HTML so it gets the script too.
- On connect the server sends `{gen, state, diag}`. A client whose page generation is older reloads; this is the catch-up. Reconnect uses backoff.
- Upstream requests keep `Host`. Drop `accept-encoding` upstream so injection works. The proxy must preserve `Host` and `Origin` for the actions cross-site guard; test it.
- Dev responses are sent with `cache-control: no-store`.

**R13.3 How hot (ruled).**
- v1 is a full reload for source changes, debounced about 150 ms, single-flight with a rerun flag so no edit is dropped.
- A change to `public/*.css` skips the build: copy it into the active dist (`build/index.ts:204-205`) and swap the `<link>` with `?v=`, no reload.
- Other `public/` files trigger a reload.
- HMR that preserves native component state is **deferred** (size L; state lives in factory closures, `runtime-dom/src/registry.ts`).

**Build-error overlay.**
- The parent parses `error <rule> <file:line:col> <msg>` (`cli.ts:85-88`) and sends `error`.
- The overlay sits in a shadow root above the stale page. A page loaded while builds are failing shows the overlay too.
- The next successful build sends `reload`.

**R13.4 Defaults (ruled).**
- One worker; `--workers N` overrides.
- The cold job cache after each swap is accepted (about 5 s on the docs-site home); persisting it is deferred.
- Dev builds run React in development mode: `NODE_ENV=development` for the worker **and** the client bundles (`run.ts:84`, `bundle.ts:19` `PRODUCTION`), for readable errors and hydration diffs.
- `brust start` and production builds are unchanged.

**R13.5 Inline TUI (ruled; human: not full screen).**
- Never the alternate screen. Request log lines scroll normally above: method, path, status, ms, `x-brust-cache`.
- A redrawn status block of at most 6 lines sits at the bottom:
  - state (building, ready, error), URL, generation and build ms;
  - the last page's tier counts (from L14's trace once it lands; before that, route + status);
  - the warnings count with the first warning (from L14's `dev.json`);
  - hotkeys: `r` reload browsers, `o` open, `w` list warnings, `c` clear, `q` quit.
- Redraw by cursor-up + clear, aware of width and resize (wrapped lines counted).
- Not a TTY, `CI`, or `NO_COLOR` → plain line logs with no redraw. Ctrl+C always quits cleanly and stops the children (own PIDs only).
- No TUI dependency unless it is tiny and pinned; prefer ~200 lines of local code.

**Other.**
- The `create-app` templates' `dev` script becomes `brust dev`.
- `brust dev --target cloudflare` keeps working through the same loop (wrangler behind the proxy is deferred).

**Tests.** Real Chromium, extending the `tests/server/hydrate.chromium.test.ts` `__noReload` pattern. Never a curl soak.
- A TSX edit reloads and shows the **new text**.
- A CSS edit keeps the page (the marker survives) and applies the new style.
- A syntax error shows the overlay, and fixing it recovers.
- A boot error keeps the old child serving.
- A page loaded during the error state shows the overlay.
- Two edits during one build both land.
- Native, react and 500 pages all carry the script.
- Six or more tabs still load.
- An action POST through the proxy passes the cross-site guard.
- TUI: a pty test of the non-TTY plain mode, plus a snapshot of the status block render function.

### L14 `dev-trace`: per-request trace and build metadata for dev tools. Wave 3 (after L13 and L10), size M

**R14.1 Trace transport (ruled).**
- `dev_token: Option<String>` in `CoreConfig` (`core.rs:28-40`), passed as napi `StartOptions.devToken`, set only by `brust dev`.
- `PageMeta` (`pipeline.rs:63-68`) gets an optional trace.
- `handle()` (`pipeline.rs:128-146`) adds `x-brust-dev: base64(json)` **only** when the request carries the matching token header, which only the dev proxy sends.
- The header is added after L1 storage, so it is never cached. In production the cost is a single `Option` check.
- The proxy strips the header, adds `<script type=application/json id=__brust_trace>` to the page, and keeps the last 50 traces, actions included.

**Trace contents:**
- route id, pattern and chain (`pipeline.rs:191-197`, `manifest.rs:24-31`), params (`:226-231`);
- cache outcome (`meta.cache`, `:206,220,230`);
- loader ms (wrap `s.host.loader`, `:264`, using `now_ns` as at `:129`);
- jobs: planned path `:338-354`; tokio path `:356-414`, with `JobPlan` call_id, kind, component_id, user_key and tags `:1199-1251`, plus hit or miss;
- render ms and render error (`:433`, `:708`);
- `bun_calls`;
- the components actually rendered, as `render.rs:345-363` walks them.

**R14.2 Build metadata (ruled).**
- `brust build --dev` (used by `brust dev`) writes `dev.json`: component id → source file, tier, **react reason**, and diagnostics (`rule`, `line`, `col`, `remediation`).
- Today `tierOf` drops the reason (`build/manifest.ts:93-99`) and diagnostics are only logged (`compile.ts:121-123`).
- Production builds never write it.

**R14.3 DOM mapping (ruled).**
- In dev only, Rust wraps each chain level in `<!--brust:<id>-->…<!--/brust-->` (`render.rs:142-170`). Never inside `<brust-island>`.
- Native components already carry `[x-data=<id>]`; islands carry `brust-island`.
- Markers for inlined child instances need compiler work and are **deferred**.
- A dev client build sets `__BRUST_DEV__=true` next to `PRODUCTION` (`bundle.ts:19`) and exposes the live instances (`instance.ts:74`) on a dev global. Production builds set it to false, so the minifier removes it.

**Tests:**
- No `x-brust-dev` header without the token, and none in a production build.
- A HIT response carries no stale trace.
- `dev.json` reasons match the manifest tiers.
- Markers are absent in production and absent inside islands.
- Hydration still passes in dev, measured in Chromium.

### L15 `devtools-ui`: the browser overlay. Wave 3 (after L14), size M

- **Element.** `<brust-devtools>`, only ever injected by the dev proxy, inside a shadow root (no style leaks either way). A production build contains none of it.
- **Corner indicator.** Build state plus tier counts for the page. `Alt+Shift+B` toggles the panel.
- **Panels.** Every panel shows only data from the trace, `dev.json`, the DOM or the dev global; nothing is invented.
  - **Page:** route, params, cache outcome, timings.
  - **Components:** a tree with tier badges. A react component shows its reason and the diagnostic location. Hovering highlights it on the page: chain markers via `Range.getBoundingClientRect`, native via `[x-data]`, islands via `brust-island`.
  - **Jobs:** kind, hit or miss, key.
  - **Store:** from `data-brust-store` and, when native, the live values.
  - **Islands:** hydrated or not.
  - **Build:** warnings and errors, each with `file:line`.
  - **Requests:** the last 50.
- **Accessibility.** Real buttons and tabs with roles, `Esc` closes, focus is restored, it works with the keyboard alone, and contrast is ≥ 4.5:1 in light and dark.
- **TUI.** The L13 TUI status block shows the tier counts from the same trace once this lane lands.
- **Tests.** Chromium:
  - the indicator appears in dev and never under `brust start`;
  - the Components panel lists the tiers the manifest says for the website's pages;
  - hover highlights a static chain level;
  - the keyboard flow works.

### L16 `actions-standalone`: action base URL, separate action deploys, cross-domain calls. Wave 3 (after L9; coordinate with L12), size M–L

The human asked for this on 2026-10-13: "config custom prefix path และ base domain ของ actions ได้เอง", "build แล้ว action ออกมาไป deploy แยกได้", "ทำให้ FE call action แบบต่าง domain ได้".

**What already exists** (`docs/actions.md` §6–§9):
- `[actions] prefix` is configurable. The server injects `__BRUST_ACTION_PREFIX__` when it is not the default (`crates/brust-core/src/render.rs`, `core.rs`).
- `client({ baseUrl })` takes a base per call (`packages/brust/src/actions/client.ts`).
- `[cors]` answers preflights and stamps headers.
- The cross-site guard lets an `Origin` listed in `[cors].origins` through.

The lane adds the three missing pieces below and documents the whole flow as one recipe.

**R16.1 Base URL as configuration (ruled).**
- **Runtime setting:** `[actions] base_url = "https://api.example.com"` / env `BRUST_ACTIONS_BASE_URL` / `run({ config: { actionsBaseUrl } })`. Precedence: env > run > toml.
- **Runtime, not build time:** each environment points at its own API without a rebuild, the same reason `[cors]` is runtime.
- **Validation:** an absolute http(s) origin with no path, query or fragment.
- **Injection:** when set, the server injects `globalThis.__BRUST_ACTION_BASE__` next to the prefix script. The same escaping rules as the prefix apply; it is a JSON string literal inside `<script>`, so escape `<`, `>`, `&`, U+2028 and U+2029.
- **Client resolution order:**
  1. `opts.baseUrl`
  2. the page's `__BRUST_ACTION_BASE__`
  3. relative
- Prefix resolution is unchanged. The injected prefix **does** apply when the base comes from the page global, because both come from the same deployment's config. A per-call `opts.baseUrl` keeps today's rule (prefix defaults to `/_brust/action` unless `opts.prefix` is given).
- **SSG (L9):** the value is baked at build. `--target static` reads the same setting from the build env.

**R16.2 Credentials (ruled).**
- `[actions] credentials = "same-origin" | "include" | "omit"` (default `same-origin`) is injected with the base. The client uses it as the default `RequestInit.credentials`; `opts.init` overrides it.
- `include` only works if the action deployment's `[cors]` lists the exact page origin with `credentials = true`. Document it.
- Cross-site cookies need `SameSite=None; Secure`. Document it, with the Elysia cookie example.

**R16.3 Actions-only build (ruled).**
- `brust build --actions-only`, combinable with `--target bun` (default) and `--target cloudflare`.
- The output has **no page routes**: the manifest gets empty routes and no templates, jobs or client chunks. The actions app runs behind the same Rust admission: method gate, body caps, `Content-Encoding`, the cross-site guard, CORS.
- Every non-action path answers 404 as `application/problem+json`.
- **Bun:** `brust start` serves the dist unchanged.
- **Cloudflare:** a Worker serving only actions. Reuse the CF target (`docs/cloudflare.md` §6); `wrangler.jsonc` without Static Assets.
- **R16.4 Root prefix.** Only in an actions-only build, `prefix = "/"` is allowed, so `https://api.example.com/team` maps to the app's `/team`. Amended 2026-10-13 (Mellow N3 on the review of @42c7faa): a page-only build that points at a root-prefix remote actions origin may also set `prefix = "/"`, because it mounts no actions locally; a build that serves pages and actions from one origin still may not.
  - `prefixError` (`actions/prefix.ts`) keeps refusing `/` in a normal build, where page routes would be unreachable.
  - The server's prefix match and the worker mount must handle the root without a double slash. `request.url` stays the real URL.
- `[cache]` and route options are ignored with an info line. Loaders don't exist in this mode.

**R16.4b Page-only build.** A page build may point at a separately deployed actions app. `[actions]` with `base_url` and **no** `entry` file present is valid:
- the build skips bundling actions;
- the server mounts no local app (the prefix answers 404 locally);
- `__BRUST_ACTION_BASE__` and the prefix are still injected so `client()` reaches the remote app.
- The typed client keeps importing `type App` from the shared source.

This is how "static pages on Pages + actions on their own domain" works without L12's `_worker.js`. L12 stays the single-domain option.

**R16.5 Tests:**
- **Unit:** config precedence, validation messages, escaping of the injected base, client resolution order (base + injected prefix, per-call override).
- **e2e, Bun, two deployments:**
  - an actions-only server on `127.0.0.1:<a>` with `[cors] origins=["http://localhost:<b>"]` and `credentials = true`;
  - a page server on `localhost:<b>` with `base_url="http://127.0.0.1:<a>"` and `credentials="include"`.
  - In Chromium, a page action POST succeeds cross-origin with a cookie round trip.
  - An unlisted origin gets 403 `CrossSiteRejected`.
  - The preflight answers 204 with the right headers.
  - The root prefix works on the actions-only server.
- **CF:** the actions-only Worker under `wrangler dev`/miniflare answers an action and 404s a page path. A real deploy only under the standing `brust-test-<slug>-<sha>` rule.

**Docs:** `docs/actions.md` gets a new section, "Deploy actions separately", walking end to end through two deployments, CORS, credentials and cookies. Also update `docs/cloudflare.md`. The website docs follow on docs-site (lead).

### L17 `docs-site-sync`: the website documents every merged lane (docs-site branch, lead-owned)

The human asked for this on 2026-10-13: "ถ้าทำเสร็จแล้ว update document site ด้วยนะ".

After each lane merges into v2, the lead merges v2 into `docs-site`, rebuilds the addon, and updates `website/` in the same pass:
- new pages or sections for each feature;
- live demos where the feature allows;
- every example run for real.

The changes per lane:

| Lane | Website change |
|---|---|
| L1 | Remove the workarounds that inlined literals by hand. |
| L3 | `CodeBlock` with literal props. |
| L2 | `buildTime()` for highlighting. |
| L5 | The landing's react demo becomes native; pick a genuine react demo. |
| L6 | Map conditionals in the Rendering tiers page. |
| L7 | `routes.tsx` drops its 25 workaround imports. |
| L8 | Drop `display: contents` wrappers. |
| L9 | The site builds with `--target static`; restore the export test. |
| L10 | Configuration: response size, `slotBytes`, `run()` cors. |
| L11 | Remove the TeamIsland workaround. |
| L12, L16 | Deployment and Actions pages. |
| L13–L15 | A new "Dev mode" page, plus the CLI page. |

The site's production domain is **https://brust.dev** (human, 2026-10-13). With the L9 switch, the site gets one `SITE_URL` constant in `website/lib`, canonical and `og:url` tags, `sitemap.xml` and `llms.txt`, all from that constant. It is still not deployed until the human says so.

Each pass gets screenshots in light, dark and at 400px, plus the website tests. It is a direct commit on docs-site (no PR), as before.

### L18 `react-coverage-api`: coverage per react.dev reference entry (v2: battery + generated data). Wave 1, size M

The human asked for this on 2026-10-13: "ทำ react coverage page ใน docs site … ว่า coverage Hooks ไหน components บ้างตอนนี้", with https://react.dev/reference/react as the reference. The battery (`scripts/battery/rows.ts`, 82 rows, `docs/react-coverage.md`) is organised by authoring pattern, not by React API, and many APIs have no row.

**R18.1 The source list is react.dev (ruled).**
- **Fetch it, don't type it:** enumerate every entry of the React reference at https://react.dev/reference/react, fetched when the lane runs. Record the fetch date in the file.
- **What to cover:**
  - Hooks, Components and APIs from the `react` reference.
  - The `react-dom` hooks (`useFormStatus`), the components that matter for brust (`<form>`, `<input>`, `<select>`, `<textarea>`, `<title>`, `<meta>`, `<link>`, `<style>`, `<script>`), and the APIs that matter for brust (`createPortal`, `flushSync`, resource hints).
  - Server-only entries (`'use server'`, `'use client'`, Server Components) as their own group, with brust's answer: no directives, `'use client'` is ignored with a warning.
  - Legacy APIs are out of scope.
- **Commit the list:** save it as `scripts/battery/react-api.ts`: name, group, react.dev URL.

**R18.2 Every entry gets at least one battery row (ruled).**
- **Linking:** rows gain `api?: string[]` linking them to entries.
- **Missing rows:** add one for each entry that has none, with the expected tier from the design spec where the spec says, otherwise the honest expectation and a `knownGap` note.
- **Several shapes:** an entry with several meaningful shapes gets several rows, e.g. `use(promise)` vs `use(context)`, `useEffect` with and without cleanup.
- **No claim without a row:** a test fails if any react-api entry has no row, and no claim is made without one.

**R18.3 Generated output.**
- **`docs/react-coverage.json` (new):** per entry, its status, the rows, the tiers observed, the diagnostics and a one-line note.
- **Status values (ruled):**
  - `native` (compiles to the native tier, no React shipped);
  - `static`;
  - `island` (works, rendered as a React island);
  - `partial` (some shapes native/static, others island; the note says which);
  - `unsupported` (build error / compile error);
  - `n/a` (no meaning in brust, e.g. `'use server'`).
- **Markdown:** `docs/react-coverage.md` gets a "By React API" section from the same data.
- **Regenerated by `bun run battery` and checked in CI like today**, so every gap lane that changes a tier updates the coverage automatically (R0.4).

**R18.4 Conflicts.** L5 and L6 also add battery rows. The second lane to merge rebases. Rows keep stable ids.

**Website page** (lead or a docs-site lane, after L18 merges; part of L17):
- **`/docs/react-coverage`:** a new page in the Guide nav. Its loader reads `docs/react-coverage.json` from the repo at build time. Nothing is copied by hand.
- **Layout:** grouped like react.dev (Hooks, Components, APIs, react-dom, Server), with a status badge per entry using the tier colours, the shapes and notes, and a link to the react.dev page.
- **Filters and summary:** filter by status (an interactive native component), plus the summary counts.
- **Stays current:** every later lane that changes coverage changes this page through the regenerated JSON.

### L19 `css-pipeline`: global CSS and CSS Modules, built, minified and injected. Wave 2, size M–L

The human asked for this on 2026-10-13: "built-in plugin support tailwindcss v4, support scope css และ global css, auto inject เข้าไปใน tag <head> … ไม่เกี่ยวกับอันที่ user ใส่เอง, ตอน build ทำ .min."

**Current state** (probed on 2026-10-13 against v2 with Bun 1.4.3):
- `import './x.css'` is silently dropped: the compiler records only imports that bind names (`analyze/names.rs:34-62`).
- `styles.card` from a `.module.css` becomes a precompute job on a static page.
- In a native or island client build, a CSS module fails with `unexpected output …css` (`bundle.ts:187`).
- The only CSS path today is a hand-written `<link>` to `public/`, copied unhashed (`build/index.ts:204-205`).
- What already works:
  - the server serves `/_brust/client/*.css` as `text/css` (`static_rules.rs:55,106,140`), immutable when hashed (`pipeline.rs:167`);
  - CF copies `client/*.css` (`cf-assets.ts:25`);
  - Bun's CSS bundler minifies, inlines `@import`, supports nesting and `composes:`, and does CSS Modules.

**R19.1 Global CSS (ruled).**
- **Which CSS a route gets:** every `.css` import (side-effect import, including package CSS) reachable from the route's chain files. Reachability is a BFS with `Bun.Transpiler.scanImports`, like L7's walk, so a layout import is site-wide and a page import is per-page.
- **Order:**
  1. chain order (root layout → nested layouts → page);
  2. then depth-first import order;
  3. the first occurrence wins.
- **Config entry:** `[css] global = ["styles/global.css"]` in `brust.toml` for apps without a layout. It comes first in the order.

**R19.2 Output (ruled).**
- One minified, content-hashed file per source CSS file, at `dist/client/<stem>-<hex10>.css`. A file shared by routes is one URL, so nothing is duplicated.
- Production builds always minify; dev (L13) does not.
- **Name (ruled, explained to the human):** no `.min.` infix. The hash is the cache contract: `is_hashed` reads the stem, so `.min` would cost immutable caching. Minification is always on.
- **`url()` handling:**
  - absolute `/public/*` and `/_brust/*` stay external;
  - relative font and image `url()`s are emitted as hashed assets under `client/`, and `safe_rel`/`clientOk` serve them (fold in the research's C5).

**R19.3 Injection (ruled).**
- **What:** the manifest gets `RouteRecord.css: Vec<String>` (default `[]`, `manifest.rs:24`). `inject_document_assets_into` (`render.rs:327-395`, called from `pipeline.rs:750`) inserts `<link rel="stylesheet" href="/_brust/client/…" data-brust-css>` for each entry.
- **Where:** **right after the opening `<head>` tag**, after `<meta charset>` if that comes first. Match `<head>` or `<head ` exactly, never `<header>`. With no `<head>`, the links are prepended to the document.
- **Never gated** by the all-static early return (`:367`).
- **User tags are untouched and come later**, so the user's own CSS wins in the cascade. That is the separation the human asked for.
- **Other targets:** SSG (L9) and CF reuse this through the real server and `layoutAssets`.

**R19.4 CSS Modules = scoped CSS (ruled; Vue/Svelte data-attribute scoping rejected).**
- **Why:** class names are plain strings, so the same mechanism works in static, native and react islands, and in SSR plus hydration.
- **One brust Bun plugin** in **every** JS build (browser chunks, `jobs.js`, actions, the CF worker at `cloudflare.ts:264`):
  - `.module.css` → `export default Object.freeze({…map})`;
  - plain `.css` → an empty module.
  - No JS build ever emits CSS, so the `:187` error goes away, and server and client read the same map.
- **The map:** built from one in-process Bun.build of all `*.module.css` files. A build check asserts that every hashed name exists in the emitted CSS.
- **Class names are Bun's.** They can depend on the working directory, which is harmless because one map is used per build. Switching to `lightningcss` patterns is deferred.
- **Types:** an ambient `declare module '*.module.css'` ships with `@brust/core`.
- **Without L20:** `styles.x` in a template is still a precompute job, so it works but costs a worker job.

**Tests:**
- Build fixtures for every probed case above.
- Two routes sharing a module produce one file.
- Layout/page/nested order.
- `url()` fonts.
- Rust injection with `<header>`, with no head, and with an all-static chain.
- Chromium `getComputedStyle` for global, module, a hydrated island and a `client_only` island, with no hydration warnings.
- CF and SSG layouts include the CSS.

### L20 `css-module-fold`: `styles.x` folds to a literal class at compile time. Wave 3 (after L1 and L19), size S–M

- **Fold:** `styles.x` or `styles['x']` from a `*.module.css` import becomes a string literal, so static and native templates stay static with no job.
- **Map source:** the map from L19 is a new `compileTree` argument.
- **Unknown class:** a build error with its source location.
- **Exception:** this is an explicit exception to R1.1b (frozen CSS-module maps fold even though they are imported objects).
- **Tests:** static and native fixtures have `needs_worker:false`; an unknown class gives an error; dual-eval.

### L21 `tailwind`: built-in Tailwind CSS v4. Wave 3 (after L19), size M

**R21.1 (ruled) Option A.** Use the official `bun-plugin-tailwind` (v0.1.x, zero dependencies, ships oxide), with `tailwindcss@4` as **user** dev dependencies. brust passes the plugin to the CSS Bun.build with `root: appRoot`, so content detection scans the app.

The research verified this on 2026-10-13: `@import "tailwindcss"`, `@theme` and `@apply` compiled, and `.tsx` classes were scanned (`hover:underline`, `md:grid`), minified, in 57 ms.

**Loading and errors:**
- Tailwind is loaded only when some CSS file contains `@import "tailwindcss"`, `@apply`, `@reference`, `@theme` or `@plugin`.
- If the packages are missing, the build fails with `tailwind-missing`, giving the exact `bun add -d` command.
- A warning is emitted when more than one CSS file has `@import "tailwindcss"` (the whole of Tailwind would be duplicated).

**R21.2 Users write `@reference`.** A `.module.css` that uses `@apply` needs `@reference "./app.css"`, which is standard v4. brust does not inject it; the docs show it.

**Cascade (document it).** Tailwind v4 utilities live in `@layer`, so unlayered module CSS beats utilities whatever the file order.

**create-app.** A `--tailwind` template option: `app.css` with `@import "tailwindcss"`, imported by the layout, plus the pinned dev dependencies.

**Dev (L13).** A CSS-only edit rebuilds the CSS and swaps the `data-brust-css` links with no reload. Class maps depend on the path, not the content, so they are stable. A `.tsx` edit rebuilds and reloads, and Tailwind rescans. Whichever of L13 and L19/L21 lands second wires the swap.

**Tests:**
- A fixture with Tailwind pinned as a dev dependency.
- Missing packages give the error.
- Chromium computed style of a utility class.
- A dev CSS edit is swapped without reload.

## After the round: publish, then shadcn/ui (human, 2026-10-13)

The human: "หลังจากทำทั้งหมด public version ให้ แล้ว มาทำให้ brust ใช้ https://ui.shadcn.com/docs ได้ง่ายๆแบบ framework อื่นๆ แล้วมาเก็บ coverage shadcn Components ให้หมด".

**P1. Publish.**
- **When:** after every lane L1–L24 has merged with CI green and the docs site is synced (L17).
- **What:** the lead publishes the next prerelease, **2.0.0-alpha.4**. This is the human's explicit go for this publish.
- **How:**
  - follow the release flow (`/release` skill and memory notes): `bun scripts/release-bump.ts` covers every version reference, including `bun.lock`;
  - run CI on v2 and check the run's conclusion, not just the exit code;
  - run the published-tarball install test.
- **Not included:** deploying the docs site (brust.dev). That still waits for the human's word.

**P2. shadcn/ui support** (a new plan written after P1; research first). The goal is that `npx shadcn@latest init` and `add <component>` work in a brust app the way they do in the frameworks shadcn documents. That needs:
- `components.json` and the `@/` path aliases;
- Tailwind v4 (L21) and the `cn` util;
- a `create-app --shadcn` template;
- docs.

**Behaviour.** Radix-based interactive components run as React islands. Purely presentational ones (Card, Badge, …) should compile to static or native where possible.

**P3. shadcn coverage.** Track every component in the shadcn registry, fetched from the registry rather than typed by hand, the same way L18 tracks React:
- each component gets a build-and-render row;
- the status is static, native, island, partial or unsupported, with notes;
- the output is `docs/shadcn-coverage.json`;
- it becomes a page on the docs site.

### L22 `external-island`: a component from a package must render as a React island, as the warning promises. Wave 1 (bug), size S–M

**Bug, found by the lead on 2026-10-13** with `lucide-react@0.468.0` in a scratch app against v2. `<Heart size={16}/>` in a static component, or `<Plus/>` in a native one:
- prints `warning external-component … <Heart> comes from the package lucide-react; it renders as a React island`;
- then **fails the build** with `error ssr-target staticIcon_… job j0: output _ssr_Heart names no compiled react component`.
- Inside an inlined child it fails earlier, with `nested-instance`.

So no package component works in static or native parents. That also blocks shadcn/ui (P2).

**Fix.** The ssr target of an external component is the package export itself:
- the island registry and bundling resolve `{package, export}` instead of a compiled component id;
- SSR renders it in the worker;
- the client bundles the export as an island entry;
- literal props ship as island props (the existing literals path).

Keep `nested-instance` only where L4 cannot handle it yet.

**Tests:** a scratch-package fixture (a tiny local package under the test fixtures, no network): a static parent and a native parent each use it; build OK, SSR markup present, hydrated in Chromium.

### L23 `lucide-native`: lucide-react icons compile to inline SVG (static/native), no React. Wave 2 (after L1), size M

The human asked on 2026-10-13: "lucide มัน support native ไหม". Today the answer is no; the build fails (L22). 0.1.x turned lucide icons in native routes into static SVG, including aliases (`git show main:` history of `followLucideAlias`); v2 lost that.

**R23.1 (ruled).**
- **Which imports:** a named import of an icon from `lucide-react` (or its `/icons/<name>` deep import, and aliases such as `Edit` → `SquarePen`, resolved through the package's own exports).
- **How the SVG is produced:** the icon component is rendered **at build time** with `react-dom/server` `renderToStaticMarkup`, in the build process, for the literal props at that call site. The SVG markup is inlined into the template. No React, no island, no JS.
  - The icon modules are `createLucideIcon(name, iconNode)`. Rendering keeps it exact for every lucide version and option: `size`, `color`, `strokeWidth`, `absoluteStrokeWidth`, `className`, `aria-*`, any SVG attribute.
- **Props that are not compile-time constants** (props, state, loop item):
  - Render once with sentinel values, then lower the sentinels to the template expression: `{{ … | e }}` for static, an `x-bind` for native.
  - This applies to string and number attributes only (`size` → `width`/`height`, `color` → `stroke`, `strokeWidth`, `className`).
  - Anything else falls back to L22's island, with diagnostic `icon-dynamic-prop` naming the prop.
  - A whole dynamic icon choice (`const I = cond ? Plus : Minus`) becomes a native `x-if` over the two inlined SVGs. A dynamic icon from a map or variable → island.
- **Where it works:** static, native and react (inside an island it is just React).
- **Version:** whatever `lucide-react` the app installs. No pinned copy in brust.

**R23.2 Target lucide-react 1.x (lead re-test, 2026-10-13).** The human pointed out that the latest release is 1.55.0. The lead re-ran the scratch probe on `lucide-react@1.55.0` and got the same L22 failure (`ssr-target … _ssr_Heart`). Version 1.x differs from 0.4xx in three ways:
- **`__iconData`:** icon modules expose `{name, size, node}` (`dist/esm/icons/heart.mjs`).
- **New prop:** there is a `nonScalingStroke` prop.
- **`LucideProvider`:** a context (`dist/esm/context.mjs`) supplies default `size`, `color`, `strokeWidth`, `absoluteStrokeWidth`, `nonScalingStroke` and `className` to the icons beneath it.

**How each is handled:**
- **Render, don't rebuild.** The build-time render of R23.1 stays the mechanism, so output always matches the installed version. `__iconData` may be used only for detection, never to hand-build the SVG.
- **A provider whose props are all literal** is applied at build: the icon is rendered inside a `LucideProvider` with those values.
- **A provider with dynamic props** makes the icons under it fall back to L22's island, with diagnostic `icon-provider-dynamic`.
- **Test version:** tests pin `lucide-react@1.55.0` as a dev dependency of the test package. A 0.4xx compatibility check is optional, not required.

**Tests:**
- static and native fixtures have `needs_worker:false`, no `client` chunk for a pure icon page, and the SVG equals React's output byte for byte;
- dynamic `size` and `color` from state update in the browser;
- a literal `LucideProvider` is applied, and a dynamic one falls back;
- `nonScalingStroke`;
- an alias import;
- a fallback diagnostic.
- Battery rows plus a lucide entry on the coverage pages (L18/P3).

**Docs-site follow-up (lead):** the site can use lucide icons and drop hand-written SVGs.

### L24 `route-nonascii`: a static route with non-ASCII literals 404s (bug). Wave 1, size S

**Found by Dew in `gap-ssg` (2026-10-13).** A route whose pattern has a non-ASCII literal segment, e.g. `/ข่าว` or `/docs/ภาษาไทย`, answers 404 on `brust start`. Browsers send the path percent-encoded (`/%E0%B8%82…`).

**Suspected cause.** The router matches the raw (encoded) path against the unencoded pattern. Params are already decoded **after** `router.at` (0.1.48 rule, memory "decode params shipped"); the literal part of the path never is.

**R24.1 (ruled).**
- **Routes:** patterns are normalised once at install. Each literal segment is stored percent-encoded the way browsers encode it (UTF-8, uppercase hex), so matching the raw request path works with no per-request decode. Never decode the path before matching: `%2F` must keep meaning a literal slash inside a param.
- **Requests:**
  - A request that spells a literal with different hex case (`%e0` vs `%E0`) is matched case-insensitively for the hex digits only.
  - An unencoded non-ASCII request path (curl allows it) still matches.
- **Every surface uses the same normalisation:**
  - L1 cache keys;
  - `cache.invalidate({ path })`;
  - the action prefix check;
  - SSG output file names: these come out decoded, through L9's path mapping.

**Tests:**
- Rust router unit tests: Thai literal; mixed literal + param; hex case; raw UTF-8.
- e2e: `curl` both forms → 200; Chromium navigates to a Thai URL → 200.
- An invalidation by a Thai path.

### L25 `blank-template`: the `bun create @brust/app` starter looks like a framework starter and carries the brust mark. Wave 3 (human request, 2026-10-13), size S

**Human request (2026-10-13):** "แก้ blank template ให้สวยๆ แบบ Framework อื่นๆ และใช้ favicon.svg เดียวกันกับ docs ด้วย" — make the blank template look as good as other frameworks' starters, and use the same `favicon.svg` as the docs site.

**Today.** `packages/create-app/templates/blank/` is a bare page: `pages/HomePage.tsx` renders "Hello from brust", one sentence and `<Counter />`; `public/app.css` is 14 lines; `public/favicon.svg` is a red circle left over from the pokedex era. `components/Layout.tsx` is the document root (`<html>` with `<Outlet />`, links `/public/favicon.svg` and `/public/app.css`).

**What to build.** One page that a newcomer recognises as a framework starter (compare the Vite and Next.js welcome pages for *scope*, not for look): the brust mark, the app name, one sentence that says what this page is, the working counter, and three links. No new dependencies, no web font, no build-time plugin: the template must scaffold and run offline exactly as it does now.

- **Favicon.** Replace `public/favicon.svg` with the docs site's file, byte for byte. Source: branch `docs-site`, `website/public/favicon.svg` (a rounded dark square `#062323` with an amber sun over two bars, `#f2a516`). Get it with `git show docs-site:website/public/favicon.svg > packages/create-app/templates/blank/public/favicon.svg`.
- **Mark on the page.** Inline the same SVG once in `HomePage.tsx` (as JSX, 40–48 px) next to the app name, so the page and the tab icon match. Do not load it as an `<img>` from `/public` — the page should render the mark even before static files are served.
- **Palette and type.** Reuse the docs site's palette so the starter and the docs read as one product. Tokens in `public/app.css`, light first, dark under `@media (prefers-color-scheme: dark)`, `color-scheme: light dark` kept:
  - light: `--paper: oklch(94% 0.035 78)`, `--sheet: oklch(97% 0.02 82)`, `--ink: oklch(18% 0.035 82)`, `--ink-2: oklch(36% 0.045 80)`, `--rule: oklch(76% 0.05 77)`, `--amber: oklch(68% 0.145 74)`, `--amber-ink: oklch(46% 0.12 62)`;
  - dark: `--paper: oklch(20% 0.028 185)`, `--sheet: oklch(24% 0.032 182)`, `--ink: oklch(91% 0.02 82)`, `--ink-2: oklch(77% 0.03 82)`, `--rule: oklch(36% 0.032 180)`, `--amber: oklch(74% 0.12 78)`, `--amber-ink: oklch(81% 0.11 80)`.
  - type: `ui-rounded, "SF Pro Rounded", system-ui, sans-serif` (the docs site's stack minus Nunito, which the template must not fetch). Body text at least 4.5:1 on `--paper` in both themes (`--ink` and `--ink-2` above satisfy it).
- **Layout.** Centered column, `max-width: 42rem`, 16 px side gutter at phone width, no horizontal scroll at 400 px. Top: mark + "brust app" (the `<title>` stays `brust app`) + one sentence: "Edit pages/HomePage.tsx and save. The page reloads." Middle: the counter inside a panel on `--sheet` with a one-line caption that states the fact the counter demonstrates: "useState only, so this button is native: a signal in the browser, no React shipped." Bottom: three links as a single row that wraps: Docs → `https://brust.dev`, Routes → `https://brust.dev/docs/routes`, Actions → `https://brust.dev/docs/actions`. Links are plain anchors with the amber accent, not cards with icons. One focus ring style (`:focus-visible`) for the button and the links.
- **Counter.** Keep `components/Counter.tsx` as is (useState only, native tier); only its label may change. The scaffold test asserts the rendered HTML contains `count is` (`packages/create-app/test/scaffold.test.ts:70`): keep that text, or update the assertion in the same commit.
- **Nothing else moves.** `routes.tsx`, `actions.ts`, `brust.toml`, `wrangler.jsonc.tmpl`, `package.json.tmpl`, `README.md.tmpl`, `tsconfig.json` are untouched except where a file list in `packages/create-app/test/templates.test.ts` must name a new file (there is none: no new files are added).

**Rulings.**
- **R25.1 No dependency, no network.** The template adds no npm dependency, no `<link>` to a font or CDN, no Tailwind. (`create-app --tailwind` from L21 is a separate flag and separate template concern; this lane does not touch it.)
- **R25.2 Same favicon, by file identity.** `packages/create-app/templates/blank/public/favicon.svg` must be byte-identical to `website/public/favicon.svg` on `docs-site`; a test in `packages/create-app/test/templates.test.ts` pins its content hash (compute it once and assert; the docs-site branch is not available in CI).
- **R25.3 Both themes, by hand.** Check light and dark in a real browser at desktop and 400 px width before READY; attach the four screenshots to the task as a note (paths under the scratchpad are fine; do not commit screenshots).
- **R25.4 Tier stays native.** `brust build` of the scaffolded app must still report `HomePage` as static and `Counter` as native with no react chunk. `scaffold.test.ts` already builds the app; extend its assertion to the manifest tiers.

**Tests.** `cd packages/create-app && bun run typecheck && bun test` (`templates.test.ts` for the favicon hash and file list, `scaffold.test.ts` for `count is` and the tiers). CI runs both (`ci.yml` server job).

**Docs.** `docs/getting-started.md` (or wherever `bun create @brust/app` is described) gets one sentence on what the starter page shows. Ledger row F123.

## Waves and conflicts

| Wave | Lanes | Notes |
|---|---|---|
| 1 | L1, L5, L6, L7, L10, L11, L18, L22, L24 | L1 and L6 both touch `analyze/expr.rs` (different functions): second to merge rebases. L5 owns `hooks.rs` and `names.rs`. |
| 2 | L3 (after L1), L8, L9, L13, L19, L23 (after L1; uses L22's fallback) | L3 and L8 both touch `lower/template.rs`: second rebases. L13 is TS-only (`dev.ts`, `cli.ts`, new `dev/`). |
| 3 | L4 (after L3), L2 (after L1), L12 (after L9), L14 (after L13 + L10: both touch `pipeline.rs`), L15 (after L14), L16 (after L9; L12 and L16 both touch the CF build: second rebases), L20 (after L1 + L19), L21 (after L19) | |

Each lane is one PR to v2 and goes through the usual flow: READY → REVIEW-PASS → GATES-OK (full CI mirror: `cargo fmt --check`, clippy `-D warnings`, cargo test, `bun run ci`, bun tests, browser tests) → MERGE-READY. The lead merges after CI is green.

## Human decisions

All three were taken into this round by the human on 2026-10-13 ("เพิ่มทั้ง 3 ข้อเข้าไปทำได้เลย"):

- **H1** is the `buildTime()` opt-in, in L2.
- **H2** approves the SSG names (`--target static`, the `ssg` field) as ruled.
- **H3** is the hybrid static + actions output, as L12.
- **H4** (2026-10-13, later): the blank template redesign with the docs favicon, as L25.
- **H5** (2026-10-13, later): CI wall-clock and runner minutes, as L27 (`docs/plans/2026-10-13-ci-speed.md`).
