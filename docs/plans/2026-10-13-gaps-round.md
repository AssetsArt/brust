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
- A keyed arm next to a null arm → that arm's key (a duplicate-key warning from `runtime-dom/directives/for.ts:47` is acceptable).
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

## Waves and conflicts

| Wave | Lanes | Notes |
|---|---|---|
| 1 | L1, L5, L6, L7, L10, L11 | L1 and L6 both touch `analyze/expr.rs` (different functions): second to merge rebases. L5 owns `hooks.rs` and `names.rs`. |
| 2 | L3 (after L1), L8, L9, L13 | L3 and L8 both touch `lower/template.rs`: second rebases. L13 is TS-only (`dev.ts`, `cli.ts`, new `dev/`). |
| 3 | L4 (after L3), L2 (after L1), L12 (after L9), L14 (after L13 + L10: both touch `pipeline.rs`), L15 (after L14) | |

Each lane is one PR to v2 and goes through the usual flow: READY → REVIEW-PASS → GATES-OK (full CI mirror: `cargo fmt --check`, clippy `-D warnings`, cargo test, `bun run ci`, bun tests, browser tests) → MERGE-READY. The lead merges after CI is green.

## Human decisions

All three were taken into this round by the human on 2026-10-13 ("เพิ่มทั้ง 3 ข้อเข้าไปทำได้เลย"):

- **H1** is the `buildTime()` opt-in, in L2.
- **H2** approves the SSG names (`--target static`, the `ssg` field) as ruled.
- **H3** is the hybrid static + actions output, as L12.
