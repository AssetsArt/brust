# m3p-f-payload — static children as plain HTML, projected x-props on list hosts

owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p · escalation: lead Detoro via task challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land lever P8 of the M3-P spec (ledger F70 + F71) on lane `lane/m3p-f-payload` (from `m3p`): (F70) a static child instance gets `x-data` / `x-props` / `x-props-bind` / `x-bind-*` / `x-text` only where a client can use them — inside a row the client can re-create, or when a prop is a function or reads state — and is plain HTML everywhere else; (F71) a native host's `x-props` carries, for a prop the client reads only as the source of keyed lists, only the row fields the client can read (`rows | project("id", "num", …)`), and the full row whenever the read set cannot be proved. Bench probe D (`/dex?nocache=1`, 151 rows × `TypeBadge`) goes from 144,226 bytes/resp to ≈ 21.8 KB (Bun.serve 21,730, 0.1.x 21,860); probe I markup is unchanged. Every page whose directives are load-bearing (pokedex `DexFilter` rows, `TeamBuilder` island, `ThemeToggle`, `HeroSearch`) keeps them byte for byte.

**Architecture:** The evidence (Task 1) shows that the directives at the lead's three emission sites are all consequences of ONE fact born earlier: `crates/brust-compiler/src/analyze/passes/children.rs:436-441` creates a `ChildLink` for every `<Child …/>` whose props read a loop binding, whatever the child's tier and whether or not the list can ever change on the client. That link then (a) makes the parent `Native` (`tier.rs:71`, `child_links.is_empty()`), (b) makes the row an `x-for` row (`lower/template.rs:1381` `needs_directives`: a `Component` is directive-bearing iff `link.is_some()`), (c) prints the instance with host attributes and directives (`template.rs:1180` `p.native = … || bind.is_some()`), (d) pushes the list source and every prop into `client_uses` (`children.rs:444-466`) so `client_props` — and therefore the host's `x-props` — carries the whole list, and (e) gives the static child its own chunk (`lower/mod.rs:134`, `(ctx.linked)(id)` from `pipeline.rs:34-38`). So F70 is implemented where the fact is born: a named predicate `instance_needs_link` (child tier × what each prop reads → `None | Always | RowOnly`) plus `row_reactive` (can the client re-create this row?) in `children.rs`; a `RowOnly` link is recorded during the walk with its id (so `_pN` numbering of every surviving link is unchanged) and resolved in a second, read-only traversal once every child tier is known: kept inside a reactive row, dropped elsewhere (the node's `link` becomes `None`, the `ChildLink` and its deferred client reads are discarded). The lowering sites, the tier pass, the pipeline's `linked` set and `manifest.ts` need no change — they become correct by construction, and the plan quotes them as the consumers of the link. F71 is a small new analysis pass `projection.rs` (after `captures`): for each prop root the client reads ONLY as the plain source of keyed lists, the union of the row fields read by the row template, the key, link props and item-scoped handlers (`item_reads`, a conservative walker over `RawKind`); any read it cannot see through (a helper taking the row, `row[key]`, the row passed whole to a child, an opaque body) yields no projection. The result lives in the IR (`client_prop_projections`), the template backend emits `rows | project("a", "b.c")` in `host_attrs`, and the filter is ~60 lines in `brust-jinja`. F70 alone meets the D target; F71 is measured and pinned separately so the lead can merge F70 if F71 slips.

**Tech Stack:** Rust nightly-2026-09-15 (`rust-toolchain.toml`; `let … else`, `if let … && …` chains are already used in `template.rs`), minijinja 3.0 (`Rest<String>` varargs, `Value::from_iter`, `v.try_iter()`, `v.get_item()` — see `brust-jinja/src/lib.rs:440-478` `keys`/`entries` for the idioms), Bun for the TS gates, happy-dom for `tests/browser` and the dual-eval harness, `oha` for the bench.

**Spec:** `docs/design/2026-10-10-m3-perf-bench-design.md` §2 row P8 and §4 lane row `m3p-f-payload` (knock2, standard / review complex Mellow), §7 (integration branch `m3p`, no PR); `docs/design/2026-10-08-react-compiler-design.md` §3.2 rules 3–5 (props reach the client as JSON only when needed for the first-paint seed; keys are the `x-for` identity), §7.4 D8 (reactive props through the runtime link; `x-props-bind="_p1:item"` in a `For`); `docs/design/2026-10-09-m2-server-design.md` §3 S6 (`children[]` only for fed children; F66 static entries for chunk-bearing natives); ledger rows F70, F71, F66, F34 in `docs/plans/m1a-followups.md`.

## Global Constraints

**Lead rulings on this plan's two deviations (2026-10-10, before dispatch):**
- R-A ACCEPTED: the fix lives in analysis (`crates/brust-compiler/src/analyze/children.rs`, the `ChildLink`
  born at :436-441 for any loop-binding prop), not at the three lowering sites the spec names; those sites are
  consumers and stay untouched. The spec's file:line list was an anchor, not a mandate.
- R-B ACCEPTED WITH A FENCE: the `project` jinja filter goes in a NEW file `crates/brust-jinja/src/filters/project.rs`
  (one function) plus ONE `register()` line in `crates/brust-jinja/src/lib.rs`; nothing else in brust-jinja is
  touched by this lane (m3p-b rewrites that crate in parallel and rebases over this one line). Order of work:
  F70 (Tasks 1-3, the 48 KB host `x-props` and the per-instance directives) FIRST and measured on its own;
  F71 (Tasks 4-5) second and separable — if m3p-b lands first and the filter conflicts, re-anchor and note it.
- Tier flips Native→Static on real pages are the intended effect; the pinned assertions listed in Review Focus
  change deliberately, and the hydrate/pokedex/e2e tests are the proof that live directives survive. Reviewer bar:
  a static child that ends up plain inside a re-creatable row = silent client break = blocker.

- Lane: `cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-f-payload -b lane/m3p-f-payload m3p` — all work in `/Users/detoro/code/brust-lane-m3p-f-payload`; base is `m3p` (today `5bd26a9`; never `main`, never `v2`). Run `bun install --frozen-lockfile` there once (node_modules is per worktree).
- NO PR. When done, post READY on the Conclave task with the numbers (Task 7 Step 6); the lead merges into `m3p`.
- Boundary: `crates/brust-compiler/src/analyze/passes/{children.rs,captures.rs,projection.rs(new),mod.rs}`, `crates/brust-compiler/src/ir/mod.rs` (one field), `crates/brust-compiler/src/lower/template.rs` (`host_attrs` only, Task 5), `crates/brust-compiler/tests/{children.rs,lower_template.rs,dual_eval.rs,fixtures/payload/(new, evidence)}`, `tests/fixtures/{static-list-child,reactive-list-child,reactive-list-rows}/(new)` + the goldens of `keyed-list-child-job`, `keyed-list`, `keyed-list-child`, `nested-list`, `use-id-row`, `tests/browser/cases/reactive-list-rows.test.ts`(new), `scripts/battery/{rows.ts,exit.ts}`, `docs/react-coverage.md` + `docs/plans/m1-exit-report.md` (generated), `bench/RESULTS.{md,json}` (Task 7 only). **Boundary amendment the lead must see at READY (say so in the note):** (1) `crates/brust-jinja/src/lib.rs` gains ONE filter (`project`, Task 4) — brust-jinja is also touched by `m3p-b` (P3 map object); keep the filter in a separate block at the end of the filter list and never touch `json_attr`; (2) assertion-only edits to tests that pinned the dead attributes: `packages/brust/test/{e2e.test.ts,build-manifest.test.ts,fixtures/app.expected-manifest.json}` and `tests/server/pokedex.test.ts:91`. Do NOT touch `crates/brust-server`, `packages/brust/src/worker.ts`, `packages/brust/src/build/manifest.ts` (it needs no change: a dropped link ⇒ no chunk ⇒ `client: null` ⇒ no F66 entry), or `packages/runtime-dom` (no consumer needs to tolerate anything: `mount.ts:12-17` `readProps` returns `{}` without `x-props`, and a plain element under a host is just DOM to `walkChildren`).
- After ANY Rust edit, rebuild the addon before any TS test: `cd packages/brust && bun run build:debug` — a stale `.node` silently tests old code. The bench needs `bun run build` (release) instead. The compiler CLI the battery / browser harness / dual-eval use is rebuilt by them (`cargo build -p brust-compiler-cli`).
- Never `git add -A` at the repo root; stage files by name. Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Goldens: after an intentional change run `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`, then `git status --short tests/fixtures` and `git diff tests/fixtures` MUST list exactly the files each task names below — any other fixture changing means the predicate is wrong, not the golden. Review every golden diff by eye before staging.
- Measure with `BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x BENCH_LOCK_ID='m3p-f-payload knock2' bun bench/run.ts …` after `cd packages/brust && bun run build` (release addon). Set `BENCH_LOCK_WS=<your Conclave workspace id>` too so the blackboard layer of the host lock (`bench/README.md` "Host lock and ports", `bench/lib/lock.ts`) is taken; the lock file layer is always on. The load-average guard applies (exit 2 when the 1-/5-minute load exceeds the core count): run when the machine is idle. Partial runs (`--apps brust,brust-01x --probes D,I`) still overwrite `bench/RESULTS.{md,json}`: `git checkout -- bench/RESULTS.md bench/RESULTS.json` after each one; only Task 7's full run is kept.
- Byte identity is NOT the bar for pokedex (dead attributes leave it too); the bar is Task 1 Step 6's `snap.sh`: (a) the visible markup (scripts, `x-*` attributes and bare `<span>` wrappers stripped) is identical, (b) the load-bearing directive multiset (hosts `dexFilter_`, `dexCard_`, `themeToggle_`, `heroSearch_`, the `teamBuilder_` island, every `x-for` / `x-props-bind` / `x-on-*` / `x-model` / `x-if`) is identical, (c) bytes go down. The pokedex + hydrate tests and `examples/pokedex` tests stay green with the single assertion edit named in Task 3.
- Gates (all green before each commit that touches code, and in full before READY; mirrors `.github/workflows/ci.yml`): `cargo fmt --all -- --check` · `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` · `cargo test --workspace --exclude bun_react_compiler` (includes `--test fixtures`, `--test dual_eval`, brust-jinja unit tests) · `bun run battery && git diff --exit-code docs/react-coverage.md docs/plans/m1-exit-report.md && bun test scripts/battery` · `bun run browser-test` · `cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts` · `cd examples/pokedex && bun test && bun run typecheck` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` (each server-starting file alone, as CI does) · `bun check -p bench && bun test bench/lib`.
- Do not re-decide: the link rule lives in analysis (`children.rs`), not in lowering — see Architecture for why lowering-only cannot deliver R2's "no x-props when nothing consumes it"; a `RowOnly` link that is dropped leaves a gap in `_pN` numbering (ids are names, never indices; `client.rs:173` emits `const _p{id}` from the member name); projection applies only to a root seeded whole (`SeedNode::Whole`) whose EVERY client read is the plain source of a keyed list; a read the walker cannot classify keeps the full row.

## Review Focus

1. **Dropping a link a behaviour still needs at runtime (silent client break, no diagnostic).** The only new "no link" case is a `Static` child whose props read nothing but loop bindings, outside every row the client can re-create. The reviewer bar: for every page in the repo where the row IS re-creatable the directives must be exactly what they were. Pinned by: the table-driven cases in `tests/children.rs` (`static_child_link_decisions`, Task 2/3: static child in a prop list → no link; same child in a state-sourced list → link; in a prop list whose row has a handler → link; in a nested list under a stateful outer list → link; native child in a prop list → link, as today), the unchanged goldens of `keyed-list-child` (state prop), `use-id-row` (native child), `nested-list`, `reactive-list-child` (new: state-dependent list → `x-for` + `x-data` + `x-props-bind` preserved), the browser cases `keyed-list-child` / `keyed-list` / `table-rows` (`bun run browser-test`), `tests/server/hydrate.chromium.test.ts` (ThemeToggle still mounts on a page whose layout became static) and Task 1 Step 6's load-bearing multiset diff on three pokedex pages.
2. **Projected `x-props` missing a field read through a helper function.** `item_reads` must return `Whole` for a row passed to any call (`fmt(row)`, `take(props.rows, n)`), indexed dynamically (`row[key]`), spread, returned whole to a child (`item={r}`), captured by an opaque body or shadowed by an inner arrow parameter; and a prop read by any client use that is not the plain source of a list (a handler reading `props.rows.length`, a state initializer, a state-dependent slot) disables the projection of that root. Pinned by: `projection.rs` unit tests (table of expressions → `Fields`/`Whole`), `reactive-list-child` goldens (helper → full `rows` in `x-props`, no `client_prop_projections`), `keyed-list-child-job` (row passed whole, but static after F70 — the unit test `row_passed_whole_to_a_child_is_whole` covers the native variant inline), and `tests/lower_template.rs::projected_x_props_drops_unread_row_fields` (Task 5).
3. **Keyed `x-for` losing its key field.** The key expression is a client read (`_kN = (r) => r.id`, `client.rs:170`) that lives on the `For` node, not in `client_uses`; the projection pass must scan it. Pinned by: `projection.rs` unit test `key_field_is_always_kept`, `lower_template.rs::projected_x_props_keeps_the_key` (renders `reactive-list-rows` and asserts `&quot;id&quot;` present, `secret` absent), the dual-eval row-count check (`dual_eval.rs`: painted `x-for` rows == client list length) over every projected fixture, and the browser case `reactive-list-rows` (reorder through `props.set` with projected rows keeps node identity).
4. **Hydration of a react island adjacent to a now-plain static sibling, and a native child whose parent became static.** After F70 `AppLayout` (pokedex) and `TeamPage`/`DexPage` (bench) are static; the island (`TeamBuilder`) is still an `ssr` job target and `ThemeToggle` still an `instances[]` record, so `inject_assets` (`crates/brust-server/src/render.rs:133-170`, `any_dynamic` over chain + job targets + children) injects the runtime and both chunks. Pinned by: `tests/server/pokedex.test.ts` (`/` still lists the runtime + `react-teamBuilder_` chunks; `/type-chart` still none), `tests/server/hydrate.chromium.test.ts` (island hydrates with no console error; theme toggle flips `data-mode`), `packages/brust/test/e2e.test.ts` (loader route: island SSR + react chunk; static route: exactly the layout's two scripts), and the bench `/team?nocache=1` body unchanged at 781 bytes (Task 7).
5. **Battery / report drift and golden drift.** `docs/react-coverage.md` and `docs/plans/m1-exit-report.md` are generated and CI diffs them; `dual_eval.rs::NO_DIRECTIVES` and `scripts/battery/exit.ts::DUAL_EVAL_NO_DIRECTIVES` must list the same fixtures; `BROWSER_CASES` must name the new browser case; goldens must change only where a task says. Pinned by: `bun run battery && git diff --exit-code …` + `bun test scripts/battery` (`exit.test.ts` compares the committed reports with a fresh run and counts browser files), `cargo test -p brust-compiler --test dual_eval` (fails closed on an unpinned sampled fixture with nothing to check), and the per-task `git status --short tests/fixtures` expectations.

## Dispatch table

Lane tier: **standard** implementation (knock2), **complex** review (Mellow) — spec §4 row `m3p-f-payload`. Per-task tiers are for the Coordinator's gate routing only.

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3p-f-payload-1` evidence | routine | implementer | lane created from `m3p` | `crates/brust-compiler/tests/fixtures/payload/{dex,types,team}.before.jinja` + `bytes.before.txt` committed; three new fixtures with BEFORE goldens (`static-list-child` shows `x-data="badge_…"` on every instance); `snap.sh before` saved; `cargo test -p brust-compiler --test fixtures --test dual_eval` green; commit `test(compiler): payload fixtures pin the bench D shape before F70/F71` |
| `m3p-f-payload-2` predicate | standard | implementer | task 1 | `instance_needs_link` + `row_reactive` + `LinkNeed` in `children.rs` with the unit-test table green (`cargo test -p brust-compiler --lib passes::children`); behaviour unchanged (`cargo test -p brust-compiler` green, no golden touched); commit `refactor(compiler): name the child-link decision (instance_needs_link, row_reactive)` |
| `m3p-f-payload-3` wire F70 | standard | implementer | task 2 | goldens changed ONLY for `keyed-list-child-job` and `static-list-child` (listed files); `NO_DIRECTIVES` pins updated in both places; the four TS assertion edits; full gate list green; `snap.sh after-f70` → visible markup identical ×3, load-bearing multiset identical ×3, bytes down; quick bench D/I (brust, brust-01x) pasted; commit `fix(compiler): a static child in a row the client cannot re-create is plain HTML (F70)` |
| `m3p-f-payload-4` projection analysis + filter | standard | implementer | task 3 | `project` filter unit tests green (`cargo test -p brust-jinja`); `projection.rs` unit tests green; `client_prop_projections` serialised only when non-empty (no golden changes yet because nothing emits it: `git status --short tests/fixtures` empty); commit `feat(compiler,jinja): row read-set projection for list props and the project filter (F71)` |
| `m3p-f-payload-5` wire F71 | standard | implementer | task 4 | `host_attrs` emits `| project(…)`; goldens changed ONLY for `keyed-list`, `keyed-list-child`, `nested-list`, `use-id-row`, `reactive-list-rows` (jinja + ir.json); rendered HTML of every sampled fixture unchanged (dual-eval green, `bun run browser-test` green incl. the new case); `lower_template.rs` projection tests green; commit `fix(compiler): list hosts seed only the row fields the client reads (F71)` |
| `m3p-f-payload-6` battery pair + reports | routine | implementer | task 5 | rows `e-static-list-child` (static, 0 jobs) and `e-reactive-list-child` (native, 1 job) observed as expected; `bun run battery` regenerates both reports; `bun test scripts/battery` green; commit `test(battery): static and reactive list-child rows; regenerate coverage and exit reports` |
| `m3p-f-payload-7` gates + measure + READY | routine | implementer | task 6 | full gate list green (paste `test result` lines); full bench run kept in `bench/RESULTS.{md,json}`; D bytes/resp within 10% of brust-01x; I bytes unchanged (781); `snap.sh final` identical to `after-f70` on load-bearing + visible; commit `bench: results after m3p-f-payload (F70+F71)`; READY note |

