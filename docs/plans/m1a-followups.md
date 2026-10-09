# M1a follow-ups (risk ledger carried into M1b)

Source: Mellow's REVIEW-PASS on `m1a-foundation-core` @6c0723f (task note d8ffd4c3). None of
these block M1a; each must be either fixed or consciously accepted in the M1b plan.

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F1 | `crates/brust-compiler/src/analyze/hir.rs` (`analyze_fn` call) | Valid input that *parses* can still abort the process: the vendored React Compiler recurses without a stack guard. Probe: `return a+a+…` with 6000 terms, or a 6000-deep `<div>`; `--emit parse` exits 0, `--emit hir` dies with SIGABRT on the 8 MiB main thread (≈4× lower threshold on 2 MiB test/worker threads). | Run parse+analyze on a dedicated big-stack thread (`std::thread::Builder::stack_size`; `ensure_stack_limit` already scales) **and/or** an iterative AST depth pre-check that returns `HirError::Unsupported`. Add a regression test with the 6000-deep input either way. | M1b (host design task) |
| F2 | `crates/brust-compiler/src/parse/mod.rs:243` | `pub(crate) fn ast() -> &Ast<'static>` lets crate-internal safe code copy out `'static` borrows (e.g. `ImportRecord.path.text`) that dangle after `Parsed` drops; `AstHost` bakes the same `'static` in. | Return `&Ast<'_>` if `Ast` is covariant, or a `with_ast(|ast: &Ast<'_>| …)` accessor, **before** M1b codegen builds on it. | M1b (first task) |
| F3 | `crates/brust-compiler/src/parse/mod.rs:99-163` | Self-reference via `&'static` taken from a `Box` that is then moved into `Parsed` is UB under Miri Stacked/Tree Borrows (Box retag asserts uniqueness). No miscompile today. | Hold the buffers as `Box::into_raw` `NonNull` freed in a manual `Drop`, or `aliasable::boxed::AliasableBox`. | M1b |
| F4 | `crates/brust-compiler/src/analyze/hir.rs:176` | Each `analyze_hir` call allocates into a fresh borrowing allocator; fine per compile, worth a look when the compiler runs as a long-lived host (M2 napi). | Reuse/reset the allocator per compile in the host crate. | M2 |

Verified-good properties the reviewer confirmed (do not regress): `Parsed` is `!Send + !Sync`
(thread-local AST state cannot cross threads); `set_stack_size` stores an absolute limit so
first-call depth does not matter; `collect_scopes` is exhaustive over `ReactiveTerminal`;
vendor diff is exactly `BRUST-PATCH.md` items 1–7.

## From Afrojack's REVIEW-PASS on `m1a-fixtures-docs` @ef68d4a (note e6624dd1)

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F5 | `crates/brust-compiler/tests/fixtures.rs:41` | `BRUSTC_UPDATE=1` never deletes a stale `expected.hir.json` when a case flips to error (or the reverse), leaving two expectation files. | On update, remove the other-kind expectation file for that case. | M1b (when the runner grows `ir`/`template` emits) |
| F6 | `tests/fixtures/*/expected.hir.json` | `"identifiers": 109` is a brittle count that churns on every Bun rev bump. | Accept update-diff noise (bun-rev-bump step 8 says to inspect golden diffs), or drop the field from `HirSummary` in M1b if it carries no decision. | M1b |
| F7 | `docs/design/bun-rev-bump.md:7` | `sed -i ''` is macOS-only. | Note it, or switch to `perl -pi -e` when a Linux dev machine appears. | docs, any time |

## From the CI lane (`m1a-ci`, READY 87387114)

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F8 | `.github/workflows/ci.yml` last step | `bun check` does not exist on Bun 1.4.2 (it is a 1.4.3 feature; 1.4.2 runs the package.json `check` script). CI uses `bun build --no-bundle` (syntax only) for now. | When 1.4.3 is stable: bump `setup-bun` to it and switch the step to `bun check scripts/bun-codegen.ts`; add `bun check` for `packages/runtime-dom` in M1d. | M1d / whoever bumps Bun |
| F9 | `crates/brust-compiler/src/parse/stubs/extra.rs` | Linux needs `Bun__linux_trace_{init,close,emit}` stubs that macOS never links; more may appear when `ubuntu-latest` moves to Ubuntu 26 (2026-10-19). | Keep the stubs file platform-aware; rev-bump checklist step 7 links on both OSes. | bump checklist |