## File structure

```
crates/brust-compiler/src/analyze/passes/children.rs     LinkNeed, instance_needs_link, row_reactive, body_directive, weak-link bookkeeping, resolve_row_only (+ unit tests)
crates/brust-compiler/src/analyze/passes/captures.rs     handlers and slot uses keep their raw (+scope) so projection can read them
crates/brust-compiler/src/analyze/passes/projection.rs   NEW: item_reads, list_sources, projection pass (+ unit tests)
crates/brust-compiler/src/analyze/passes/mod.rs          `pub mod projection;` + run after captures
crates/brust-compiler/src/ir/mod.rs                      ComponentIR.client_prop_projections: BTreeMap<String, Vec<String>> (serde default / skip empty)
crates/brust-compiler/src/lower/template.rs              host_attrs: a projected whole root prints `(<base>) | project("a", "b.c")`
crates/brust-jinja/src/lib.rs                            filter `project` (+ unit tests)
crates/brust-compiler/tests/children.rs                  static_child_link_decisions (table), row_only_links_keep_their_ids
crates/brust-compiler/tests/lower_template.rs            projected_x_props_drops_unread_row_fields, projected_x_props_keeps_the_key, helper_read_keeps_the_full_row
crates/brust-compiler/tests/dual_eval.rs                 NO_DIRECTIVES += keyed-list-child-job, static-list-child
crates/brust-compiler/tests/fixtures/payload/            NEW evidence: dex.before.jinja, types.before.jinja, team.before.jinja, bytes.before.txt, dex.after.jinja, bytes.after.txt
tests/fixtures/static-list-child/                        NEW: input.tsx, Badge.tsx, sample-props.json + goldens (before in Task 1, after in Task 3)
tests/fixtures/reactive-list-child/                      NEW: input.tsx, Badge.tsx, take.ts, sample-props.json + goldens (unchanged by Tasks 3 and 5 — that is the pin)
tests/fixtures/reactive-list-rows/                       NEW: input.tsx, sample-props.json + goldens (Task 5 changes jinja + ir.json)
tests/fixtures/keyed-list-child-job/                     Task 3: ir.json, jinja, PriceRow.jinja change; client.js + PriceRow.client.js deleted
tests/fixtures/{keyed-list,keyed-list-child,nested-list,use-id-row}/   Task 5: expected.jinja + expected.ir.json (projection)
tests/browser/cases/reactive-list-rows.test.ts           NEW browser case
scripts/battery/rows.ts, scripts/battery/exit.ts         two rows; DUAL_EVAL_NO_DIRECTIVES, BROWSER_CASES
docs/react-coverage.md, docs/plans/m1-exit-report.md     regenerated (Task 6)
packages/brust/test/e2e.test.ts:84,85,113, build-manifest.test.ts:104, fixtures/app.expected-manifest.json   assertion edits (Task 3)
tests/server/pokedex.test.ts:91                          assertion edit (Task 3)
bench/RESULTS.md, bench/RESULTS.json                     regenerated (Task 7 only)
```

---

### Evidence the lane starts from (captured 2026-10-10 on m3p @ 5bd26a9, debug addon, `brust start --workers 2`, `accept-encoding: identity`)

Served bytes: `/dex?nocache=1` **144,226** · `/team?nocache=1` **781** · `/types` **8,512** (the committed `bench/RESULTS.md` D/I/S tables show the same three numbers). Stripping every `x-*` attribute, the `x-props` JSON, the `<brust-row>` wrappers and the three `<script>` tags from the captured `/dex` body leaves **21,756** bytes — the markup itself is already the size of Bun.serve's (21,730) and 0.1.x's (21,860).

`bench/apps/brust/dist/jinja/dexPage_2e07494a.jinja` (2,681 bytes; the `{% else %}` hidden templates omitted here, they are printed only for an empty list):

```jinja
<brust-host x-data="dexPage_2e07494a" x-props='{{ {"rows": rows, "summary": summary} | json_attr }}' style="display:contents"><h1>Pokédex</h1><p x-text="_c1">{{ summary | e }}</p><table><thead>…</thead><tbody>{% for p in rows %}{% set _i1 = loop.index0 %}<tr x-for="p in _l1 by _k1"><td x-text="_c2:p">{{ p["num"] | e }}</td><td x-text="_c3:p">{{ p["displayName"] | e }}</td><td>{% for b in p["badges"] %}{% set _i2 = loop.index0 %}<brust-row style="display:contents" x-for="b in _l2:p by _k2"><span x-data="typeBadge_5f5390d7" x-props='{{ {"color": b["color"], "label": b["label"], "type": b["type"]} | json_attr }}' x-props-bind="_p1:p,b"{% if (b["type"]) | present %} data-type="{{ (b["type"]) | attr_str | e }}"{% endif %} x-bind-data-type="_c1" style="{{ {"background": (b["color"])} | style_css | e }}" x-bind-style="_c2" x-text="_c3">{{ (b["label"]) | e }}</span></brust-row>{% else %}…{% endfor %}</td></tr>{% else %}…{% endfor %}</tbody></table></brust-host>
```

Per served row (151×): `<tr x-for="p in _l1 by _k1">`, `<td x-text="_c2:p">`, `<td x-text="_c3:p">`, and per badge (≈ 1.5 per row): `<brust-row style="display:contents" x-for="b in _l2:p by _k2">` wrapping `<span x-data="typeBadge_5f5390d7" x-props='{"color":"#63bb5b","label":"Grass","type":"grass"}' x-props-bind="_p1:p,b" data-type="grass" x-bind-data-type="_c1" style="background:#63bb5b" x-bind-style="_c2" x-text="_c3">`. The list host: `<brust-host x-data="dexPage_2e07494a" x-props='…48,190 characters…'>` — all 151 rows with `badges[].{color,label,type}`, `displayName`, `id`, `name`, `num` (`name` is never rendered). Plus three script tags (`runtime-…`, `dexPage_…`, `typeBadge_…`). `typesPage_2574fd14.jinja` has the same shape on `<li x-for="b in _l1 by _k1">` (18 instances); `teamPage_5783433f.jinja` is `<brust-host style="display:contents"><h1>Team</h1><p>Pick up to 6.</p><brust-island data-id="counter_4a7ef039" x-props='{{ {"start": start, "label": label} | json_attr }}'>{{ _ssr_counter_4a7ef039 | safe }}</brust-island></brust-host>` — no host attributes (static parent of an island): I has nothing to remove.

The chunk `dexPage_2e07494a-….js` is `_c1 = computed(() => props().summary)`, `_l1 = computed(() => props().rows)`, `_k1 = e => e.id`, `_c2 = e => e.num`, `_c3 = e => e.displayName`, `_l2 = e => e.badges`, `_k2 = e => e.type`, `_p1 = (e, t) => ({ type: t.type, label: t.label, color: t.color })` — nothing on this page can ever change `rows` (`DexPage` has no state, no handler, no effect; its only "reactivity" is the link to `TypeBadge`).

**Why the page is native at all** — `crates/brust-compiler/src/analyze/passes/children.rs:433-474` (current):

```rust
                // Native / static child: link when any prop changes after first
                // paint or is a function (§7.4).
                let needs_link = props.iter().any(|(_, v)| {
                    let d = self.deps_of(v);
                    matches!(v, Expr::ClientOnly { .. })
                        || !d.state.is_empty()
                        || !d.loop_bindings.is_empty()
                });
                if needs_link {
                    // The parent chunk rebuilds the row's `_pN` from the list: it reads the source.
                    self.st.client_uses.extend(self.list_uses.iter().cloned());
                    let id = self.links.len() as u32 + 1;
                    for (_, v) in props.iter() {
                        // The parent chunk computes `_pN`: every prop is a client read.
                        let deps = self.deps_of(v);
                        let raw = match v { … };
                        self.st.client_uses.push(super::ClientUse { loc: *loc, deps, what: "a prop of a linked child", raw: raw.map(|r| (r, self.loop_scope.clone())) });
                    }
                    let link_props = props.iter().map(|(k, v)| (k.clone(), self.link_prop(v))).collect();
                    self.links.push(ChildLink { id, child: child_id, props_member: format!("_p{id}"), item_scoped: self.loop_scope.clone(), props: link_props });
                    *link = Some(id);
                }
```

`type={b.type}` reads the loop binding `b` ⇒ link ⇒ `tier.rs:66-76` (`… && ir.child_links.is_empty() && !has_state_dependent(ir)` ⇒ `Static`, else `Native`) makes `DexPage` native ⇒ `template.rs:851` `directive_row = self.native && (src reads state || body.iter().any(needs_directives))` with `needs_directives` (`template.rs:1381-1405`) returning `link.is_some()` for a `Component` ⇒ `x-for` rows ⇒ `template.rs:1149-1181` builds `bind` from the link and sets `p.native = !matches!(child_ir.tier, Tier::Static) || bind.is_some()` ⇒ the instance prints `x-data` / `x-props` / `x-props-bind` and, inside, `reactive()` (`template.rs:303-321`, `prop_read` and `loop_read` need `self.native`) turns every prop read into `x-text` / `x-bind-*` ⇒ `host_attrs` (`template.rs:532-607`) seeds `client_props ∪ prop_seen` ⇒ `{"rows": rows, "summary": summary}` ⇒ `lower/mod.rs:134` `if matches!(ir.tier, Tier::Static) && !(ctx.linked)(&ir.id) { no chunk }` gives `TypeBadge` a chunk because `pipeline.rs:34-38` collects every `child_links[].child` into `linked_ids` ⇒ `manifest.ts:270-289` `linkNativeChunks` adds the F66 static entry ⇒ the server injects three scripts.

**Every runtime consumer of the attributes (packages/runtime-dom/src), so the plan can say what is load-bearing where:**

| attribute | read by | when it matters |
|---|---|---|
| `x-data` | `mount.ts:21-23` (`whenBehavior(name)` → `new Instance`), `directives/index.ts:10,19,26-27` (a nested host is bound by its own instance; skipped by the parent's walk), `directives/for.ts:66` (a row that is itself a host is bound by its own instance), `instance.ts:53` `nearestInstance` | the element has a behaviour chunk registered under that name — a static child has one only when linked |
| `x-props` | `mount.ts:12-17` `readProps` → `Instance.props` signal (the chunk reads `props()`); `island.ts:44-49` for `brust-island`; `client.rs:60-63` reads `_idN` from it once | the chunk's members read `props()`; `_idN` for `useId`; an island's hydrate props |
| `x-props-bind` | `props-bind.ts:12-30` (`bindPropsFromParent`: resolve the parent member `_pN` with the row scope, write the child's `props` signal in an effect) | a parent that can change the props after first paint: state / function props, or a row the parent can re-create |
| `x-for` | `directives/for.ts:14-24` (siblings with the same attribute are the rows; the first is the clone template; `hidden` = zero-row template), `:60-66` rows get `__scope`; adopted on the first run, cloned (`template.cloneNode`) when the list grows | the source member `_lN` can change: state-sourced list, or a props-sourced list whose row carries a directive (so `_lN` exists) |
| `x-text`, `x-bind-*`, `x-on-*`, `x-if`, `x-model`, `x-ref`, `x-show` | `directives/index.ts:28-33` binders, with the row scope (`value.ts` `resolve`: members + `scope[b]` bindings) | inside a host, on first paint (tripwire `common.ts mismatch` before `booted`) and on every change; in a cloned row they are the ONLY thing that fills the blank template |
| harness (not runtime) | `crates/brust-compiler/tests/harness/eval.ts` reads `x-props` / `x-props-bind` / `x-for` to dual-evaluate | the fixtures' gate |

A `<span data-type="grass" style="background:#63bb5b">Grass</span>` under a static page has no reader for any of its five `x-*` attributes: no behaviour will ever mount (`whenBehavior` waits forever for a chunk the page does not even load once the chunk is gone), no `_p1` exists to bind, no `_l1` can change.

---

### Task 1: Evidence — lane, captured templates, the three fixtures with BEFORE goldens, pokedex snapshot script

**Files:**
- Create: `crates/brust-compiler/tests/fixtures/payload/{dex.before.jinja,types.before.jinja,team.before.jinja,bytes.before.txt}`
- Create: `tests/fixtures/static-list-child/{input.tsx,Badge.tsx,sample-props.json}`, `tests/fixtures/reactive-list-child/{input.tsx,Badge.tsx,take.ts,sample-props.json}`, `tests/fixtures/reactive-list-rows/{input.tsx,sample-props.json}` + their goldens (generated)
- Read first: `tests/fixtures/README.md` (golden rules), `crates/brust-compiler/tests/dual_eval.rs:24-48` (pins), `bench/apps/brust/pages/DexPage.tsx`, `bench/apps/brust/components/TypeBadge.tsx`

**Interfaces:** none (evidence + pins). Produces the BEFORE state of the three fixtures whose golden diffs in Tasks 3 and 5 ARE the evidence of the change.

- [ ] **Step 1: Create the lane and the scratch dir**
```bash
cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-f-payload -b lane/m3p-f-payload m3p
cd /Users/detoro/code/brust-lane-m3p-f-payload && git log --oneline -1        # 5bd26a9 or a later m3p commit
bun install --frozen-lockfile
export OUT=<your scratchpad directory>/m3p-f && mkdir -p $OUT
export BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x
ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)
cd packages/brust && bun run build:debug && cd ../..                            # debug addon for the CLI
```

- [ ] **Step 2: Build the bench app and capture its templates and served bytes**
```bash
cd bench/apps/brust && ../../../packages/brust/bin/brust build routes.tsx && cd ../../..
mkdir -p crates/brust-compiler/tests/fixtures/payload
cp bench/apps/brust/dist/jinja/dexPage_*.jinja   crates/brust-compiler/tests/fixtures/payload/dex.before.jinja
cp bench/apps/brust/dist/jinja/typesPage_*.jinja crates/brust-compiler/tests/fixtures/payload/types.before.jinja
cp bench/apps/brust/dist/jinja/teamPage_*.jinja  crates/brust-compiler/tests/fixtures/payload/team.before.jinja
( cd bench/apps/brust && BRUST_PORT= ../../../packages/brust/bin/brust start --port 38391 --workers 2 >$OUT/srv-bench.log 2>&1 & echo $! >$OUT/srv.pid )
for i in $(seq 1 100); do grep -q '\[brust\] ready' $OUT/srv-bench.log && break; sleep 0.2; done
for p in "/dex?nocache=1" "/team?nocache=1" "/types"; do curl -s -H 'accept-encoding: identity' -o /dev/null -w "$p %{size_download}\n" "http://127.0.0.1:38391$p"; done | tee crates/brust-compiler/tests/fixtures/payload/bytes.before.txt
kill $(cat $OUT/srv.pid)
```
Expected `bytes.before.txt`: `/dex?nocache=1 144226`, `/team?nocache=1 781`, `/types 8512` (a different addon/worker count does not change bytes). `grep -c 'x-data="typeBadge_' crates/brust-compiler/tests/fixtures/payload/dex.before.jinja` → `1` line containing 4 occurrences (`grep -o … | wc -l` → 4: visible + hidden × 2 loops). A `tests/fixtures/payload/` directory under `crates/brust-compiler/tests` has no `main.rs`, so cargo does not treat it as a test target (like `harness/`).

- [ ] **Step 3: The static list page fixture (the bench D shape).** `tests/fixtures/static-list-child/input.tsx`:
```tsx
import Badge from './Badge'
type Badge = { type: string; label: string; color: string }
type Row = { id: number; name: string; displayName: string; num: string; badges: Badge[] }
// The bench D page: a static child fed by loader-precomputed values inside a nested list of a page
// with no state. Nothing on the client can ever change `rows` (ledger F70).
export default function Dex(props: { rows: Row[]; summary: string }) {
  return (
    <section>
      <p>{props.summary}</p>
      <table><tbody>
        {props.rows.map((p) => (
          <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.badges.map((b) => <Badge key={b.type} type={b.type} label={b.label} color={b.color} />)}</td></tr>
        ))}
      </tbody></table>
    </section>
  )
}
```
`tests/fixtures/static-list-child/Badge.tsx` (verbatim `bench/apps/brust/components/TypeBadge.tsx`, renamed):
```tsx
export default function Badge(props: { type: string; label: string; color: string }) {
  return <span data-type={props.type} style={{ background: props.color }}>{props.label}</span>
}
```
`tests/fixtures/static-list-child/sample-props.json` (`name` is never rendered — it is the F71 witness later):
```json
{ "rows": [
  { "id": 1, "name": "bulbasaur", "displayName": "Bulbasaur", "num": "#0001", "badges": [{ "type": "grass", "label": "Grass", "color": "#63bb5b" }, { "type": "poison", "label": "Poison", "color": "#ab6ac8" }] },
  { "id": 4, "name": "charmander", "displayName": "Charmander", "num": "#0004", "badges": [{ "type": "fire", "label": "Fire", "color": "#ff9d55" }] }
], "summary": "2 Pokémon" }
```

- [ ] **Step 4: The reactive list page fixture (x-* must stay).** `tests/fixtures/reactive-list-child/input.tsx`:
```tsx
import { useState } from 'react'
import Badge from './Badge'
import { take } from './take'
type Badge = { type: string; label: string; color: string }
type Row = { id: number; num: string; badges: Badge[] }
// A state-dependent list (module helper, like the pokedex DexFilter): the client re-creates rows,
// so the static child in the row keeps its link, and `rows` is read whole by the helper, so its
// x-props seed stays the full list (ledger F71 fallback).
export default function Dex(props: { rows: Row[] }) {
  const [n, setN] = useState(1)
  const shown = take(props.rows, n)
  return (
    <section>
      <button onClick={() => setN(n + 1)}>more</button>
      <ul>{shown.map((p) => <li key={p.id}>{p.num}{p.badges.map((b) => <Badge key={b.type} type={b.type} label={b.label} color={b.color} />)}</li>)}</ul>
    </section>
  )
}
```
`tests/fixtures/reactive-list-child/take.ts`: `export const take = <T,>(rows: T[], n: number): T[] => rows.slice(0, n)` — `Badge.tsx` as in Step 3 (a copy; fixtures resolve siblings only). `sample-props.json`: the same two rows as Step 3 without `name` and `displayName`.

- [ ] **Step 5: The projection fixture (native parent, prop list with a row handler).** `tests/fixtures/reactive-list-rows/input.tsx`:
```tsx
import { useState } from 'react'
// A props-sourced keyed list whose rows carry a handler: the row can be re-bound when the props
// change, so the host seeds `rows` — projected to the fields the client reads (id, name), never
// `secret` (ledger F71).
export default function Picker(props: { rows: { id: string; name: string; secret: string }[] }) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <ul>
      {props.rows.map((r) => (
        <li key={r.id} className={r.id === picked ? 'on' : ''} onClick={() => setPicked(r.id)}>{r.name}</li>
      ))}
    </ul>
  )
}
```
`sample-props.json`: `{ "rows": [{ "id": "a", "name": "Ada", "secret": "s3cr3t-a" }, { "id": "b", "name": "Bob", "secret": "s3cr3t-b" }] }`.

- [ ] **Step 6: Generate the BEFORE goldens and check what they say**
```bash
BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures 2>&1 | tail -3
git status --short tests/fixtures | sort
```
Expected: only the three new directories, each with `expected.hir.json`, `expected.ir.json`, `expected.diag.txt`, `expected.jinja`, `expected.client.js`, and `expected.Badge.jinja` + `expected.Badge.client.js` for the two with a child; `reactive-list-child` also `expected.server.ts`. Inspect:
```bash
grep -o 'x-data="badge_[0-9a-f]*"' tests/fixtures/static-list-child/expected.jinja | wc -l     # 4 (today: linked ⇒ host per instance, visible + hidden × 2)
python3 -c "import json;d=json.load(open('tests/fixtures/static-list-child/expected.ir.json'));print(d['tier'],len(d['child_links']),d['client_props'])"   # Native 1 ['rows', 'summary']
python3 -c "import json;d=json.load(open('tests/fixtures/reactive-list-child/expected.ir.json'));print(d['tier'],len(d['child_links']),d['client_props'],[j['kind'] for j in d['jobs']])"   # Native 1 ['rows'] [{'Precompute': …}] (or 'Precompute')
grep -c "x-props='{{ {\"rows\": rows} | json_attr }}'" tests/fixtures/reactive-list-rows/expected.jinja   # 1
cargo test -p brust-compiler --test dual_eval 2>&1 | grep -E 'test result|checked'
```
Expected: dual-eval green — all three fixtures carry directives today, so none needs a `NO_DIRECTIVES` pin yet (the test prints the per-fixture check counts; each new one is > 0).

- [ ] **Step 7: The pokedex snapshot script.** Save as `$OUT/snap.sh` (reused in Tasks 3, 5, 7):
```bash
#!/bin/bash
# usage: snap.sh <label> — serves examples/pokedex on :38212, saves bodies + three views per page.
set -e; L=$1; ROOT=$(git rev-parse --show-toplevel); OUT=${OUT:?}
( cd $ROOT/examples/pokedex && ../../packages/brust/bin/brust build routes.tsx >/dev/null && \
  BRUST_PORT= ../../packages/brust/bin/brust start --port 38212 --workers 2 >$OUT/srv-$L.log 2>&1 & echo $! > $OUT/srv.pid )
for i in $(seq 1 100); do grep -q '\[brust\] ready' $OUT/srv-$L.log && break; sleep 0.2; done
for p in / /pokedex /pokemon/pikachu; do
  n=${p//\//_}; b=$OUT/body-$L$n
  curl -s -H 'accept-encoding: identity' "http://127.0.0.1:38212$p?nocache=1" > $b
  # (a) visible markup: no scripts, no x-* attributes, no bare <span> wrappers left by a stripped x-text
  sed -E "s#<script[^>]*></script>##g; s/ x-props='[^']*'//g; s/ x-[a-z-]+=\"[^\"]*\"//g; s#<brust-row style=\"display:contents\">##g; s#</brust-row>##g; s#<span>##g; s#</span>##g; s/-[0-9a-f]{10}\.js/-HASH.js/g" $b > $b.visible
  # (b) load-bearing directives: hosts with a behaviour, the island, and every structural/handler directive
  { grep -oE 'x-data="(dexFilter|dexCard|themeToggle|heroSearch)_[0-9a-f]+"' $b; grep -oE '<brust-island data-id="teamBuilder_[0-9a-f]+" x-props=.[^>]*>' $b | sed -E 's/&quot;/"/g'; grep -oE ' x-(for|props-bind|on-[a-z]+|model|if)="[^"]*"' $b; } | sort | uniq -c > $b.loadbearing
  # (c) counts of the attribute kinds that MAY drop (dead ones)
  { for a in x-data x-props x-props-bind x-text x-bind- x-for x-on- x-if x-model; do printf '%s %s\n' $a "$(grep -o " $a" $b | wc -l | tr -d ' ')"; done; grep -o '<script[^>]*>' $b | wc -l | sed 's/^ */scripts /'; } > $b.counts
done
kill $(cat $OUT/srv.pid); sleep 0.5
wc -c $OUT/body-$L_ $OUT/body-$L_pokedex $OUT/body-$L_pokemon_pikachu | head -3
```
```bash
chmod +x $OUT/snap.sh && $OUT/snap.sh before && cat $OUT/body-before_pokemon_pikachu.counts
```
Expected: three bodies; `/pokemon/pikachu` counts show `x-data` ≥ 4 (appLayout, themeToggle, detailPage, breadcrumb?/typeBadge×n), `x-text` in the dozens, `scripts 5` (runtime, appLayout, typeBadge, themeToggle, react + react-teamBuilder — count what you see and keep it). Paste the three `.counts` files in the task note under **before**.

- [ ] **Step 8: Commit**
```bash
git add crates/brust-compiler/tests/fixtures/payload tests/fixtures/static-list-child tests/fixtures/reactive-list-child tests/fixtures/reactive-list-rows
git commit -m "test(compiler): payload fixtures pin the bench D shape before F70/F71

static-list-child is bench probe D (a static child with loop-only props in a
page without state): today it is Native, linked, and every instance carries
x-data/x-props/x-props-bind/x-bind-*/x-text. reactive-list-child (state-
dependent list through a helper) and reactive-list-rows (prop list with a row
handler) pin what must stay. payload/*.before.jinja and bytes.before.txt are
the bench app's templates and served bytes before the change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git show --stat HEAD | tail -25
```

---

### Task 2: The predicate — `LinkNeed`, `instance_needs_link`, `row_reactive` (named, unit-tested, not yet wired)

**Files:**
- Modify: `crates/brust-compiler/src/analyze/passes/children.rs` (new items + `#[cfg(test)] mod tests`; the walker is untouched in this task)

**Interfaces:**
- Produces (in `children.rs`, `pub(crate)`):
```rust
/// Why a native/static child instance gets a runtime link (`x-props-bind`, spec §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkNeed {
    /// Every prop is a constant or a plain prop path: the instance paints once, no link.
    None,
    /// A prop is a function or reads state, or the child has a behaviour of its own and
    /// reads the row: linked wherever it sits (unchanged rule).
    Always,
    /// A static child reads only the row's loop bindings: linked only inside a row the
    /// client can re-create, plain HTML everywhere else (ledger F70).
    RowOnly,
}
/// The link decision for one `<Child …/>`: `props` = (is a function, what it reads) per prop.
pub fn instance_needs_link(tier: &Tier, props: impl IntoIterator<Item = (bool, Deps)>) -> LinkNeed
```
and on the `Walker`:
```rust
/// Whether the client can re-create the rows of this list: an enclosing list can, its source
/// changes with state, or its body carries a directive of its own.
fn row_reactive(&self, source: &Expr, body: &[Node], enclosing: bool) -> bool
/// `lower::template::needs_directives` without the row-only links this pass decides.
fn body_directive(&self, n: &Node) -> bool
fn reads_state(&self, e: &Expr) -> bool
```

The case table the predicate implements (R1):

| child tier | what the props read | enclosing row re-creatable? | link | instance prints |
|---|---|---|---|---|
| Static | nothing / literals / plain prop paths | — | `None` (as today) | plain HTML |
| Static | only loop bindings | no | **`RowOnly` → dropped (new)** | plain HTML |
| Static | only loop bindings | yes | `RowOnly` → kept (as today) | `x-data` + `x-props` + `x-props-bind:…` + `x-text`/`x-bind-*` |
| Static | state (incl. a state-dependent slot) or a function | — | `Always` (as today) | directives |
| Native | loop bindings / state / function | — | `Always` (as today) | directives |
| Native | nothing / plain prop paths | — | `None` (as today) | its own host (`x-data` + `x-props`), no bind |
| React | — | — | never a link (island) | `<brust-island>` |
| Pending (cycle) | any | — | treated as Native | — (it renders as an island anyway) |

"Re-creatable" (`row_reactive`): an enclosing list is; or the source reads state (a `Server` expr with state deps or a `Precomputed { state_dependent: true }` slot); or the body has an element with an event/ref attribute, a slot/attribute/condition reading state, a nested list that is re-creatable, a component with an `Always` link, or slot children with any of these — exactly the arms of `template.rs:1381-1405` `needs_directives` plus the `directive_row` source test at `template.rs:851-855`, minus `link.is_some()` for `RowOnly` links.

- [ ] **Step 1: Add the items** at the end of `children.rs` (before `enum PlainPath`), importing `super::deps::Deps` (already imported) and `crate::ir::Attr`:
```rust
/// Why a native/static child instance gets a runtime link (`x-props-bind`, spec §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkNeed {
    /// Every prop is a constant or a plain prop path: the instance paints once, no link.
    None,
    /// A prop is a function or reads state, or the child has a behaviour of its own and
    /// reads the row: linked wherever it sits.
    Always,
    /// A static child reads only the row's loop bindings: linked only inside a row the
    /// client can re-create, plain HTML everywhere else (ledger F70).
    RowOnly,
}

/// The link decision for one `<Child …/>` from the child's tier and what each prop reads
/// (`function` = the prop is `Expr::ClientOnly`).
pub fn instance_needs_link(tier: &Tier, props: impl IntoIterator<Item = (bool, Deps)>) -> LinkNeed {
    let mut loop_only = false;
    for (function, d) in props {
        if function || !d.state.is_empty() {
            return LinkNeed::Always;
        }
        loop_only |= !d.loop_bindings.is_empty();
    }
    match (loop_only, tier) {
        (false, _) => LinkNeed::None,
        (true, Tier::Static) => LinkNeed::RowOnly,
        (true, _) => LinkNeed::Always,
    }
}
```
and in `impl Walker<'_, '_>`:
```rust
    /// Mirrors `lower::template::expr_reactive`.
    fn reads_state(&self, e: &Expr) -> bool {
        match e {
            Expr::Precomputed { state_dependent, .. } => *state_dependent,
            other => !self.deps_of(other).state.is_empty(),
        }
    }

    /// Whether the client can re-create the rows of this list: an enclosing list can, its
    /// source changes with state, or its body carries a directive of its own.
    fn row_reactive(&self, source: &Expr, body: &[Node], enclosing: bool) -> bool {
        enclosing || self.reads_state(source) || body.iter().any(|n| self.body_directive(n))
    }

    /// `lower::template::needs_directives` without the row-only links this pass decides:
    /// a component counts only through an `Always` link (or its slot children).
    fn body_directive(&self, n: &Node) -> bool {
        match n {
            Node::Element { attrs, children, .. } => {
                attrs.iter().any(|a| match a {
                    Attr::Event { .. } | Attr::Ref { .. } => true,
                    Attr::Dynamic { value, .. } => self.reads_state(value),
                    _ => false,
                }) || children.iter().any(|c| self.body_directive(c))
            }
            Node::Slot(e) => self.reads_state(e),
            Node::If { cond, then, else_ } => {
                self.reads_state(cond) || then.iter().chain(else_).any(|c| self.body_directive(c))
            }
            Node::For { source, body, .. } => {
                self.reads_state(source) || body.iter().any(|c| self.body_directive(c))
            }
            Node::Component { link, children, .. } => {
                link.is_some_and(|id| !self.row_only.contains_key(&id))
                    || children.iter().any(|c| self.body_directive(c))
            }
            Node::Fragment(cs) => cs.iter().any(|c| self.body_directive(c)),
            Node::Text(_) | Node::Outlet => false,
        }
    }
```
Add the field the last arm needs to `Walker` (unused until Task 3 — `#[allow(dead_code)]` is NOT acceptable under `-D warnings`; instead give it its Task 3 use now by initialising it in `children()` and reading it in `body_directive`, which is itself only called by `row_reactive`; call `row_reactive` from the unit tests):
```rust
    /// `RowOnly` links by id with the client reads they imply, resolved after the walk.
    row_only: HashMap<u32, Vec<super::ClientUse>>,
```
If clippy still reports anything unused after Step 2, wire Step 2 of Task 3 (`resolve_row_only`) in this task — the split is a convenience, not a rule.

- [ ] **Step 2: Unit tests** (`#[cfg(test)] mod tests` at the bottom of `children.rs`; `Deps` is `Default` and has public `BTreeSet` fields):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn d(state: &[&str], loops: &[&str]) -> Deps {
        let mut d = Deps::default();
        d.state.extend(state.iter().map(|s| s.to_string()));
        d.loop_bindings.extend(loops.iter().map(|s| s.to_string()));
        d
    }
    #[test]
    fn link_decisions() {
        let s = Tier::Static;
        let n = Tier::Native;
        for (tier, props, want) in [
            (&s, vec![], LinkNeed::None),
            (&s, vec![(false, d(&[], &[]))], LinkNeed::None),               // literal / plain prop path
            (&s, vec![(false, d(&[], &["b"]))], LinkNeed::RowOnly),          // bench TypeBadge
            (&s, vec![(false, d(&[], &["b"])), (false, d(&["q"], &[]))], LinkNeed::Always),
            (&s, vec![(true, d(&[], &[]))], LinkNeed::Always),               // function prop
            (&s, vec![(false, d(&["selected"], &["t"]))], LinkNeed::Always), // keyed-list-child Row
            (&n, vec![(false, d(&[], &["it"]))], LinkNeed::Always),          // native child in a row (as today)
            (&n, vec![(false, d(&[], &[]))], LinkNeed::None),
            (&Tier::Pending, vec![(false, d(&[], &["x"]))], LinkNeed::Always),
        ] {
            assert_eq!(instance_needs_link(tier, props.clone()), want, "{tier:?} {props:?}");
        }
    }
}
```
`row_reactive` / `body_directive` need a `Walker` (a `PassState` + `PassCtx`); test them through the integration table in Task 3 Step 4 instead (`tests/children.rs` `analyze()` builds the real walker). If the dead-code lint fires for `row_reactive` before Task 3, add the `resolve_row_only` call of Task 3 Step 2 now (see Step 1's note).

- [ ] **Step 3: Gates and commit**
```bash
cargo fmt --all && cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test -p brust-compiler --lib passes::children 2>&1 | grep -E 'test result|link_decisions'
cargo test -p brust-compiler 2>&1 | grep -E '^test result' | sort | uniq -c       # all ok, no golden touched
git status --short tests/fixtures                                                   # empty
git add crates/brust-compiler/src/analyze/passes/children.rs
git commit -m "refactor(compiler): name the child-link decision (instance_needs_link, row_reactive)

LinkNeed::{None, Always, RowOnly} with a table test; row_reactive mirrors the
template backend's needs_directives minus the row-only links. Not wired yet:
behaviour and goldens unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire F70 — record `RowOnly` links during the walk, resolve them after it; goldens, pins, measure

**Files:**
- Modify: `crates/brust-compiler/src/analyze/passes/children.rs` (`children()`, `Walker`, `component()`), `crates/brust-compiler/tests/children.rs`, `crates/brust-compiler/tests/dual_eval.rs:40-45`, `scripts/battery/exit.ts:22`, `packages/brust/test/e2e.test.ts:84,85,113`, `packages/brust/test/build-manifest.test.ts:104`, `packages/brust/test/fixtures/app.expected-manifest.json`, `tests/server/pokedex.test.ts:91`
- Goldens (regenerated): `tests/fixtures/keyed-list-child-job/{expected.ir.json,expected.jinja,expected.PriceRow.jinja}` (changed), `expected.client.js` + `expected.PriceRow.client.js` (deleted by the runner), `tests/fixtures/static-list-child/{expected.ir.json,expected.jinja,expected.Badge.jinja}` (changed), `expected.client.js` + `expected.Badge.client.js` (deleted). Nothing else.
- Read first: `crates/brust-compiler/src/lower/template.rs:1149-1181` (how `bind` is derived from `link` — unchanged, it just sees `None` now), `lower/mod.rs:128-137`, `pipeline.rs:30-38`

**Interfaces:**
- Consumes: Task 2's items. Produces: `Walker::resolve_row_only(&mut self, nodes: &mut [Node], reactive: bool)`.

- [ ] **Step 1: Replace the link block in `component()`** (`children.rs:433-474`, quoted in the Evidence section) with:
```rust
                // Native / static child (§7.4, F70): see `instance_needs_link`.
                let need = instance_needs_link(
                    &child.tier,
                    props.iter().map(|(_, v)| (matches!(v, Expr::ClientOnly { .. }), self.deps_of(v))),
                );
                if need != LinkNeed::None {
                    // The parent chunk rebuilds the row's `_pN` from the list: it reads the source,
                    // and every prop is a client read. For a `RowOnly` link these reads are
                    // committed only if the link survives `resolve_row_only`.
                    let mut uses: Vec<super::ClientUse> = self.list_uses.clone();
                    let id = self.links.len() as u32 + 1;
                    for (_, v) in props.iter() {
                        let deps = self.deps_of(v);
                        let raw = match v {
                            Expr::Server(ServerExpr(r)) => Some(r.clone()),
                            Expr::Precomputed { slot, .. } => {
                                self.st.slots.get(slot).map(|i| i.raw.clone())
                            }
                            _ => None,
                        };
                        uses.push(super::ClientUse {
                            loc: *loc,
                            deps,
                            what: "a prop of a linked child",
                            raw: raw.map(|r| (r, self.loop_scope.clone())),
                        });
                    }
                    let link_props = props
                        .iter()
                        .map(|(k, v)| (k.clone(), self.link_prop(v)))
                        .collect();
                    self.links.push(ChildLink {
                        id,
                        child: child_id,
                        props_member: format!("_p{id}"),
                        item_scoped: self.loop_scope.clone(),
                        props: link_props,
                    });
                    *link = Some(id);
                    match need {
                        LinkNeed::Always => self.st.client_uses.extend(uses),
                        LinkNeed::RowOnly => {
                            self.row_only.insert(id, uses);
                        }
                        LinkNeed::None => unreachable!(),
                    }
                }
```
(the old code pushed each prop's `ClientUse` straight into `st.client_uses`; the only difference for `Always` is the ORDER of `client_uses` — `captures.rs:155-164` folds them into `BTreeSet`s, so order is observable only in which use a `server-only-in-client` message names; acceptable.)

- [ ] **Step 2: The resolver.** Add to `impl Walker`:
```rust
    /// Second pass (ledger F70): a `RowOnly` link survives only inside a row the client can
    /// re-create; elsewhere the instance is plain HTML, so the link, its `_pN` member and the
    /// client reads it implied are dropped. Surviving ids keep their numbers (`_pN` is a
    /// name, not an index: a dropped link leaves a gap).
    fn resolve_row_only(&mut self, nodes: &mut [Node], reactive: bool) {
        for n in nodes {
            match n {
                Node::For { source, body, .. } => {
                    let r = self.row_reactive(source, body, reactive);
                    self.resolve_row_only(body, r);
                }
                Node::Component { link, children, .. } => {
                    if let Some(id) = *link
                        && let Some(uses) = self.row_only.remove(&id)
                    {
                        if reactive {
                            self.st.client_uses.extend(uses);
                        } else {
                            *link = None;
                            self.links.retain(|l| l.id != id);
                        }
                    }
                    self.resolve_row_only(children, reactive);
                }
                Node::Element { children, .. } | Node::Fragment(children) => {
                    self.resolve_row_only(children, reactive)
                }
                Node::If { then, else_, .. } => {
                    self.resolve_row_only(then, reactive);
                    self.resolve_row_only(else_, reactive);
                }
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
    }
```
and in `children()` (`children.rs:17-43`), after `w.node(&mut template);`:
```rust
    w.resolve_row_only(std::slice::from_mut(&mut template), false);
    debug_assert!(w.row_only.is_empty(), "every RowOnly link is visited by resolve_row_only");
```
Initialise `row_only: HashMap::new()` in the `Walker { … }` literal. Note the order inside `For`: the decision for the body is made from the body BEFORE descending (`row_only` still holds its candidates, so `body_directive` sees them as non-directive), then the recursion keeps/drops them. A kept link only happens when `reactive` is already true, so a kept candidate never turns a later decision around.

- [ ] **Step 3: Build, run the compiler tests, regenerate exactly the two fixtures**
```bash
cargo fmt --all && cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test -p brust-compiler --test fixtures 2>&1 | grep -E 'mismatch in|stale|missing' | sed 's/--- expected.*//' | sort -u
```
Expected failures name ONLY `keyed-list-child-job/*` and `static-list-child/*`. If any other case appears, STOP: the predicate or the resolver is wrong (compare the case with the R1 table) — do not update that golden.
```bash
BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures 2>&1 | tail -2
git status --short tests/fixtures | sort
```
Expected (exactly):
```
 D tests/fixtures/keyed-list-child-job/expected.PriceRow.client.js
 M tests/fixtures/keyed-list-child-job/expected.PriceRow.jinja
 D tests/fixtures/keyed-list-child-job/expected.client.js
 M tests/fixtures/keyed-list-child-job/expected.ir.json
 M tests/fixtures/keyed-list-child-job/expected.jinja
 D tests/fixtures/static-list-child/expected.Badge.client.js
 M tests/fixtures/static-list-child/expected.Badge.jinja
 D tests/fixtures/static-list-child/expected.client.js
 M tests/fixtures/static-list-child/expected.ir.json
 M tests/fixtures/static-list-child/expected.jinja
```
Read the diffs. `keyed-list-child-job/expected.jinja` must now be:
```jinja
{# brust v2 · input_7833a2e1 · do not edit #}
<ul>{% for it in items %}{% set _i1 = loop.index0 %}<li>{{ __priceRow_845bcd56_1[_i1]["_s1"] | e }}</li>{% endfor %}</ul>
```
(no `x-data`, no `x-props`, no `<brust-row>`, no `x-for`, no hidden template; the per-row job slot `__priceRow_…_1[_i1]` is untouched — instances are independent of links, `children.rs:421-433`). `expected.ir.json`: `"tier": "Static"`, `"child_links": []`, `"client_props": []`, `instances` unchanged. `static-list-child/expected.jinja`: `<section><p>{{ summary | e }}</p><table><tbody>{% for p in rows %}…<tr><td>{{ p["num"] | e }}</td><td>{{ p["displayName"] | e }}</td><td>{% for b in p["badges"] %}…<span{% if (b["type"]) | present %} data-type="…"{% endif %} style="{{ {"background": (b["color"])} | style_css | e }}">{{ (b["label"]) | e }}</span>{% endfor %}</td></tr>{% endfor %}</tbody></table></section>` with `grep -c 'x-' … → 0`. `reactive-list-child` and `reactive-list-rows` are NOT in the list (their rows are re-creatable: state-dependent source / handler in the row) — that is Review Focus 1's pin.

- [ ] **Step 4: Integration table in `crates/brust-compiler/tests/children.rs`** (uses the file's `analyze(src)` helper — change its path argument to a parameter so a static sibling resolves: add `fn analyze_at(path: &str, src: &str) -> ComponentIR` with the same body and `analyze_source(path, …)`; `tests/fixtures/static-list-child/Badge.tsx` is the static child, `tests/fixtures/parent-counter/Counter.tsx` the native one):
```rust
/// F70: a static child reading only the row is linked only where the client can re-create the row.
#[test]
fn static_child_link_decisions() {
    const S: &str = "import { useState } from 'react'\nimport Badge from './Badge'\n";
    for (name, src, links, tier) in [
        ("prop list, no state", "export default function P({ rows }: any) { return <ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }", 0, Tier::Static),
        ("state-sourced list", "export default function P() { const [rows, setRows] = useState([] as any[]); return <ul onClick={() => setRows([])}>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }", 1, Tier::Native),
        ("prop list, handler in the row", "export default function P({ rows }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id} onClick={() => setK(r.id)}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }", 1, Tier::Native),
        ("prop list, state elsewhere only", "export default function P({ rows }: any) { const [k, setK] = useState(0); return <div><button onClick={() => setK(k + 1)}>{k}</button><ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul></div> }", 0, Tier::Native),
        ("nested prop list under a stateful outer list", "export default function P({ rows }: any) { const [n, setN] = useState(1); const shown = rows.slice(0, n); return <ul onClick={() => setN(n + 1)}>{shown.map((r: any) => <li key={r.id}>{r.bs.map((b: any) => <Badge key={b.t} type={b.t} label={b.l} color={b.c} />)}</li>)}</ul> }", 1, Tier::Native),
        ("state prop", "export default function P({ rows }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.id === k ? 'on' : 'off'} label={r.l} color={r.c} /></li>)}</ul> }", 1, Tier::Native),
        ("plain prop, no row", "export default function P({ t }: any) { return <div><Badge type={t} label=\"x\" color=\"#000\" /></div> }", 0, Tier::Static),
    ] {
        let ir = analyze_at("tests/fixtures/static-list-child/T.tsx", &format!("{S}{src}"));
        assert_eq!(ir.child_links.len(), links, "{name}: {:?}", ir.diagnostics);
        assert_eq!(ir.tier, tier, "{name}");
    }
}

/// F70: a dropped row-only link does not renumber the links that survive.
#[test]
fn row_only_links_keep_their_ids() {
    let ir = analyze_at(
        "tests/fixtures/static-list-child/T.tsx",
        "import { useState } from 'react'\nimport Badge from './Badge'\nexport default function P({ rows }: any) { const [k, setK] = useState(''); return <div><ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul><Badge type={k} label=\"x\" color=\"#000\" /></div> }",
    );
    assert_eq!(ir.child_links.len(), 1, "{:?}", ir.child_links);
    assert_eq!((ir.child_links[0].id, ir.child_links[0].props_member.as_str()), (2, "_p2"));
}
```
Check the "nested … stateful outer list" case compiles as intended: `rows.slice(0, n)` is in the template subset? If `brustc --emit ir` reports it as a precompute slot or a fallback, replace with the `take` helper of the `reactive-list-child` fixture (`import { take } from '../reactive-list-child/take'` resolves from `tests/fixtures/static-list-child/`). The native-child row (as today) is already covered by `keyed_list_of_native_children_is_item_scoped` in the same file.
```bash
cargo test -p brust-compiler --test children 2>&1 | grep -E 'test result|FAILED|panicked'
```

- [ ] **Step 5: Dual-eval pins.** `crates/brust-compiler/tests/dual_eval.rs:40-45`:
```rust
const NO_DIRECTIVES: &[&str] = &[
    "static-text",
    "cached-card",
    "outlet-layout",
    "react-child-row",
    // F70: a static child in a row the client cannot re-create has no directives.
    "keyed-list-child-job",
    "static-list-child",
];
```
`scripts/battery/exit.ts:22`: `export const DUAL_EVAL_NO_DIRECTIVES = ['static-text', 'cached-card', 'outlet-layout', 'keyed-list-child-job', 'static-list-child']` (that list is text in the generated exit report; leave `react-child-row` out as it is today — the two lists have drifted before and `exit.test.ts` does not compare them, but the report sentence must stay truthful for the fixtures this lane touches). Then:
```bash
cargo test -p brust-compiler --test dual_eval 2>&1 | grep -E 'test result|checked'
```

- [ ] **Step 6: The TS pins that named the dead attributes.** Rebuild the addon first: `cd packages/brust && bun run build:debug && cd ../..`.
  - `packages/brust/test/e2e.test.ts:84` — current `expect(h1).toContain('<h1 id="brust-r2-itemPage_b7278c7c-1" x-text="_c1">Item 7</h1>')` → `expect(h1).toContain('<h1 id="brust-r2-itemPage_b7278c7c-1">Item 7</h1>') // F70: ItemPage is static (PriceRow reads only the row); useId is still server-seeded`.
  - `:85` — current `expect(h1).toMatch(/<li x-data="priceRow_[0-9a-f]{8}" x-props-bind="_p1:r">1\.0€<\/li>.*<li x-data="priceRow_[0-9a-f]{8}" x-props-bind="_p1:r">2\.3€<\/li>/s)` → `expect(h1).toMatch(/<li>1\.0€<\/li>.*<li>2\.3€<\/li>/s) // per-row job values, plain rows (F70)`.
  - `:113` — `'<h1 id="brust-r2-itemPage_b7278c7c-1" x-text="_c1">missing</h1>'` → `'<h1 id="brust-r2-itemPage_b7278c7c-1">missing</h1>'`.
  - `packages/brust/test/build-manifest.test.ts:104` — `html.match(/<li x-data="priceRow_042dcbca"[^>]*>([^<]*)<\/li>/g)` → `html.match(/<li>([^<]*)<\/li>/g)` (the page has exactly the two rows as `<li>`; keep the `['1.0€', '2.3€']` expectation).
  - `packages/brust/test/fixtures/app.expected-manifest.json` — `itemPage_b7278c7c.tier` `"native"` → `"static"`, `.client` → `null`; `priceRow_042dcbca.client` → `null` (its `children[]` per-row record, jobs and `needs_worker` stay). Run `cd packages/brust && bun test test/build-manifest.test.ts` and let the first failure print the actual manifest; edit the pin to match ONLY in those fields.
  - `tests/server/pokedex.test.ts:91` — `expect(html).toMatch(/No Pokémon named “<span[^>]*>Nothing<\/span>”/)` → `expect(html).toMatch(/No Pokémon named “Nothing”/) // F70: DetailPage is static, no x-text wrapper`.
```bash
cd packages/brust && bun run typecheck && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
bun run browser-test
```
Expected: all green. If `e2e.test.ts:60-72` ("static route … exactly the layout's two scripts") changes count, that app's layout gained or lost a chunk — it has `useState`, so it must NOT change; investigate before touching it.

- [ ] **Step 7: Pokedex snapshot after F70**
```bash
$OUT/snap.sh after-f70
for p in _ _pokedex _pokemon_pikachu; do
  cmp -s $OUT/body-before$p.visible $OUT/body-after-f70$p.visible && echo "VISIBLE-IDENTICAL $p" || { echo "VISIBLE DIFF $p"; diff $OUT/body-before$p.visible $OUT/body-after-f70$p.visible | head -20; }
  cmp -s $OUT/body-before$p.loadbearing $OUT/body-after-f70$p.loadbearing && echo "LOADBEARING-IDENTICAL $p" || { echo "LOADBEARING DIFF $p"; diff $OUT/body-before$p.loadbearing $OUT/body-after-f70$p.loadbearing; }
  paste $OUT/body-before$p.counts $OUT/body-after-f70$p.counts
done
```
Expected: `VISIBLE-IDENTICAL` ×3 and `LOADBEARING-IDENTICAL` ×3; counts: `x-data`, `x-props`, `x-text`, `x-bind-`, `scripts` DOWN on `/` and `/pokemon/pikachu` (TypeBadge instances, `appLayout_`/`detailPage_`/`homePage_` hosts and the `typeBadge_` + `appLayout_` scripts gone), unchanged on `/pokedex`'s `x-for`/`x-props-bind`/`x-on-`. A VISIBLE diff that is only a `<span …>` with a class means the normaliser's bare-span rule did not match: inspect; a load-bearing diff is a bug. Paste the three `paste` tables in the note.

- [ ] **Step 8: Quick measurement after F70 (D and I, brust vs 0.1.x only; results discarded)**
```bash
cd packages/brust && bun run build && cd ../..
uptime      # 1- and 5-minute load ≤ 10
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_ID='m3p-f-payload knock2' bun bench/run.ts --apps brust,brust-01x --probes D,I | tee $OUT/bench-f70.txt
cp bench/RESULTS.json $OUT/RESULTS-f70.json && git checkout -- bench/RESULTS.md bench/RESULTS.json
( cd bench/apps/brust && ../../../packages/brust/bin/brust build routes.tsx >/dev/null ) && cp bench/apps/brust/dist/jinja/dexPage_*.jinja crates/brust-compiler/tests/fixtures/payload/dex.after.jinja
```
Expected: D `bytes/resp` for brust ≈ 21,7xx (0.1.x 21,860) and rps up (the identity run was 6,148 vs 14,194); I unchanged at 781 bytes. Also capture `bytes.after.txt` with the Task 1 Step 2 loop (same three paths) into `crates/brust-compiler/tests/fixtures/payload/bytes.after.txt`. `dex.after.jinja` must contain no `x-` (`grep -c x- → 0`) and no `<brust-host x-data`.

- [ ] **Step 9: Commit**
```bash
cargo fmt --all -- --check && cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E '^test result|FAILED' | sort | uniq -c
git add crates/brust-compiler/src/analyze/passes/children.rs crates/brust-compiler/tests/children.rs crates/brust-compiler/tests/dual_eval.rs scripts/battery/exit.ts \
  tests/fixtures/keyed-list-child-job tests/fixtures/static-list-child \
  packages/brust/test/e2e.test.ts packages/brust/test/build-manifest.test.ts packages/brust/test/fixtures/app.expected-manifest.json tests/server/pokedex.test.ts \
  crates/brust-compiler/tests/fixtures/payload/dex.after.jinja crates/brust-compiler/tests/fixtures/payload/bytes.after.txt
git status --short         # nothing else; in particular no other tests/fixtures/* and no bench/RESULTS.*
git commit -m "fix(compiler): a static child in a row the client cannot re-create is plain HTML (F70)

children.rs created a ChildLink for every child whose props read a loop
binding, so a static TypeBadge made its page native, its row an x-for row,
its instance a host with x-props/x-props-bind/x-bind-*/x-text, the list a
client prop seeded whole into the page host, and gave the child a chunk —
on a page nothing on the client can change. A static child reading only the
row is now a RowOnly link, kept only inside a row the client can re-create
(state-sourced list, or a row with a directive of its own) and dropped
elsewhere, after the walk, without renumbering surviving _pN. Bench D goes
from 144,226 to ~21.8 KB/resp (0.1.x: 21,860); pokedex visible markup and
load-bearing directives unchanged (DexFilter rows, TeamBuilder, ThemeToggle).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: F71 analysis — `item_reads`, the projection pass, the `project` filter (unit-tested, not yet emitted)

**Files:**
- Create: `crates/brust-compiler/src/analyze/passes/projection.rs`
- Modify: `crates/brust-compiler/src/analyze/passes/mod.rs` (`pub mod projection;` + call), `crates/brust-compiler/src/analyze/passes/captures.rs:66-76,139-146` (keep the raw), `crates/brust-compiler/src/analyze/passes/children.rs` (`plain_path` → `pub(super)`), `crates/brust-compiler/src/ir/mod.rs:208-210` (new field), `crates/brust-jinja/src/lib.rs` (filter + tests)
- Read first: `crates/brust-compiler/src/analyze/passes/deps.rs:225-300` (`prop_path`, the `Walker::raw` arms — the shape `item_reads` mirrors), `placement.rs:36-42` (`SlotInfo { raw, scope, deps, state_dependent }`), `placement.rs:636-668` (when a list becomes "a list the client updates"), `captures.rs:120-164`, `brust-jinja/src/lib.rs:440-478` (`keys`, `entries`: `Value` iteration idioms), `~/.cargo/registry/src/*/minijinja-3.0.0/src/value/argtypes.rs:404` (`FromIterator<V> for Value`) and `:920` (`Rest<T>`)

**Interfaces:**
- IR: `ComponentIR.client_prop_projections: BTreeMap<String, Vec<String>>` — prop root (as it appears in `client_props`) → sorted minimal row-field paths (`"badges.color"`, `"id"`); `#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]` so no golden changes until a projection exists.
- `projection.rs`:
```rust
/// What client code reads of one loop item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemRead { Fields(BTreeSet<String>), Whole }
/// Adds the member paths of `item` that `r` reads; `Whole` as soon as the item escapes
/// (bare use, call argument, dynamic index, spread, opaque body, JSX, shadowing).
pub fn item_reads(r: &RawExpr, item: &str, out: &mut ItemRead)
/// Fills `ir.client_prop_projections` (ledger F71).
pub fn projection(ir: &mut ComponentIR, st: &PassState)
```
- `brust-jinja`: filter `project(v: Value, paths: Rest<String>) -> Value`.
- `captures.rs`: handlers' `ClientUse.raw = Some((h.body.clone(), h.item_scoped.clone()))` and slot uses' `raw = Some((i.raw.clone(), i.scope.clone()))` — `captures.rs:151-155` recomputes `deps` from a present raw with exactly the same `cx.deps(raw, scope)` call those sites use today, so nothing else changes.

Decision rule (R2), per prop root `P` in `ir.client_props` (`"*"` excluded):
1. **Every** client use that reads `P` (`u.deps.props` has `P` or a path starting with `P.`) must be a list source: `u.what == "a list the client updates"` and `u.raw == Some((r, _))` with `deps::prop_path(&r) == Some(P)`. A handler reading `props.rows.length`, a state initializer `useState(props.rows)`, a state-dependent slot `take(props.rows, n)`, a list over `props.rows.filter(…)` → no projection for `P` (full value, as today).
2. The lists over `P` are the `For` nodes of `ir.template` whose source is the plain path `P` (`children::plain_path(raw, None) == Some(PlainPath::Props(P))`, with `Precomputed` sources resolved through `st.slots[slot].raw`). For each such list with item `I`: scan (a) the `For`'s `key` expression, (b) every expression in the body with `I` in scope — `Slot(e)`, `Attr::Dynamic { value }`, `If { cond }`, nested `For { source, key }`, `Component { props }` values (`Server` → raw; `Precomputed` → `st.slots[slot].raw`; `ClientOnly` → skip here, its placement use has the raw and is scanned in (c)) — and (c) every client use whose `scope` contains `I` (`u.raw.1`), or whose `raw` is `None` while `u.deps.loop_bindings` contains `I` (→ `Whole`). A nested `For` whose source is `I.field…` (`PlainPath::Row`) adds the field whole (`"field"`) and its body is still scanned for reads of `I`.
3. `Whole` anywhere → no entry. Otherwise `client_prop_projections[P] = minimal_paths(fields)` (`deps::minimal_paths`). An empty field set cannot happen (the key reads the item); if it does, no entry.

`item_reads` arms (`crate::ir::RawKind`, `ArrowBody`):
```rust
pub fn item_reads(r: &RawExpr, item: &str, out: &mut ItemRead) {
    if matches!(out, ItemRead::Whole) { return; }
    match &r.kind {
        RawKind::Lit(_) => {}
        RawKind::Ident { name, kind: IdentKind::LoopBinding } if name == item => *out = ItemRead::Whole,
        RawKind::Ident { .. } => {}
        RawKind::Member { target, .. } => match item_path(r, item) {
            Some(p) => { if let ItemRead::Fields(f) = out { f.insert(p); } }
            None => item_reads(target, item, out),
        },
        // `row[key]`, `row["k"]`, `row.xs[i]`: the shape of the read is not a path.
        RawKind::Index { target, index } => {
            if item_path(target, item).is_some() || is_item(target, item) { *out = ItemRead::Whole }
            else { item_reads(target, item, out); item_reads(index, item, out) }
        }
        // A method on a field reads the field (`row.name.trim()`); a call taking the row
        // reads all of it (`fmt(row)`) — the argument walk below yields Whole.
        RawKind::Call { callee, args } => {
            match &callee.kind { RawKind::Member { target, .. } => item_reads(target, item, out), _ => item_reads(callee, item, out) }
            for a in args { item_reads(a, item, out) }
        }
        RawKind::Binary { left, right, .. } => { item_reads(left, item, out); item_reads(right, item, out) }
        RawKind::Unary { value, .. } => item_reads(value, item, out),
        RawKind::Cond { test, yes, no } => { item_reads(test, item, out); item_reads(yes, item, out); item_reads(no, item, out) }
        RawKind::Template { parts, .. } => for (p, _) in parts { item_reads(p, item, out) },
        RawKind::Array(xs) => for x in xs { item_reads(x, item, out) },
        RawKind::Object(ps) => for (_, v) in ps { item_reads(v, item, out) },
        RawKind::Arrow { params, body, captures } => {
            if params.iter().any(|p| p == item) { return; }          // shadowed: reads its own parameter
            match body {
                ArrowBody::Expr(e) => item_reads(e, item, out),
                ArrowBody::Block { .. } => if captures.iter().any(|(n, _)| n == item) { *out = ItemRead::Whole },
            }
        }
        RawKind::Jsx(_) => *out = ItemRead::Whole,
        RawKind::Opaque { captures, .. } => if captures.iter().any(|(n, _)| n == item) { *out = ItemRead::Whole },
    }
}
/// `item.a.b` → `"a.b"`; `None` unless `r` is a member chain rooted at `item` (optional chaining included).
fn item_path(r: &RawExpr, item: &str) -> Option<String>
fn is_item(r: &RawExpr, item: &str) -> bool   // bare `Ident { name == item, LoopBinding }`
```

- [ ] **Step 1: IR field.** `crates/brust-compiler/src/ir/mod.rs` after `pub client_props: Vec<String>,` (:210):
```rust
    /// F71: for a prop the client reads only as the source of keyed lists, the row fields it
    /// can read (`"id"`, `"badges.color"`); the host's `x-props` seeds `root | project(…)`.
    /// Absent (full value) whenever a read cannot be proved to be a plain field path.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub client_prop_projections: std::collections::BTreeMap<String, Vec<String>>,
```
`ComponentIR` does NOT derive `Default` (`ir/mod.rs:185`); the only struct literal is `ir/mod.rs:274` (`client_props: vec![],` in `ComponentIR::new`-style construction) — add `client_prop_projections: Default::default(),` next to it (`grep -rn "client_props:" crates/brust-compiler/src` must list exactly that one site plus the field declaration).

- [ ] **Step 2: Raws for handlers and slot uses** in `captures.rs` — current (`:66-72`):
```rust
    for h in &ir.handlers {
        uses.push(ClientUse {
            loc: h.body.loc,
            deps: cx.deps(&h.body, &h.item_scoped),
            what: "a handler",
            raw: None,
        });
    }
```
→ `raw: Some((h.body.clone(), h.item_scoped.clone())),`; and (`:139-146`) the state-dependent slot loop → `raw: Some((i.raw.clone(), i.scope.clone())),`. `cargo test -p brust-compiler` must stay green with no golden change (`git status --short tests/fixtures` empty) — the recomputation at `:151-155` is identical.

- [ ] **Step 3: `projection.rs`** — the items above plus the pass:
```rust
//! Row projection (ledger F71, spec §3.2 rule 3): for a prop the client reads only as the
//! source of keyed lists, the fields of each row the client can read — the host's `x-props`
//! then carries `rows | project("id", "title")` instead of every field of every row. Any read
//! the pass cannot see through keeps the full value: a field that might be read is never dropped.
use super::children::{PlainPath, plain_path};
use super::deps::{minimal_paths, prop_path};
use super::{ClientUse, PassState};
use crate::ir::{ArrowBody, Attr, ComponentIR, Expr, IdentKind, Node, RawExpr, RawKind, ServerExpr};
use std::collections::{BTreeMap, BTreeSet};

pub fn projection(ir: &mut ComponentIR, st: &PassState) {
    let mut out = BTreeMap::new();
    for root in &ir.client_props {
        if root == "*" { continue; }
        if let Some(fields) = project_root(root, ir, st) {
            out.insert(root.clone(), fields);
        }
    }
    ir.client_prop_projections = out;
}

fn project_root(root: &str, ir: &ComponentIR, st: &PassState) -> Option<Vec<String>> {
    let reads_root = |u: &ClientUse| u.deps.props.iter().any(|p| p == root || p.strip_prefix(root).is_some_and(|r| r.starts_with('.')));
    let is_plain_source = |u: &ClientUse| u.what == "a list the client updates" && u.raw.as_ref().is_some_and(|(r, _)| prop_path(r).as_deref() == Some(root));
    if st.client_uses.iter().any(|u| reads_root(u) && !is_plain_source(u)) { return None; }
    let mut read = ItemRead::Fields(BTreeSet::new());
    let mut lists = Vec::new();
    list_items(&ir.template, root, st, &mut lists);          // (item name, For node) for every list over `root`
    if lists.is_empty() { return None; }
    for (item, node) in &lists {
        let Node::For { key, body, .. } = node else { unreachable!() };
        raw_reads(key, st, item, &mut read);
        body.iter().for_each(|n| body_reads(n, st, item, &mut read));
        for u in &st.client_uses {
            match &u.raw {
                Some((r, scope)) if scope.iter().any(|s| s == item) => item_reads(r, item, &mut read),
                None if u.deps.loop_bindings.contains(item) => read = ItemRead::Whole,
                _ => {}
            }
        }
    }
    match read {
        ItemRead::Whole => None,
        ItemRead::Fields(f) if f.is_empty() => None,
        ItemRead::Fields(f) => Some(minimal_paths(f)),
    }
}
```
with `raw_reads(e: &Expr, st, item, out)` resolving `Expr::Server(ServerExpr(r))` → `item_reads(r)`, `Expr::Precomputed { slot, .. }` → `st.slots.get(slot)` → `item_reads(&i.raw)`, `Expr::Raw(r)` → `item_reads(r)`, `Expr::ClientOnly` → nothing (its placement use carries the raw); `body_reads(n)` walking `Element` (attrs `Dynamic { value }` → `raw_reads`; children), `Slot(e)`, `If { cond, then, else_ }`, `For { source, key, body }` (source: if `plain_path(raw, Some(item)) == Some(PlainPath::Row(rest))` → insert `rest.trim_start_matches('.')` as a whole field (empty `rest` = the item itself → `Whole`), else `raw_reads(source)`; then `raw_reads(key)` and the body — the inner item is another name and is ignored), `Component { props, children }` (each prop value → `raw_reads`), `Fragment`, `Text`/`Outlet` nothing; `list_items(n, root, st, out)` collecting top-level `For` nodes whose source resolves (through slots for `Precomputed`) to `plain_path(raw, None) == Some(PlainPath::Props(root))` — do not descend into a matching list's body for more lists over `root` (a nested list over the same root is a `Whole` read of … no: it is a second plain source; keep it simple: collect only lists not nested in another list over `root`; nested ones are reached through `body_reads` as `raw_reads(source)` → `prop_path == root` → bare prop, not an item read → fine).
Make `plain_path` and `PlainPath` `pub(super)` in `children.rs`.

- [ ] **Step 4: Wire the pass.** `passes/mod.rs`: `pub mod projection;` and in `run_passes` after `captures::captures(ir, &mut st, ctx);`: `projection::projection(ir, &st);` (before `tier`; the pass only reads).

- [ ] **Step 5: Unit tests in `projection.rs`** (`#[cfg(test)]`, building `RawExpr`s by hand is verbose — go through the real analyser instead: `crate::analyze::component::analyze_source(path, src, &AnalyzeOptions { root: repo, ..Default::default() })` inside `crate::parse::run_on_compiler_thread`, as `tests/children.rs` does; put these in `crates/brust-compiler/tests/projection.rs` (new integration test file) if the `lib` test needs private items it cannot reach):
```rust
fn projections(src: &str) -> BTreeMap<String, Vec<String>>   // analyze_source("tests/fixtures/reactive-list-rows/T.tsx", …).client_prop_projections
const S: &str = "import { useState } from 'react'\n";
#[test] fn key_field_is_always_kept() {
    let p = projections(&format!("{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r.name)}}>{{r.name}}</li>)}}</ul> }}"));
    assert_eq!(p["rows"], ["id", "name"]);
}
#[test] fn fields_through_handler_template_and_nested_paths() {
    let p = projections(&format!("{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} className={{r.meta.tone}} title={{`${{r.a.b}}-${{r.a.c}}`}} onClick={{() => setK(r.meta.id)}}>{{r.name.trim()}}</li>)}}</ul> }}"));
    assert_eq!(p["rows"], ["a.b", "a.c", "id", "meta.id", "meta.tone", "name"]);
}
#[test] fn nested_list_keeps_the_inner_field_whole() {
    let p = projections(&format!("{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r.id)}}>{{r.tags.map((t: any) => <b key={{t.id}}>{{t.name}}</b>)}}</li>)}}</ul> }}"));
    assert_eq!(p["rows"], ["id", "tags"]);
}
#[test] fn row_passed_whole_to_a_child_is_whole() {   // Counter is native ⇒ Always link ⇒ `_p1 = (r) => ({ n: r })`
    let p = projections("import { useState } from 'react'\nimport Counter from '../parent-counter/Counter'\nexport default function P({ rows }: any) { const [k, setK] = useState(0); return <ul onClick={() => setK(1)}>{rows.map((r: any) => <Counter key={r.id} n={r} onReset={() => setK(0)} />)}</ul> }");
    assert!(!p.contains_key("rows"), "{p:?}");
}
#[test] fn helper_call_dynamic_index_and_bare_item_are_whole() {
    for src in [
        "{S}import {{ fmt }} from '../keyed-list-child-job/money'\nexport default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(fmt(r, 'x'))}}>{{r.name}}</li>)}}</ul> }}",
        "{S}export default function P({{ rows, f }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r[f])}}>{{r.name}}</li>)}}</ul> }}",
        "{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(null); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r)}}>{{r.name}}</li>)}}</ul> }}",
    ] { let p = projections(&src.replace("{S}", S)); assert!(!p.contains_key("rows"), "{src}\n{p:?}"); }
}
#[test] fn a_non_list_client_read_of_the_root_disables_projection() {
    let p = projections(&format!("{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(0); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(rows.length)}}>{{r.name}}</li>)}}</ul> }}"));
    assert!(!p.contains_key("rows"), "{p:?}");
}
#[test] fn a_static_list_has_no_projection() {   // not a client prop at all after F70
    let p = projections("export default function P({ rows }: any) { return <ul>{rows.map((r: any) => <li key={r.id}>{r.name}</li>)}</ul> }");
    assert!(p.is_empty(), "{p:?}");
}
```
Adjust the `fmt` import path/fixture to one that exists (`tests/fixtures/keyed-list-child-job/money.ts` exports `fmt(n, u)`); the test only needs a module helper taking the row.

- [ ] **Step 6: The `project` filter** in `crates/brust-jinja/src/lib.rs` — register after the last `env.add_filter` in `register()` (keep away from `json_attr`), and add at the end of the free functions:
```rust
/// `rows | project("id", "tags.name")` (compiler F71): of every object, only the listed paths;
/// an array is mapped element-wise at every level; anything else (strings, numbers, none,
/// undefined) passes through unchanged, and a listed path that is absent is simply absent.
/// Keys come out sorted (BTreeMap), as `json_attr` prints a loader object today.
fn project(v: Value, paths: Rest<String>) -> Value {
    let mut tree: BTreeMap<String, Vec<String>> = BTreeMap::new();   // first segment → remaining paths ("" = whole)
    for p in paths.0.iter() {
        let (head, rest) = p.split_once('.').map_or((p.as_str(), None), |(h, r)| (h, Some(r)));
        tree.entry(head.to_string()).or_default().extend(rest.map(str::to_string));
    }
    project_value(&v, &tree)
}
fn project_value(v: &Value, tree: &BTreeMap<String, Vec<String>>) -> Value {
    match v.kind() {
        ValueKind::Seq => v.try_iter().map(|it| it.map(|x| project_value(&x, tree)).collect::<Value>()).unwrap_or_else(|_| v.clone()),
        ValueKind::Map => {
            let mut out: BTreeMap<String, Value> = BTreeMap::new();
            for (k, sub) in tree {
                let x = v.get_item(&Value::from(k.as_str())).unwrap_or(Value::UNDEFINED);
                if x.is_undefined() { continue; }
                let subtree: BTreeMap<String, Vec<String>> = …;      // rebuild from `sub` as `project` does; empty `sub` or a "" entry = keep `x` whole
                out.insert(k.clone(), if subtree.is_empty() { x } else { project_value(&x, &subtree) });
            }
            Value::from_serialize(&out)   // argtypes.rs:404 `FromIterator<V>` builds a SEQUENCE; a map goes through serde (`Value: Serialize`, `BTreeMap<String, Value>` serializes as a map)
        }
        _ => v.clone(),
    }
}
```
Imports: extend `use minijinja::value::{Kwargs, Value, ValueKind};` (`lib.rs:11`) with `Rest`. Pay attention to: a path whose head has BOTH a whole entry (`"tags"`) and sub-paths (`"tags.name"`) → whole wins (minimal_paths already removes the covered one, but the filter must not depend on it). Unit tests in the existing `mod tests` (use its `render(src, ctx)` helper):
```rust
    #[test]
    fn project_keeps_listed_paths_elementwise() {
        let ctx = Value::from_serialize(&serde_json::json!({ "rows": [
            { "id": 1, "name": "x", "secret": "s", "badges": [{ "type": "a", "color": "c", "hidden": 1 }] },
            { "id": 2, "name": "y", "badges": [] }, 7, null ] }));
        assert_eq!(render(r#"{{ rows | project("id", "badges.type") | json_attr }}"#, ctx.clone()),
            r#"[{&quot;badges&quot;:[{&quot;type&quot;:&quot;a&quot;}],&quot;id&quot;:1},{&quot;badges&quot;:[],&quot;id&quot;:2},7,null]"#);
        assert_eq!(render(r#"{{ rows | project("badges", "badges.type") | json_attr }}"#, ctx.clone()), /* whole badges */ …);
        assert_eq!(render(r#"{{ missing | project("id") | json_attr }}"#, ctx.clone()), "null");   // undefined/none pass through: match what `{{ missing | json_attr }}` prints today and assert equality with it
        assert_eq!(render(r#"{{ "str" | project("id") }}"#, ctx), "str");
    }
```
(Write the expected strings from a first run and check them by eye against the rule — `json_attr`'s exact escaping is in `write_json_attr_str`.)

- [ ] **Step 7: Gates and commit**
```bash
cargo fmt --all && cargo clippy -p brust-compiler -p brust-jinja --no-deps -- -D warnings
cargo test -p brust-jinja 2>&1 | grep -E 'test result|project'
cargo test -p brust-compiler 2>&1 | grep -E '^test result|FAILED' | sort | uniq -c
git status --short tests/fixtures            # EMPTY: nothing emits the projection yet, and skip_serializing_if hides the field
git add crates/brust-compiler/src/analyze/passes/projection.rs crates/brust-compiler/src/analyze/passes/mod.rs crates/brust-compiler/src/analyze/passes/captures.rs crates/brust-compiler/src/analyze/passes/children.rs crates/brust-compiler/src/ir/mod.rs crates/brust-jinja/src/lib.rs crates/brust-compiler/tests/projection.rs
git commit -m "feat(compiler,jinja): row read-set projection for list props and the project filter (F71)

projection.rs: for a prop the client reads only as the plain source of keyed
lists, the union of the row fields read by the key, the row template, link
props and item-scoped handlers (item_reads: a row that escapes — helper
argument, dynamic index, bare use, opaque body, passed whole to a child —
is Whole and keeps the full value). Stored as client_prop_projections; the
template backend does not emit it yet. brust-jinja gains `project(paths…)`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire F71 — `host_attrs` emits the projection; goldens; the browser case

**Files:**
- Modify: `crates/brust-compiler/src/lower/template.rs:558-569` (the whole-root arm of the seed), `crates/brust-compiler/tests/lower_template.rs` (3 tests), `tests/browser/cases/reactive-list-rows.test.ts` (new), `scripts/battery/exit.ts:19` (`BROWSER_CASES`)
- Goldens (regenerated): `tests/fixtures/{keyed-list,keyed-list-child,nested-list,use-id-row,reactive-list-rows}/{expected.jinja,expected.ir.json}`. Nothing else (in particular NOT `reactive-list-child` — its `rows` goes through `take()` — and NOT `table-rows`, whose `rows` is a `length`-only seed).

**Interfaces:**
- Consumes: `ir.client_prop_projections`. Produces: in the host's `x-props`, `"rows": (rows) | project("id", "name")` for a whole-seeded projected root.

- [ ] **Step 1: Emit.** `template.rs:558-569` — current:
```rust
        let dict: Vec<String> = if seed.contains("*") {
            vec![]
        } else {
            seed_tree(&seed)
                .into_iter()
                .map(|(root, node)| {
                    let base = value_of(&root);
                    format!("{}: {}", jinja_string(&root), node.jinja(&base))
                })
                .collect()
        };
```
Replace the closure body with:
```rust
                    let base = value_of(&root);
                    // F71: a root the client reads only as a list source seeds the row fields it reads.
                    let value = match (&node, ir.client_prop_projections.get(&root)) {
                        (SeedNode::Whole, Some(paths)) => format!(
                            "(({base}) | project({}))",
                            paths.iter().map(|p| jinja_string(p)).collect::<Vec<_>>().join(", ")
                        ),
                        _ => node.jinja(&base),
                    };
                    format!("{}: {value}", jinja_string(&root))
```
(`ir` is `self.f.ir` — for an inlined child instance that is the CHILD's IR, whose projections are about the child's own props, and `base` is the parent's expression: correct.) The `_props` whole-props branch (`seed.contains("*")`) is untouched.

- [ ] **Step 2: Regenerate exactly the five fixtures**
```bash
cargo fmt --all && cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test -p brust-compiler --test fixtures 2>&1 | grep -E 'mismatch in' | sed 's/--- expected.*//' | sort -u
```
Expected: only `keyed-list`, `keyed-list-child`, `nested-list`, `use-id-row`, `reactive-list-rows` (`expected.jinja`, `expected.ir.json`). Any other name → the rule over-applies: STOP and compare with R2.
```bash
BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures 2>&1 | tail -2 && git status --short tests/fixtures | sort
git diff tests/fixtures/keyed-list/expected.jinja | grep '^[-+]<ul'
```
Expected jinja lines: `keyed-list` `x-props='{{ {"todos": ((todos) | project("done", "id", "title"))} | json_attr }}'`; `keyed-list-child` `… project("id", "title")` (`onPick={() => setSelected(t.id)}` is the function prop's placement use; `selected={t.id === selected}` reads `t.id`); `nested-list` `… project("cells", "id")`; `use-id-row` `… project("key", "label")`; `reactive-list-rows` `… project("id", "name")`. `reactive-list-child` unchanged (`{"rows": rows}`), `expected.ir.json` of the five gains `"client_prop_projections": { … }`.
```bash
cargo test -p brust-compiler --test dual_eval 2>&1 | grep -E 'test result|checked'      # green: painted values == client values, row counts equal, on projected props
```

- [ ] **Step 3: Pins in `crates/brust-compiler/tests/lower_template.rs`** (helpers `lowered_jinja`, `render` exist in the file):
```rust
/// F71: the list host seeds only the row fields the client reads; the key field is always one of them.
#[test]
fn projected_x_props_drops_unread_row_fields_and_keeps_the_key() {
    let jinja = lowered_jinja("reactive-list-rows");
    assert!(jinja.contains("project(\"id\", \"name\")"), "{jinja}");
    let html = render(&jinja, serde_json::json!({ "rows": [{ "id": "a", "name": "Ada", "secret": "s3cr3t" }] }));
    let props = html.split("x-props='").nth(1).unwrap().split('\'').next().unwrap().replace("&quot;", "\"");
    assert_eq!(props, r#"{"rows":[{"id":"a","name":"Ada"}]}"#, "{html}");
    assert!(!html.contains("s3cr3t"), "{html}");
}

/// F71 fallback: a row read through a helper keeps the full list in x-props.
#[test]
fn helper_read_keeps_the_full_row() {
    let jinja = lowered_jinja("reactive-list-child");
    assert!(jinja.contains("x-props='{{ {\"rows\": rows} | json_attr }}'"), "{jinja}");
    assert!(!jinja.contains("project("), "{jinja}");
}

/// F70 + F71 together: the bench D page is plain HTML with no seed at all.
#[test]
fn static_list_page_has_no_directives_and_no_seed() {
    let jinja = lowered_jinja("static-list-child");
    assert!(!jinja.contains("x-"), "{jinja}");
    let sample = lower_common::repo().join("tests/fixtures/static-list-child/sample-props.json");
    let html = render(&jinja, serde_json::from_str(&std::fs::read_to_string(sample).unwrap()).unwrap());
    assert!(html.contains("<span data-type=\"grass\" style=\"background:#63bb5b\">Grass</span>"), "{html}");
    assert!(!html.contains("bulbasaur"), "unread field leaked: {html}");   // `name` is never painted
}
```
(`lowered_jinja` (`lower_template.rs:248`) compiles `tests/fixtures/{name}/input.tsx` with `root: repo()`; `render` (`:33`) registers `brust_jinja` so `style_css`/`present`/`project` all resolve; `lower_common::repo()` is the repo root.)
```bash
cargo test -p brust-compiler --test lower_template 2>&1 | grep -E 'test result|FAILED|panicked'
```

- [ ] **Step 4: Browser case** `tests/browser/cases/reactive-list-rows.test.ts` (modelled on `keyed-list-child.test.ts`; the harness builds, renders with the sample props and mounts):
```ts
import { expect, test } from 'bun:test'
import { $$, build, instanceOf, load } from '../harness.ts'

// F71: the host seeds the projected rows (id, name — never secret); the list still keys, re-binds
// and reorders by identity on the projected objects.
const lis = () => $$('li').filter((l) => !l.hasAttribute('hidden'))

test('reactive-list-rows: projected x-props drive the keyed list', async () => {
  const m = await load(build('reactive-list-rows'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)
  const host = $$('ul')[0]!
  expect(host.getAttribute('x-props')).not.toContain('secret')
  const props = instanceOf(host).props
  expect((props() as { rows: object[] }).rows).toEqual([{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }])
  lis()[1]!.click()
  expect(lis().map((l) => l.className)).toEqual(['', 'on'])
  const [a, b] = lis()
  props.set({ rows: [{ id: 'b', name: 'Bob' }, { id: 'a', name: 'Ada' }] })
  expect(lis()).toEqual([b!, a!])
  expect(lis().map((l) => l.className)).toEqual(['on', ''])
  expect(m.warnings).toEqual([])
})
```
`scripts/battery/exit.ts:19`: `export const BROWSER_CASES = [..., 'guarded-slot', 'reactive-list-rows']` (the exit test counts `across ${BROWSER_CASES.length + 1} files`).
```bash
bun run browser-test 2>&1 | tail -5          # all files pass incl. reactive-list-rows
```

- [ ] **Step 5: Pokedex snapshot (must equal after-f70 — no pokedex list is projectable: DexFilter reads `items` through `filterSort`)**
```bash
cd packages/brust && bun run build:debug && cd ../.. && $OUT/snap.sh after-f71
for p in _ _pokedex _pokemon_pikachu; do cmp $OUT/body-after-f70$p $OUT/body-after-f71$p && echo "IDENTICAL-TO-F70 $p"; done
```
Expected: `IDENTICAL-TO-F70` ×3 (bytes included). If `/pokedex` differs, `DexFilter`'s `items` got a projection: that is a bug in rule 1 (its use is "a state-dependent value", not a list source) — fix the pass, not the snapshot.

- [ ] **Step 6: Gates and commit**
```bash
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E '^test result|FAILED' | sort | uniq -c
cd packages/brust && bun run typecheck && bun test test/build-manifest.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
git add crates/brust-compiler/src/lower/template.rs crates/brust-compiler/tests/lower_template.rs tests/browser/cases/reactive-list-rows.test.ts scripts/battery/exit.ts \
  tests/fixtures/keyed-list tests/fixtures/keyed-list-child tests/fixtures/nested-list tests/fixtures/use-id-row tests/fixtures/reactive-list-rows
git status --short      # nothing else
git commit -m "fix(compiler): list hosts seed only the row fields the client reads (F71)

host_attrs prints a whole-seeded root that the client reads only as a list
source as `(root) | project(\"a\", \"b.c\")`; a root read any other way, or a
row that escapes to a helper / dynamic index / child, keeps the full value.
Rendered HTML of every sampled fixture is unchanged (dual-eval, browser
harness); the pokedex is byte-identical to F70 (DexFilter reads items
through filterSort). reactive-list-rows pins projection, key retention and
reorder on projected rows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Battery pair and the generated reports

**Files:**
- Modify: `scripts/battery/rows.ts` (two rows at the end of category E, before `e-parse-error`), `docs/react-coverage.md`, `docs/plans/m1-exit-report.md` (generated)

- [ ] **Step 1: Rows** (`rows.ts`, category E; `child()` helper exists at the top of the file):
```ts
  { id: 'e-static-list-child', category: 'E', authoring: 'static child with row-only props in a prop list (F70)', expect: 'static', jobs: 0,
    snippet: `import Badge from './Badge'\nexport default function C({ rows }: any) { return <ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }`,
    files: { 'Badge.tsx': child(`return <span data-type={props.type} style={{ background: props.color }}>{props.label}</span>`) },
    note: 'ledger F70: no link, no chunk, no x-* — the row cannot change on the client' },
  { id: 'e-reactive-list-child', category: 'E', authoring: 'static child in a state-dependent list keeps its link (F70)', expect: 'native', jobs: 1,
    snippet: `${R}import Badge from './Badge'\nimport { take } from './take'\nexport default function C({ rows }: any) { const [n, setN] = useState(1); return <ul onClick={() => setN(n + 1)}>{take(rows, n).map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }`,
    files: { 'Badge.tsx': child(`return <span data-type={props.type} style={{ background: props.color }}>{props.label}</span>`), 'take.ts': `export const take = (rows: any[], n: number) => rows.slice(0, n)` },
    note: 'ledger F70/F71: the client re-creates the rows; the helper reads rows whole, so x-props keeps the full list' },
```
- [ ] **Step 2: Regenerate and check**
```bash
bun run battery 2>&1 | tail -2                    # [battery] 65 rows, 0 unexplained ⚠ -> docs/…
git diff --stat docs/react-coverage.md docs/plans/m1-exit-report.md
grep -n "e-static-list-child\|e-reactive-list-child" docs/react-coverage.md
bun test scripts/battery 2>&1 | tail -3
```
Expected: the two rows observed `static | 0` and `native | precompute` with `ok` builds; the summary table totals 65; the exit report's dual-eval sentence lists `keyed-list-child-job, static-list-child` and the browser list ends with `reactive-list-rows`; `bun test scripts/battery` green (the exit test runs the dual-eval and the browser harness itself — allow a few minutes).
- [ ] **Step 3: Commit**
```bash
git add scripts/battery/rows.ts docs/react-coverage.md docs/plans/m1-exit-report.md
git commit -m "test(battery): static and reactive list-child rows; regenerate coverage and exit reports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Full gates, measure D and I under the host lock, regenerate RESULTS, READY

**Files:**
- Modify: `bench/RESULTS.md`, `bench/RESULTS.json` (regenerated by the full run)

- [ ] **Step 1: Full gate list** (paste the `test result` lines and the last line of each bun run in the note):
```bash
cargo fmt --all -- --check
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E '^test result|FAILED' | sort | uniq -c
bun run battery && git diff --exit-code docs/react-coverage.md docs/plans/m1-exit-report.md && bun test scripts/battery
bun run browser-test
cd packages/runtime-dom && bun run typecheck && bun test && cd ../..
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
bun check -p bench && bun test bench/lib && bun build --no-bundle bench/run.ts > /dev/null
```

- [ ] **Step 2: Final pokedex snapshot and bench templates**
```bash
$OUT/snap.sh final
for p in _ _pokedex _pokemon_pikachu; do cmp $OUT/body-after-f71$p $OUT/body-final$p && echo "IDENTICAL-TO-F71 $p"; done
( cd bench/apps/brust && ../../../packages/brust/bin/brust build routes.tsx >/dev/null ) && grep -c 'x-' bench/apps/brust/dist/jinja/dexPage_*.jinja bench/apps/brust/dist/jinja/typesPage_*.jinja   # 0 and 0
cmp bench/apps/brust/dist/jinja/teamPage_*.jinja crates/brust-compiler/tests/fixtures/payload/team.before.jinja && echo TEAM-UNCHANGED
```

- [ ] **Step 3: Full bench run (kept)**
```bash
cd packages/brust && bun run build && cd ../..
uptime
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_ID='m3p-f-payload knock2' bun bench/run.ts | tee $OUT/bench-final.txt
sed -n 14,36p bench/RESULTS.md
```
Expected: D `bytes/resp` brust within 10% of brust-01x (≈ 21.8 KB vs 21,860; gzip column now ≈ the others), I `781` unchanged, S `/types` ≈ 1.7 KB (was 8,512: the 18 badges lost their hosts too); the `bar F68` line's D delta moves toward 0 (bytes alone do not close the CPU gap — report the number, do not chase it; that is `m3p-b`/`m3p-d`). Every row 0 errors; if the run exits 2 (busy host) wait and rerun — never commit a partial run.

- [ ] **Step 4: Commit the results**
```bash
git status --short     # bench/RESULTS.md bench/RESULTS.json only
git add bench/RESULTS.md bench/RESULTS.json
git commit -m "bench: results after m3p-f-payload (F70+F71)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git log --oneline m3p..HEAD      # 7 commits
```

- [ ] **Step 5: Update the ledger rows (ask first).** `docs/plans/m1a-followups.md` rows F70 and F71 say "M3-P lane m3p-f-payload"; the lead closes ledger rows at merge — do NOT edit the ledger in this lane; put the closing text in the READY note.

- [ ] **Step 6: READY note** (post on the Conclave task; the lead merges into `m3p`):
```
READY lane/m3p-f-payload @ <sha>  (base m3p @ <sha>)

bytes/resp (identity)      before     after-F70   final    bun-serve   brust-01x
  D /dex?nocache=1         144,226    …           …        21,730      21,860
  I /team?nocache=1        781        781         781      459         1,004
  S /types                 8,512      …           …        1,669       1,807
rps / p50 / p99 (identity, oha -c 120 -z 10s):  D before … → final …   I before … → final …   (0.1.x same runs: …)
bar F68 line: before `D -56.7% I +2.5%` → final `D … I …`

F70: children.rs instance_needs_link/row_reactive/resolve_row_only; goldens changed: keyed-list-child-job, static-list-child (client.js files deleted);
     pokedex: visible markup + load-bearing directives identical on /, /pokedex, /pokemon/pikachu (snap.sh), bytes … → … / … → … / … → …
F71: projection.rs + jinja `project`; goldens changed: keyed-list, keyed-list-child, nested-list, use-id-row, reactive-list-rows; pokedex identical to F70 (no projectable list)
boundary amendments: crates/brust-jinja/src/lib.rs (+1 filter, isolated; m3p-b touches this crate — rebase note for the lead), assertion edits in packages/brust/test/{e2e,build-manifest}.test.ts + app.expected-manifest.json, tests/server/pokedex.test.ts:91
known byte changes outside the bench: pages whose only link was a static child in a non-reactive row are static now (pokedex HomePage/DetailPage/AppLayout; e2e ItemPage): no host x-data/x-props, no x-text on top-level prop reads, no chunk for the child; `_pN` numbering keeps gaps where a RowOnly link was dropped (no such page in the repo today).
gates: <paste>    reports regenerated: docs/react-coverage.md (65 rows), docs/plans/m1-exit-report.md
ledger text for the lead: F70 DONE — m3p-f-payload (RowOnly links resolved after the walk); F71 DONE — m3p-f-payload (client_prop_projections + `project`; helper/dynamic reads keep the full row)
follow-ups: (1) a props-sourced list with no directive in its row is static even inside a linked child (table-rows precedent, pre-existing) — if a parent re-creates such a child's row, its inner list is not re-bound; (2) projection does not look through a child's own reads when the row is passed whole (keeps the full row); (3) `client_uses` order changed for Always links (only the use named in a server-only-in-client message can differ).
```

## Self-review

**Spec / rule coverage.**
- R1 (static child instance with no behaviour and no reactive prop binding is plain HTML; "linked elsewhere" is not a reason) → Tasks 2–3: `instance_needs_link` + `row_reactive` + `resolve_row_only`; the F66 "linked" set (`pipeline.rs:34-38`) is derived from surviving links, so a child linked by some OTHER page keeps its chunk but THIS instance prints plain because `Node::Component.link` is `None` here (`template.rs:1149,1180`). Named predicate + case table in Task 2; pinned by `static_child_link_decisions`, the fixture goldens and the pokedex snapshot.
- R2 (projected `x-props`; no `x-props` when nothing consumes it; full row on dynamic access) → the "no consumer" half falls out of R1 (the page is static: no host, no seed — `static-list-child`, bench D/S); the projection half is Tasks 4–5 (`projection.rs`, `project`, `host_attrs`), with the fallback rule and its pins (`helper_call_dynamic_index_and_bare_item_are_whole`, `row_passed_whole_to_a_child_is_whole`, `reactive-list-child`).
- R3 (load-bearing pages byte-identical; new fixture pair dual-evaluated) → `snap.sh` load-bearing + visible checks (Tasks 3, 5, 7), the unchanged goldens of `keyed-list-child`/`use-id-row`/`nested-list`/`reactive-list-child`, pokedex + hydrate tests; fixtures `static-list-child` (no `x-*`) and `reactive-list-child` (`x-*` preserved) both carry `sample-props.json` and run under `dual_eval.rs` (the static one pinned in `NO_DIRECTIVES`); battery rows in Task 6.
- R4 (measure D and I before/after under the host lock, identity; D within 10% of 0.1.x; I unchanged; RESULTS regenerated) → Task 3 Step 8 (after F70, discarded), Task 7 Step 3 (full, kept), `BENCH_LOCK_ID` + load guard in Global Constraints; expected D ≈ 21.8 KB from the Evidence section's stripped-body estimate (21,756).
- R5 (lane from `m3p`, no PR, boundary, rebuild addon, commit trailer, no `git add -A`) → Global Constraints; boundary amendments (brust-jinja filter, assertion-only test edits) are declared, not hidden.
- Lead's suggested sites: `template.rs:988` (`inline_root_is_element`), `:1180`, `mod.rs:80-140`, `manifest.ts:255-300` are quoted as consumers and deliberately NOT edited (Architecture); `template.rs:590-610` is edited in Task 5 exactly where the lead pointed (`{all}` stays; the per-root `dict` branch gets the projection).

**Risk ledger.**
1. **Analysis-time `row_reactive` diverging from lowering's `directive_row`.** Both are built from the same arms (`template.rs:851-855`, `:1381-1405`); the only asymmetry is the `Component` arm, where lowering sees the resolved `link` and analysis sees `Always` links plus the candidates it is deciding. A kept `RowOnly` link implies `reactive == true` at that depth, so it can never create a directive row that analysis called static; the reverse (analysis reactive, lowering not) only means an unnecessary link, which is today's behaviour. If a reviewer wants it mechanical: a debug assertion comparing the two over every fixture is a 20-line follow-up in `lower_template.rs` (walk the IR, call `needs_directives`, compare with a re-run of `row_reactive`) — not in this lane's boundary unless asked.
2. **A page's tier flips Native → Static** (pokedex `AppLayout`, `HomePage`, `DetailPage`; e2e `ItemPage`; bench `DexPage`, `TypesPage`): top-level prop reads lose their `x-text`, the host loses `x-data`/`x-props`, the component loses its chunk. Everything that previously depended on those was dead (no state, no handler) — Review Focus 4 pins the two live cases (island + native child under a static layout; `inject_assets` keys the runtime on `any_dynamic` over children and job targets, not on the chain's own chunk). `useId` seeding is per manifest record (`pipeline.rs:634`), tier-independent.
3. **`client_uses` order** changes for `Always` links (the list-source uses are now appended together with the prop uses); only the `server-only-in-client` message's "used by …" clause can name a different use. No fixture pins that text.
4. **`_pN` gaps**: `client.rs:173` names the member from `ChildLink.props_member`; `template.rs:1149-1161` builds the directive from the same string; nothing indexes links by position (`tests/children.rs::parent_counter_links_the_native_child` reads `child_links[0].id`, still `1` there). Pinned by `row_only_links_keep_their_ids`.
5. **Projection correctness** rests on `item_reads` being conservative: every `RawKind` arm is enumerated (compile error on a new variant); `Index`, `Jsx`, `Opaque` with the item captured, `Arrow` block bodies, bare items and call arguments are `Whole`. The key is scanned from the `For` node (not from `client_uses`), and a root read by any non-list use (handler, state init, state-dependent slot, filtered source) is excluded (rule 1). The runtime reads nothing else from `x-props` than `props()` members (`mount.ts:12-17`) and `_idN` (`client.rs:60-63`) — `_idN` are added to the dict after the seed tree (`template.rs:571-575`) and are untouched.
6. **`project` filter vs `m3p-b` (P3)**: the filter uses only the public `Value` API (`kind`, `try_iter`, `get_item`, `from_iter`); if P3 changes map construction, the filter's `Value::from_iter(BTreeMap)` is the one line to revisit. Key order stays sorted, matching today's `json_attr` output of loader objects.
7. **Golden drift** is the loudest failure mode of this lane: each task lists the exact expectation files that may change; `fixtures.rs` deletes stale `client.js` expectations only under `BRUSTC_UPDATE=1` and fails otherwise, so a static flip that the implementer did not intend cannot pass silently.
8. **Bench parity**: `bench/lib/parity.ts` compares tag sequence + text with attributes ignored and `brust-host`/`brust-row` unwrapped; after F70 `<brust-row>` disappears and `<p x-text>` becomes `<p>` — both invisible to parity (`<p>{{ summary }}</p>` is one text node, as Bun.serve's `151<!-- --> Pokémon` is after comment removal). If parity aborts, read its diff before touching any bench app (bench apps are outside the boundary).