## From Mellow's REVIEW-PASS on `m1d-runtime-dom` @a0ecdf3 (PR #112)

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F10 | `packages/runtime-dom/src/mount.ts:56,71` | Multi-root: `mount(A); mount(B); unmount(A)` disconnects the single observer, so hosts inserted into B later never mount. Single-root `mount(document.body)` (the M1 path) is unaffected. | Keep a `Set` of roots; `unmount(root)` removes it, disconnects, re-observes the remaining roots; add the P10 test. | M2 (server/SPA spec) |
| F11 | `packages/runtime-dom/src/directives/bind.ts:8` | The new URL-scheme allowlist (added by the lane as hardening) refuses `data:image/*` and `blob:` on `img/video src/poster`; file-input previews and canvas blobs are legitimate. | Allow `blob:` everywhere and `data:image/(png\|jpeg\|gif\|webp\|avif)` (not svg) on `src`/`poster`; document the refusal in the README meanwhile. | M2 |
| F12 | `packages/runtime-dom/src/props-bind.ts:17-20` | If the nearest ancestor host's factory throws, its `x-props-bind` children wait forever with no warning. | On init failure, `warnOnce` for each waiting direct child. | M2 |
| F13 | `packages/runtime-dom/src/mount.ts:31` | Late-link scan visits every `[x-data]` descendant on every host mount — quadratic for deep host chains; fine at M1 sizes. | Index children by nearest host during the scan. | M2 |

## From Mellow's review of `m1b1-ir-readers` @ebd5a52 → @da67391 (PR #113)

Owner plan `M1b-2` means the item lands in the `m1b2-placement-tier` lane because its passes consume the field; `M1c` means the lowering lane; `M2` means after M1.

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F14 | `crates/brust-compiler/src/analyze/expr.rs:250` | Arrow captures include the generated JSX runtime symbol (`jsx_w77yafs4`) as a `Local` — a phantom capture with no declaration. | Exclude generated runtime refs the way `is_fragment` recognises them. | M1b-2 (deps_of must skip it anyway) |
| F15 | `analyze/jsx.rs` (`read_element` via `jsx_expr`, `in_list_body=false`) | `key-outside-list` fires falsely for `.map(x => <li key/>)` that is not a direct child: root return, prop value, wrapped call like `cond(xs.map(...))`. | Carry `in_list_body` through `jsx_expr` for map bodies in any position. | M1b-2 |
| F16 | `analyze/jsx.rs:221` `event_name` | Only lowercases: `onDoubleClick`→`doubleclick` (DOM: `dblclick`), `onClickCapture`→`clickcapture` (should be `click` + capture flag), `onFocus`/`onBlur` bubble in React but not in the DOM. | Table-driven map React event → DOM event + capture flag; M1c's `x-on-<event>` reads it. | M1c (before emitting `x-on`) |
| F17 | `analyze/hooks.rs` | `const [, setB] = useState(1)` gives `StateDecl.name == ""`; M1b-2/M1c need a signal name. | Synthesise `_sN`. | M1b-2 |
| F18 | `crates/brust-compiler-cli` `--emit ir` | `to_string_pretty` is quadratic in depth: 20000-deep JSX printed 13.2 GB; 50000-deep was SIGKILLed. Analysis itself is fine (`diag`/`hir` exit 0 in 0.07 s). | Compact JSON above a size threshold, or stream with `to_writer`. | M2 (debug command only) |
| F19 | `analyze/expr.rs:667` `print_with` | Copies the whole symbol table and allocates into the module arena per `Opaque`/`Block` print: O(symbols × prints). | Build the printer symbol copy once per component. | M2 (perf) |
| F20 | `analyze/names.rs` | A bare `props` identifier (`{props}`, `<C {...props}/>`) is `Local`, not `Prop`, so deps would miss that the whole props object is read. | Treat the props parameter binding as `Prop` root `*`; deps_of marks all props. | M1b-2 |
| F21 | `analyze/jsx.rs` `read_attr` | `ref={x}` is `Attr::Ref` for any identifier, even one not bound to `useRef`. | Cross-check against `ir.refs`; otherwise Fallback. | M1b-2 |
| F22 | `analyze/component.rs` | `export { C as default }` returns `Err(no-default-export)` instead of the default-export-shape fallback. | Resolve the export clause to the local declaration. | M2 |
| F23 | `ir/decls.rs` `PropDecl.local` | A renamed prop reads as `Ident{name: title, kind: Prop}` in structured exprs, but printed `Block`/`Opaque` sources keep the local name `heading`. | M1c's chunk printer must bind `PropDecl.local` (e.g. `const heading = props.title`) before the sources run. | M1c |
| F24 | `analyze/hooks.rs` hook walk | A method named `useX` (e.g. `obj.useThing()`) is treated as a hook → `hook-unsupported` (fail-closed). | Only bare identifiers and `React.useX` count; member calls on non-React objects are not hooks. | M2 |

## From Mellow's review of `m1b2-placement-tier` @7418cf7 (PR #114)

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F25 | `analyze/passes/tier.rs` | A local child that renders itself (recursive `Tree`) is a Fallback `import-cycle`, so the parent becomes React. Matches the plan text; a recursive native component is a plausible later ask. | Allow self-recursion for native children by emitting the child template as a named jinja macro and calling it recursively. | M2 |
| F26 | `analyze/passes/placement.rs` `lazy_init` | `useState(load)` where `load` is a module-level `function` declaration seeds the function itself (same silent-wrong class as m1b2 B1, which was scoped to arrows). | When the init is an `Ident` naming a module-level or body `function` declaration, place its call `load()`; an imported binding stays a value. One placement test. | M1e lane (same crate, small) |
| F27 | `analyze/passes/deps.rs` module branch | A module helper's `Local` capture is resolved by name with body locals first, so a helper reading module `cfg` inside a component that declares `const cfg` follows the wrong one. | Look module-helper captures up in the module table before body locals. | M2 |
| F28 | `analyze/modules.rs` `module_scope` | Skips `class` declarations and destructured module consts (`const { a } = x`), so their reads are not followed. | Read both shapes into the module table. | M2 |

## From Dew's challenge on `m1c-lowering` (ef664d23, 2026-10-09) — runtime gaps found while lowering

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F29 | `packages/runtime-dom/src/directives/for.ts:8` `SYNTAX` | `x-for`'s source is a bare member path, so an inner list whose source reads the outer loop binding (`row.cells`) cannot be reactive; every other directive already takes `path(":" bindings)?`. | Accept `path(":" bindings)?` as the source and resolve it with the row scope; compiler emits `x-for="c in _l2:row by _k2"`. | DONE — `m1d-runtime-fixes` @37cac41 (PR #116) |
| F30 | `packages/runtime-dom/src/directives/if.ts:9` | The `x-if` template clone keeps the server-paint `hidden` attribute, so toggling true inserts an invisible element (`for.ts` strips it, `if.ts` does not). | `template.removeAttribute('hidden')`. | DONE — `m1d-runtime-fixes` @37cac41 (PR #116) |

## From Dew's READY note on `m1c-lowering` @259d873 (PR #115) — gaps declared by the implementer

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F31 | `analyze/passes/tier.rs` + `lower/template` | Spread props: a spread on a host prints nothing, a spread on a component leaves the child's props undefined; analysis only warns, so the page is silently incomplete. | Make `Attr::Spread` a Fallback (`spread-props`) → tier `react` until the template backend can expand a spread whose object shape is known. | M1e lane (small; battery row E covers it) |
| F32 | `lower/template` wrappers | `<brust-if>` / `<brust-row>` wrappers inside `<table>`, `<select>`, `<ul>` are foster-parented by the HTML parser, so the DOM differs from the jinja text and the mismatch tripwire fires. | Put the directive on the single root element when the branch/row has one (no wrapper), and use comment anchors otherwise. | M2 (document as a known gap in the M1 exit report; battery marks table rows) |
| F33 | `analyze/passes/deps.rs` | A guard that reads a prop for truthiness (`user && fmt(user.balance)`) contributes only `user.balance` to the job inputs, so `user = null` and `user = {}` share a cache key with different output. | When a prop root is read as a value (not only through a member chain), add the root to the inputs. | M2 |
| F34 | server (M2) | An inlined child instance with its own precompute job reads `__<childId>_<k>[parent loop idx]`; no server runs per-instance child jobs into that key yet and no fixture exercises it. | M2 server spec: run child jobs per instance and merge under that key; add a fixture. | M2 |
| F35 | `lower/template` raw-text elements | `<script>{x}</script>` / `<style>{x}</style>` children are HTML-escaped inside raw text: safe, but the value changes silently. | Fallback `raw-text-child` → tier `react` for dynamic children of script/style. | M2 |
| F36 | `lower/template` style attribute | `style={c ? {...} : undefined}` paints `style=""` where React omits the attribute. | Guard the attribute with `{% if v is not none %}` (same as the presence rule for boolean attrs) when the value can be undefined. | M1e lane (small) |

## From the M1 battery (`m1e-battery-harness` @7c67ee2, PR #117) — rows the lead triaged

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F37 | `analyze/component.rs` default-export shape | `export default memo(Inner)` is not unwrapped: tier `react` (`default-export-shape`) where spec §3 expects `native` for a plain `memo()` wrapper. | Unwrap `memo(X)` / `memo(X, cmp)` when `X` is a local function declaration and `memo` is the `react` import; keep `forwardRef` as react. | M2 (spec §3 row stays; M1 exit report lists it as a known gap) |
| F38 | `analyze/expr.rs` printer | A dynamic `import()` inside a component makes the Bun printer panic (`import_records` assertion) — `lazy(() => import(…))` is a compile CRASH, not a fallback. | Detect `EImportCall` in the structural walk before printing any Opaque/Block source and emit Fallback `dynamic-import` (tier `react`) without printing; the whole compile must never panic on valid TSX. | DONE — `m1-hotfix-dynamic-import` @501ba69 (PR #118) |
| F39 | `analyze/hooks.rs` + server | A `useId()` value read in render falls back (`use-id-in-render`); spec §4.3 expects stable ids, which need server-generated ids from the M2 server. | M2 server: allocate ids per instance at render, seed them to the client via `x-props`. | M2 (M1 decision recorded in the exit report) |
| F40 | `analyze/jsx.rs` list forms | `Array.from(xs, fn → JSX)` is not a recognised list form (only `.map` is): tier `react` (`jsx-expression`). | Recognise `Array.from(src, fn)` and `Array.from({length:n}, fn)` as list forms with the same keyed-row rules. | M2 |
| F41 | `analyze/` diagnostics | Spec §8.1 warnings `use-client-leftover` (a leftover `'use client'` directive) and `effect-deps` (useEffect reading a value missing from its deps) are not emitted, though the battery notes claimed them. | Emit `use-client-leftover` from the directive prologue (trivial); `effect-deps` needs the deps pass — compare `deps_of(effect body)` with the declared deps array. | M2 (the M1 report must not claim them) |
| F42 | `analyze/expr.rs` `Walk` | `Walk` has no arms for `EClass` / `SClass` (nor JSX nodes), so a dynamic `import()` inside a class body declared in a component still panics the printer (Afrojack repro on 501ba69); arrow/handler/effect/JSX-attr shapes fall back correctly. | Add `EClass`/`SClass` arms (method bodies, property initialisers, static blocks, `extends`) + a `review_edges` test; belt-and-braces: `catch_unwind` around the print in `print_js` → `DYNAMIC_IMPORT_SOURCE` + Fallback so any unvisited node kind degrades instead of crashing. | M2 (first routine task) |

## From the M1 gate-hardening scrutiny (`m1-gate-hardening`, 2026-10-09) — gate gaps deliberately left for M2

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F43 | `crates/brust-compiler/tests/harness/eval.ts` | The dual-eval harness mirrors runtime-dom's directive resolution instead of calling it (it calls any function member where the runtime calls only signals; `effect` is a fake; `members.init` is never called). | Replace with a happy-dom run of the real runtime. | M2 |
| F44 | `eval.ts:98-102` | Dual eval never compares `x-show`, nor a child host's server `x-props` against the client `x-props-bind` value (one overwrites the other). | Compare both and `x-show`. | M2 |
| F45 | browser harness | happy-dom cannot see an `x-model` / `x-bind-value` first-paint mismatch (setting `input.value` does not change the attribute; `visible()` compares innerHTML) nor foster-parenting (F32). | A Chromium run (Playwright) is the only way to see them. | M2 |
| F46 | `tests/browser/cases/` | Selector-based negative assertions pass trivially on a markup change (`truthiness.test.ts:11,18`, `controlled-input.test.ts:10,16`); `parent-counter.test.ts:16` asserts only that two names differ. | Assert on the specific nodes (or a count) instead of absence of a selector. | M2 |
| F47 | `scripts/battery/run.ts` | `runBattery()` builds `brustc` twice per `bun test scripts/battery` (both test files call it) and resolves the binary from `CARGO_TARGET_DIR`/`target` only, so a global `build.target-dir` runs a stale binary. | Share one result between the files; resolve the binary via `cargo metadata`. | M2 |
