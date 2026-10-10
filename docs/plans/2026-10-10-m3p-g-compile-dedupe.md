# m3p-g-compile-dedupe — one compile per component, chosen by role, not by route order (F75)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p · escalation: lead Detoro via task challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close ledger F75 on lane `lane/m3p-g-compile-dedupe` (from `m3p`). Today `compileApp` keeps the FIRST tree's compile of a component (`packages/brust/src/build/compile.ts:70`, `if (compiled.has(c.id)) continue`). After F70 a stateless route root that another route's stateful parent feeds compiles differently in the two trees, so the stored chunk depends on route order: in one order `/b`'s rows never update, with no server error and no client warning. After this lane the build keeps the compile with the highest role (linked child > unlinked child > route root), the same in every route order. Two child compiles of one component that disagree fail the build with `component-compile-divergent`. Every build output of every existing app stays byte-identical.

**Architecture:** One file changes: `compile.ts`. Each `compileTree` call already compiles its whole tree with its own `ModuleCache` (`crates/brust-compiler/src/pipeline.rs:26`), so the second tree has already produced the component in its own role and nothing is compiled again. The change is only about which compile is kept. A pure, exported `replaces(kept, next)` decides between two compiles of one id and holds the divergence guard. `compileApp` collects one `Seen` per id while it walks the trees, then builds `Compiled` records, logs diagnostics and runs the `outlet-outside-layout` check once every tree is in, so all three read the final record. The kept record is written WHOLE (ir + jinja + clientJs + serverTs from one compile). It is never a splice of two compiles: see Ruling notes R1 for why that is correct and why route A's page then renders the linked jinja. No Rust change, no `manifest.ts` change, no change to `app.expected-manifest.json`.

**Tech Stack:** Bun canary (`bun test`, `bun check` = `bun run typecheck` in `packages/brust`), the napi addon `packages/brust/native/brust.<platform>.node` (debug build), Playwright Chromium from the `tests/server` workspace for the one-off proof in Task 3 (not committed).

**Spec:** ledger row F75 in `docs/plans/m1a-followups.md:139` (ruling + regression). Also `docs/plans/2026-10-10-m3p-f-payload.md` (F70: `props_reactive = !ctx.is_root || …`, `crates/brust-compiler/src/analyze/passes/children.rs:33-40`), `docs/design/2026-10-09-m2-server-design.md` contract 5 (`outlet-outside-layout`) and contract 9 (per-file compile, `Err` = build error), and `packages/brust/README.md:39-42` (build errors print `error <rule> <message>`, exit 1).

## Ruling notes (lead: R1-R4 ACCEPTED 2026-10-10, Detoro — supersedes the F75 "each route keeps its own jinja" clause)

- **R1: jinja. Keep the non-root compile's jinja too, not "each route keeps its own jinja".** A component's own template is rendered only when the component is a chain entry. `Renderer::render_chain_value` (`crates/brust-server/src/render.rs:100-125`) is the only production render path (`crates/brust-server/src/pipeline.rs:672`). A parent never includes a child's template: it inlines the child's markup at lowering time (`crates/brust-compiler/src/lower/template.rs:1188`, `Printer::new(child_ir, self.ctx, Some(inline), …)`). The manifest has one template per id (`packages/brust/src/build/manifest.ts:229`, `jinja/${c.id}.jinja`; `packages/brust/src/build/index.ts:145`). `inject_assets` (`render.rs:133-170`) decides scripts from the id's `tier`/`client`/`children`, which come from the kept IR. "Route A keeps the root jinja" with one id would therefore pair the non-root record's `tier: native`, chunk and F66 children with a template that has no host. Route A would download the runtime and two chunks that mount nothing. The only way to keep route A's F70 bytes is a second component id for the root variant. That needs `manifest.ts`, `routeComponent` and the expected manifest to change, which is a boundary amendment and is not planned. **Evidence that the non-root jinja is correct as a chain root:** today's unfixed build in order B,A already serves `/a` from the non-root record (`list` = native, chunk, `x-data` host). Chromium renders `["Ann","Bob"]` with zero console errors or warnings, and `/b` reorders. **Cost:** route A carries the host directives and chunk it carried before F70, but only for a component that is also linked elsewhere. No such component exists in the repo today (see Evidence §3).
- **R2: the divergence rule cannot be "any two non-root compiles differ".** The regression fixture itself would fail the build. In it, `Row` is a non-root child in BOTH trees. Its IR is identical, but its jinja and clientJs differ, because only the Board tree links it: `pipeline.rs:34-38` (`linked_ids`) feeds `template.rs:106` (`native: !Static || linked`) and `lower/mod.rs:134` (no chunk for an unlinked Static). The rule this plan implements:
  - two child compiles must agree on `ir` and `serverTs`;
  - two child compiles of the same role must agree on everything;
  - the chunk-bearing child compile (`clientJs !== undefined`) wins over the chunk-less one;
  - any child compile wins over the root compile, and a root compile is never compared, because F70 makes it legitimately different.
- **R3: the guard cannot fire on today's compiler.** A child's analysis inputs are its source, the shared `AnalyzeOptions`, `is_root` (always false below a root: `crates/brust-compiler/src/analyze/modules.rs:48-54,159`) and its own children's IRs. Its IR therefore depends only on its own subtree. Lowering adds one tree-dependent input, `linked(id)`, and R2's ranking absorbs it. So the guard is a fail-closed check against future compiler regressions, and it is tested through the pure `replaces()` with synthetic compiles. It does not use `mock.module`, which leaks across the whole Bun suite.
- **R4: gate list.** The root `package.json` has no `ci` script (scripts: `bun-codegen`, `battery`, `browser-test`, `server-test`, `bench`, `m2-exit`, `bench:test`), and `.github/workflows/ci.yml` has no biome or lint step. `bun run ci` is therefore dropped from the gates. The TS check for this lane is `cd packages/brust && bun run typecheck` (CI step `ci.yml:118`).
- **Side finding for the ledger (not this lane):** spreading a state value inside a handler compiles to a spread of the signal itself. `setItems([...items].reverse())` emits `items.set(([...items]).reverse())`, which throws `pageerror e is not iterable` in Chromium (the IR keeps it as `Opaque` with `captures: [["items","State"]]`). The fixture uses `items.slice().reverse()` to stay clear of it.

## Global Constraints

- Lane: `cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-g-compile-dedupe -b lane/m3p-g-compile-dedupe m3p`. All work happens in `/Users/detoro/code/brust-lane-m3p-g-compile-dedupe`. The base is `m3p` (today `05e3b77`; never `main`, never `v2`). Run `bun install --frozen-lockfile` there once (node_modules is per worktree).
- NO PR. When done, post READY on the Conclave task (Task 3 Step 5); the lead merges into `m3p`.
- Boundary: `packages/brust/src/build/compile.ts`, `packages/brust/test/build-compile.test.ts`, and the new dir `packages/brust/test/fixtures/shared-root/` (`Row.tsx`, `List.tsx`, `Board.tsx`, `routes-ab.tsx`, `routes-ba.tsx`). Nothing else. Specifically NOT `packages/brust/src/build/manifest.ts` or `packages/brust/test/fixtures/app.expected-manifest.json`: the evidence shows no existing app changes, so the expected manifest must stay byte-identical, and any diff there is a bug in the lane. Do not touch any Rust crate. Do not touch `crates/brust-server`, `crates/brust-jinja` or `packages/brust/src/worker.ts`: lane `m3p-b-value-path` (Dew) is editing them concurrently.
- The `.node` addon is gitignored, so a fresh worktree has none: run `cd packages/brust && bun run build:debug` once before any TS test. No Rust changes here, so one build is enough.
- Never `git add -A`; stage files by name. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests that build into `dist` inside a fixture dir clean up after themselves. After every test run, `git status --short` must list only the boundary files.
- Gates (all green before the code commit and in full before READY; this mirrors the TS part of `.github/workflows/ci.yml:115-130`, see R4): `cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts` · `cd examples/pokedex && bun test && bun run typecheck` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` (each server-starting file alone, as CI does). Plus, not in CI but cheap and on the F66 path this lane touches: `cd packages/brust && bun test --timeout 120000 test/e2e-child-chunks.test.ts`.
- Do not re-decide: there is no recompilation, and there are no per-route template variants (R1). The ranking is root < child < chunkChild (R2). The guard compares raw strings (`c.ir` exactly as the napi layer returns it, before `JSON.parse`). That serialisation is deterministic, as Evidence §3 shows: identical strings across trees for every shared id in five apps.

## Review Focus

1. **Order independence (the defect).** For every component id, the kept record must be the same whichever route is declared first. Pinned by the `build-compile.test.ts` test "F75: a route root another route links as a child keeps the linked compile, in both route orders": all of ir/jinja/clientJs/serverTs equal across `routes-ab.tsx` and `routes-ba.tsx`, and every member that Board's template drives on List's rows (`_l1`, `_k1`, `_p1`) is in List's stored chunk. The test "F75: the manifest is the same in both route orders …" pins it through `runBuild`. The one-off Chromium proof in Task 3 shows `/b` reordering in both orders.
2. **Byte identity everywhere else.** An app with no component reached by two trees in different roles must build exactly as before: same `Compiled` map, same insertion order, same warnings in the same order. Pinned by the unchanged `app.expected-manifest.json` (`build-manifest.test.ts`), `e2e.test.ts`, the pokedex tests, and Evidence §3 (a scratch run of the fixed `compileApp` over `test/fixtures/{app,shapes,child-chunks}`, `examples/pokedex` and `bench/apps/brust` gave identical artifacts and warnings). Reviewer bar: any diff in the expected manifest is a blocker.
3. **Guard false positives.** `component-compile-divergent` must not fire for a child that only some trees link. The fixture's `Row` is exactly that case, so test 1 would throw if the rule were naive. The `replaces()` table pins both directions plus the three divergent shapes (different IR, same role with different clientJs, different serverTs). The thrown error is checked with try/catch + `toMatchObject({ rule, message })`, not `toThrow()`.
4. **Diagnostics are logged once per id**, from the kept compile, after all trees, in first-seen order. `Map.set` on an existing key keeps the key's place, so for apps without shared ids the order equals today's.
5. **`outlet-outside-layout` reads the final record.** It moves after the tree loop. `rootIdOfFile` and `routeComponent` are unaffected, because ids are role-independent (the same `list_2a5d4375` in both trees). Pinned by the existing `bad/outlet-leaf` case in `build-compile.test.ts` and by `cli.test.ts`.

## Dispatch table

Lane tier: **routine** implementation (knock2), **standard** review (Afrojack).

| slug-task | tier | role | deps | acceptance |
|---|---|---|---|---|
| `m3p-g-compile-dedupe-1` fixture + red tests | routine | implementer (knock2) | lane created from `m3p` | `packages/brust/test/fixtures/shared-root/` (5 files) created; the 2 new order tests in `build-compile.test.ts` FAIL on unfixed `compile.ts` with the outputs in Task 1 Step 4 (`Received: []`; `Received value must be a string: null`); the 4 pre-existing tests still pass; `bun run typecheck` green; no commit yet |
| `m3p-g-compile-dedupe-2` keep-by-role + divergence guard | routine | implementer (knock2) | task 1 | `compile.ts` as in Task 2; `bun test test/build-compile.test.ts` → `7 pass 0 fail`; `bun test test/build-manifest.test.ts` → `4 pass 0 fail` with `app.expected-manifest.json` untouched; `git status --short` lists only the boundary files; one commit `fix(build): keep one compile per component by role, not route order (F75)` |
| `m3p-g-compile-dedupe-3` gates + proof + READY | routine | implementer (knock2) | task 2 | full gate list green (last line of each run pasted); one-off Chromium proof prints `/b rows ["Ann","Bob"] -> ["Bob","Ann"]` for `ab` AND `ba` with `console []`; `git status --short` clean; READY note posted |
| review | standard | reviewer (Afrojack) | task 3 | Review Focus 1-5 checked against the diff; R1-R3 confirmed or challenged by the lead before merge |

## File structure

```
packages/brust/src/build/compile.ts            ROLE / Role / Seen / roleOf / replaces (exported); compileApp keeps one Seen per id by role,
                                               then builds Compiled records, logs diagnostics and checks outlet-outside-layout after every tree
packages/brust/test/build-compile.test.ts      +3 tests: both route orders compile the same; manifest via runBuild in both orders; replaces() table
packages/brust/test/fixtures/shared-root/      NEW: Row.tsx (static child), List.tsx (stateless list: root on /a, linked child on /b),
                                               Board.tsx (stateful parent), routes-ab.tsx, routes-ba.tsx (same routes, opposite order)
```

---

### Evidence the lane starts from (captured 2026-10-10 on m3p @ 05e3b77, debug addon built 10:59 after da02287)

**§1 Artifacts of the shared component in both roles.** Scratch copy of the fixture below, `compileApp` run directly (same code path as `build-compile.test.ts`):

```
order A,B (List tree first):           order B,A (Board tree first):
list_2a5d4375 Static  client false     board_0a82bb94 Native client true
row_bfc3b365  Static  client false     list_2a5d4375  Native client true
board_0a82bb94 Native client true      row_bfc3b365   Static client true
```

`diff -r out-ab out-ba` (trimmed):
- `list.ir.json`:
  - `"tier": "Static"` → `"Native"`;
  - the `For` row's `Component Row` `"link": null` → `"link": 1`;
  - `"child_links": []` → one link `{ id: 1, child: "row_bfc3b365", props_member: "_p1", item_scoped: ["it"], props: [["name", it.name]] }`;
  - `"client_props": []` → `["items"]`;
  - `client_prop_projections` absent → `{ "items": ["id", "name"] }`.
- `list.jinja`, root: `<ul>{% for it in items %}…<li>{{ (it["name"]) | e }}</li>{% endfor %}</ul>`. Non-root: `<ul x-data="list_2a5d4375" x-props='{{ {"items": ((items) | project("id", "name"))} | json_attr }}'>{% for it in items %}…<brust-row style="display:contents" x-for="it in _l1 by _k1"><li x-data="row_bfc3b365" x-props='…' x-props-bind="_p1:it" x-text="_c1">…`.
- `list.client.js`: `<none>` (root) vs the linked chunk `const _l1 = computed(() => props().items)`, `const _k1 = (it) => it.id`, `const _p1 = (it) => ({ name: it.name })`, `return { _l1, _k1, _p1 }`.
- `row.ir.json`: **identical**. `row.jinja`: `<li>{{ name | e }}</li>` vs `<li x-data="row_bfc3b365" x-props='{{ {"name": name} | json_attr }}' x-text="_c1">…`. `row.client.js`: `<none>` vs `return { _c1 }`. Row is non-root in both trees; only the Board tree links it (R2).
- `*.server.ts`: none in either order (no jobs). `board.*`: identical.

**§2 The freeze, end to end** (`brust build` + `brust start --workers 1` + Chromium, unfixed `m3p`):

```
A,B  manifest: list static client null; row static client null; board children []
     /b scripts: runtime + board only   rows ["Ann","Bob"] -> click reverse -> ["Ann","Bob"]   console []   ← frozen, silent
B,A  manifest: list native client/list_…js; row static client/row_…js; board children [list, row]
     /a scripts: runtime + list + row   rows ["Ann","Bob"]                                     console []
     /b scripts: runtime + board + list + row   ["Ann","Bob"] -> ["Bob","Ann"]                  console []
```

The bad order shows no `no such member` warning either: List's chunk is absent, so its `x-data` host never mounts, and the warning in `packages/runtime-dom/src/props-bind.ts:25` is never reached. With the fixed `compile.ts` (Task 2 code, scratch copy) both orders print the B,A lines, and `jq -S .components dist/manifest.json` is identical across orders.

**§3 No existing app has a diverging shared component.** A probe compiled every route-root tree and compared, per id, the artifacts across trees:

```
test/fixtures/app           trees=3 ids=5  multi-tree=0 diverging=0
test/fixtures/shapes        trees=1 ids=3  multi-tree=0 diverging=0
test/fixtures/child-chunks  trees=2 ids=6  multi-tree=1 diverging=0
test/fixtures/safety/*      (5 apps)       multi-tree=0 diverging=0
examples/pokedex            trees=6 ids=14 multi-tree=1 diverging=0
bench/apps/brust            trees=4 ids=6  multi-tree=1 diverging=0
```

The fixed `compileApp` (scratch) gives byte-identical `ir`/`jinja`/`clientJs`/`serverTs` for every id and the same warning lines in the same order on `app`, `shapes`, `child-chunks`, `examples/pokedex` and `bench/apps/brust`. With the fixed code, the existing `build-compile.test.ts` (4) + `build-manifest.test.ts` (4, incl. the pinned expected manifest) passed, and so did the three new tests.

**§4 Who decides what (HEAD 05e3b77):**
- `compile.ts:61-87` compiles a route file once (`rootIdOfFile`), and `:70` keeps the first compile of each id.
- `pipeline.rs:26` gives each tree a fresh `ModuleCache`; `:46-60` puts the root first, then children by module key (`modules.rs:34-45`, sorted).
- `component.rs:115` `set_root` → `PassCtx.is_root` (`modules.rs:159`) → `children.rs:36` `props_reactive`.
- `pipeline.rs:34-38` builds the linked set → `lower/mod.rs:134` (chunk iff `!Static || linked`) and `template.rs:106` (host directives iff `!Static || linked`).

---

### Task 1: Fixture and red tests

**Files:**
- Create: `packages/brust/test/fixtures/shared-root/{Row.tsx,List.tsx,Board.tsx,routes-ab.tsx,routes-ba.tsx}`
- Modify: `packages/brust/test/build-compile.test.ts` (imports at lines 2 and 6; append two tests at the end, after line 76)
- Read first: `packages/brust/src/build/compile.ts` (whole file, 97 lines), `packages/brust/test/fixtures/child-chunks/routes.tsx` (fixture conventions)

- [ ] **Step 1: Create the lane, install, build the addon**
```bash
cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-g-compile-dedupe -b lane/m3p-g-compile-dedupe m3p
cd /Users/detoro/code/brust-lane-m3p-g-compile-dedupe && git log --oneline -1     # 05e3b77 or a later m3p commit
bun install --frozen-lockfile
cd packages/brust && bun run build:debug && ls native/*.node && cd ../..
```
Expected: `native/brust.darwin-arm64.node` (or your platform) exists.

- [ ] **Step 2: The fixture.** `packages/brust/test/fixtures/shared-root/Row.tsx`:
```tsx
// Stateless: a static child fed one row of List.
export default function Row(props: { name: string }) {
  return <li>{props.name}</li>
}
```
`packages/brust/test/fixtures/shared-root/List.tsx`:
```tsx
// Ledger F75: a stateless route ROOT on /a (fixed props: F70 drops its row links) and a LINKED
// child of Board on /b (props change on the client: rows are x-for rows driven by _l1/_k1/_p1).
import Row from './Row'

export default function List(props: { items: { id: string; name: string }[] }) {
  return (
    <ul>
      {props.items.map((it) => (
        <Row key={it.id} name={it.name} />
      ))}
    </ul>
  )
}
```
`packages/brust/test/fixtures/shared-root/Board.tsx` (`items.slice().reverse()`, not `[...items]`, see the side finding in Ruling notes):
```tsx
// Stateful parent: feeds List a state value, so List's rows must stay re-creatable on /b.
import { useState } from 'react'
import List from './List'

export default function Board(props: { items: { id: string; name: string }[] }) {
  const [items, setItems] = useState(props.items)
  return (
    <section>
      <button onClick={() => setItems(items.slice().reverse())}>reverse</button>
      <List items={items} />
    </section>
  )
}
```
`packages/brust/test/fixtures/shared-root/routes-ab.tsx`:
```tsx
// F75 regression, order A,B: the List tree (List as root) compiles before the Board tree.
import { defineRoutes } from '@brust/core/routes'
import Board from './Board'
import List from './List'

const items = async () => ({ items: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }] })

export const routes = defineRoutes([
  { path: '/a', Component: List, loader: items },
  { path: '/b', Component: Board, loader: items },
])
```
`packages/brust/test/fixtures/shared-root/routes-ba.tsx`:
```tsx
// F75 regression, order B,A: the Board tree (List as linked child) compiles first.
import { defineRoutes } from '@brust/core/routes'
import Board from './Board'
import List from './List'

const items = async () => ({ items: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }] })

export const routes = defineRoutes([
  { path: '/b', Component: Board, loader: items },
  { path: '/a', Component: List, loader: items },
])
```

- [ ] **Step 3: The two order tests.** In `packages/brust/test/build-compile.test.ts`, change line 2 to `import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'` and line 6 to `import { type Compiled, compileApp } from '../src/build/compile'`. Then append at the end of the file:
```ts
// F75: List is a stateless route root on /a and a linked child of the stateful Board on /b.
const sharedRoot = join(import.meta.dir, 'fixtures/shared-root')
async function compileOrder(entry: string) {
  const { routes, componentFile } = await scanRoutes(join(sharedRoot, entry))
  return compileApp({
    appRoot: sharedRoot,
    leaves: flattenRoutes(routes).leaves,
    componentFile,
    runtimeImport: '/_brust/client/runtime-test.js',
    serverOnly: [],
    log: () => {},
  })
}
const named = (m: Map<string, Compiled>, name: string) => [...m.values()].find((c) => c.id.startsWith(`${name}_`))!
/** The members a client chunk's behaviour returns (`return { _l1, _k1, _p1 }`). */
const members = (js: string | undefined) => /return \{ ([^}]*) \}/.exec(js ?? '')?.[1]?.split(', ') ?? []

test('F75: a route root another route links as a child keeps the linked compile, in both route orders', async () => {
  const ab = await compileOrder('routes-ab.tsx')
  const ba = await compileOrder('routes-ba.tsx')
  for (const { compiled } of [ab, ba]) {
    const [list, row, board] = [named(compiled, 'list'), named(compiled, 'row'), named(compiled, 'board')]
    // Every member Board's template drives on List's rows is in List's stored chunk.
    const driven = [
      ...new Set(
        [...board.jinja.matchAll(/x-for="\w+ in (\w+) by (\w+)"|x-props-bind="(\w+):/g)].flatMap((m) =>
          m.slice(1).filter((x): x is string => x !== undefined),
        ),
      ),
    ]
    expect(driven.sort()).toEqual(['_k1', '_l1', '_p1'])
    expect(members(list.clientJs)).toEqual(expect.arrayContaining(driven))
    expect(members(row.clientJs)).toEqual(['_c1']) // Row's x-text in Board's rows
    // /a renders the same record: List is its own host (the pre-F70 shape), not plain rows.
    expect(list.ir.tier).toBe('Native')
    expect(list.jinja).toContain(`x-data="${list.id}"`)
  }
  expect([...ba.compiled.keys()].sort()).toEqual([...ab.compiled.keys()].sort())
  for (const [id, a] of ab.compiled) {
    const b = ba.compiled.get(id)!
    expect([b.ir, b.jinja, b.clientJs, b.serverTs]).toEqual([a.ir, a.jinja, a.clientJs, a.serverTs])
  }
})

test('F75: the manifest is the same in both route orders and links List + Row chunks on /a and /b', async () => {
  const comps: unknown[] = []
  for (const entry of ['routes-ab.tsx', 'routes-ba.tsx']) {
    const out = mkdtempSync(join(tmpdir(), 'brust-f75-'))
    try {
      await runBuild({ appRoot: sharedRoot, entry, outDir: out, log: () => {} })
      const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
      const id = (name: string) => Object.keys(m.components).find((k) => k.startsWith(`${name}_`))!
      expect(m.components[id('list')].client).toMatch(/^client\/list_/)
      expect(m.components[id('row')].client).toMatch(/^client\/row_/)
      // biome-ignore lint/suspicious/noExplicitAny: manifest JSON
      expect(m.components[id('board')].children.map((c: any) => c.id).sort()).toEqual([id('list'), id('row')])
      comps.push(m.components)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
  expect(comps[1]).toEqual(comps[0])
}, 60_000)
```

- [ ] **Step 4: Run and see red**
```bash
cd packages/brust && bun run typecheck && bun test test/build-compile.test.ts 2>&1 | grep -E '^\((pass|fail)\)|^error|Received' ; cd ../.. && git status --short
```
Expected: typecheck `✓ No type errors`. The 4 old tests `(pass)`, plus:
```
error: expect(received).toEqual(expected)
Received: []
(fail) F75: a route root another route links as a child keeps the linked compile, in both route orders
error: Received value must be a string: null
(fail) F75: the manifest is the same in both route orders and links List + Row chunks on /a and /b
```
(In order A,B, List's stored compile is the root one, which has no chunk: `members(undefined)` is `[]` and `components[list].client` is `null`.) `git status --short`: `M packages/brust/test/build-compile.test.ts` and `?? packages/brust/test/fixtures/shared-root/`. No commit: Task 2 commits the fix and the tests together, so every commit on the lane is green.

---

### Task 2: Keep one compile per id by role; divergence guard

**Files:**
- Modify: `packages/brust/src/build/compile.ts`. Lines 1-5: header comment and import. Lines 35-97 (`type Diag` through the end of `compileApp`) are replaced.
- Modify: `packages/brust/test/build-compile.test.ts`. Line 6 import; a `CompiledComponent` type import; one more test appended.

**Interfaces (exported, used by the test only):** `ROLE`, `type Role`, `interface Seen`, `roleOf(c, first)`, `replaces(kept, next): boolean` (throws `BuildError('component-compile-divergent', …)`). `compileApp`'s signature and return type are unchanged.

- [ ] **Step 1: Header and import.** Replace lines 1-5 of `compile.ts` with:
```ts
// Per-file compile (plan T5, contract 9): every route Component goes through
// `compileTree` (analysis + lowering of its whole tree). `Err` = build error; fallback and
// warning diagnostics are logged; `outlet-outside-layout` is raised here (contract 5).
// A component several trees reach keeps one compile, chosen by role, not by route order (F75).
import { relative } from 'node:path'
import { type CompiledComponent, type CompiledTree, compileTree } from '../../native/index.js'
```
(`CompiledComponent` is already exported by `packages/brust/native/index.d.ts:24`.) HEAD lines 6-34 (the `../routes` and `./errors` imports, `ComponentIR`, `Compiled`) stay as they are.

- [ ] **Step 2: Replace everything from `type Diag =` (line 35 at HEAD, line 36 after Step 1's added comment line) to the end of the file** with:
```ts
type Diag = NonNullable<CompiledTree['error']>
const where = (file: string, d: Diag) => `${file}:${d.line}:${d.col}`

/** How a tree reached a component (F75). A route root's props are fixed, so after F70 it may drop
 * the row links a parent elsewhere drives; a child that no parent in its tree links may have no
 * chunk. A higher role's artifacts are a superset of a lower one's: the build keeps the highest. */
export const ROLE = { root: 0, child: 1, chunkChild: 2 } as const
export type Role = (typeof ROLE)[keyof typeof ROLE]

/** One compile of a component: its role, the tree (route-root file, app-relative) that made it. */
export interface Seen {
  role: Role
  tree: string
  c: CompiledComponent
}

export const roleOf = (c: CompiledComponent, first: boolean): Role =>
  first ? ROLE.root : c.clientJs === undefined ? ROLE.child : ROLE.chunkChild

/** Whether `next` (same id, a later tree) replaces `kept`. A child's IR depends only on its own
 * subtree, so two child compiles must agree on `ir` and `serverTs`, and two of the same role on
 * everything; anything else is `component-compile-divergent` (a compiler bug, never route order). */
export function replaces(kept: Seen, next: Seen): boolean {
  if (kept.role !== ROLE.root && next.role !== ROLE.root) {
    const [k, n] = [kept.c, next.c]
    const same =
      k.ir === n.ir &&
      k.serverTs === n.serverTs &&
      (kept.role !== next.role || (k.jinja === n.jinja && k.clientJs === n.clientJs))
    if (!same)
      throw new BuildError(
        'component-compile-divergent',
        `${n.id} (${n.source}) compiles differently as a child in ${kept.tree} and in ${next.tree}`,
      )
  }
  return next.role > kept.role
}

export function compileApp(opts: {
  appRoot: string
  leaves: FlatRoute[]
  componentFile: Map<Function, string>
  runtimeImport: string
  serverOnly: string[]
  log: (s: string) => void
}): { compiled: Map<string, Compiled>; routeComponent: Map<string, string> } {
  const { appRoot, leaves, componentFile } = opts
  const seen = new Map<string, Seen>()
  const rootIdOfFile = new Map<string, string>()
  const routeComponent = new Map<string, string>()
  // Route nodes with a Component, by id (a layout appears in several chains: once is enough).
  const nodes = new Map<string, Route>()
  for (const l of leaves) l.chain.forEach((r, i) => r.Component && nodes.set(l.chainIds[i]!, r))

  for (const [routeId, route] of nodes) {
    const file = componentFile.get(route.Component!)
    if (!file)
      throw new BuildError(
        'component-source',
        `${route.Component!.name || '(anonymous)'} is not a default import of a .tsx file (route ${routeId})`,
      )
    let rootId = rootIdOfFile.get(file)
    if (!rootId) {
      const rel = relative(appRoot, file)
      const tree = compileTree(rel, appRoot, opts.runtimeImport, opts.serverOnly)
      if (tree.error) throw new BuildError(tree.error.rule, `${where(rel, tree.error)} ${tree.error.message}`)
      for (const [i, c] of tree.components.entries()) {
        // A lowering Error that came back as a diagnostic is a build error too (contract 9).
        const err = c.diagnostics.find((d) => d.class === 'error')
        if (err) throw new BuildError(err.rule, `${where(c.source, err)} ${err.message}`)
        const next: Seen = { role: roleOf(c, i === 0), tree: rel, c }
        const kept = seen.get(c.id) // a child reached from several trees, or a root another tree reaches
        if (!kept || replaces(kept, next)) seen.set(c.id, next)
      }
      rootId = tree.components[0]!.id // the root comes first (pipeline.rs)
      rootIdOfFile.set(file, rootId)
    }
    routeComponent.set(routeId, rootId)
  }

  // Every tree is in: the kept compile is final. Map order = first sight (`set` keeps a key's place).
  const compiled = new Map<string, Compiled>()
  for (const { c } of seen.values()) {
    for (const d of c.diagnostics)
      if (d.class === 'fallback' || d.class === 'warning') opts.log(`warning ${d.rule} ${where(c.source, d)} ${d.message}`)
    const ir = JSON.parse(c.ir) as ComponentIR
    ir.use_id_slots ??= 0
    ir.uses_outlet ??= false
    ir.instances ??= []
    compiled.set(c.id, {
      id: c.id,
      file: `${appRoot}/${c.source}`,
      ir,
      jinja: c.jinja,
      serverTs: c.serverTs,
      clientJs: c.clientJs,
    })
  }
  for (const [routeId, route] of nodes) {
    const rootId = routeComponent.get(routeId)!
    if (compiled.get(rootId)!.ir.uses_outlet && !route.children)
      throw new BuildError(
        'outlet-outside-layout',
        `${route.Component!.name || rootId} renders <Outlet/> but route ${routeId} has no children`,
      )
  }
  return { compiled, routeComponent }
}
```
What changed relative to HEAD:
- (a) `compiled.has(c.id)` / `continue` becomes `seen` + `replaces`;
- (b) the error-diagnostic check still runs for every compile of every tree, before any keep decision;
- (c) `Compiled` records are built once per id after every tree, so `JSON.parse` runs once per id instead of once per first sight;
- (d) warnings are logged from the kept compile only;
- (e) the `outlet-outside-layout` loop moves after the tree loop with an unchanged message.

- [ ] **Step 3: The `replaces()` table.** In `build-compile.test.ts` change line 6 to `import { type Compiled, compileApp, ROLE, type Role, replaces, type Seen } from '../src/build/compile'`, add `import type { CompiledComponent } from '../native/index.js'` after the `node:path` import (line 4), and append:
```ts
test('F75: replaces() keeps a child over a root and a chunk over none; disagreeing child compiles fail', () => {
  const seen = (role: Role, tree: string, o: Partial<CompiledComponent> = {}): Seen => ({
    role,
    tree,
    c: { id: 'x_1', source: 'X.tsx', ir: '{"tier":"Static"}', jinja: '<p></p>', diagnostics: [], ...o },
  })
  const linked = { jinja: '<p x-data="x_1"></p>', clientJs: 'js' }
  const native = { ir: '{"tier":"Native"}', jinja: '<p x-data="x_1"></p>', clientJs: 'js' }
  const thrown = (f: () => unknown) => {
    try {
      f()
    } catch (e) {
      return e
    }
    return 'did not throw'
  }
  // A root may differ from a child compile (F70): the child wins whichever tree came first.
  expect(replaces(seen(ROLE.root, 'X.tsx'), seen(ROLE.chunkChild, 'P.tsx', native))).toBe(true)
  expect(replaces(seen(ROLE.chunkChild, 'P.tsx', native), seen(ROLE.root, 'X.tsx'))).toBe(false)
  // Same IR, linked in one tree only: the chunk-bearing compile wins either way round.
  expect(replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.chunkChild, 'B.tsx', linked))).toBe(true)
  expect(replaces(seen(ROLE.chunkChild, 'B.tsx', linked), seen(ROLE.child, 'A.tsx'))).toBe(false)
  // Identical child compiles: the first stays.
  expect(replaces(seen(ROLE.chunkChild, 'A.tsx', linked), seen(ROLE.chunkChild, 'B.tsx', linked))).toBe(false)
  // Two child compiles with different IR, or the same role with different artifacts: divergent.
  expect(thrown(() => replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.chunkChild, 'B.tsx', native)))).toMatchObject({
    rule: 'component-compile-divergent',
    message: 'x_1 (X.tsx) compiles differently as a child in A.tsx and in B.tsx',
  })
  expect(thrown(() => replaces(seen(ROLE.chunkChild, 'A.tsx', linked), seen(ROLE.chunkChild, 'B.tsx', { ...linked, clientJs: 'other' })))).toMatchObject({
    rule: 'component-compile-divergent',
  })
  expect(thrown(() => replaces(seen(ROLE.child, 'A.tsx'), seen(ROLE.child, 'B.tsx', { serverTs: 'job' })))).toMatchObject({
    rule: 'component-compile-divergent',
  })
})
```

- [ ] **Step 4: Green**
```bash
cd packages/brust && bun run typecheck && bun test test/build-compile.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts; cd ../.. && git status --short
```
Expected: `✓ No type errors`. `build-compile.test.ts`: `7 pass 0 fail`. `build-manifest.test.ts`: `4 pass 0 fail`, which proves `app.expected-manifest.json` is still byte-identical. `cli.test.ts` all pass. `git status --short` lists exactly `M packages/brust/src/build/compile.ts`, `M packages/brust/test/build-compile.test.ts` and `?? packages/brust/test/fixtures/shared-root/`.

- [ ] **Step 5: Prove the test is the red/green pin.** Run `git stash push packages/brust/src/build/compile.ts`. Running `bun test test/build-compile.test.ts` then fails to load the file (the `ROLE`/`replaces` imports do not exist), which is expected. Run `git stash pop` and confirm `7 pass` again. The behavioural red was shown in Task 1 Step 4.

- [ ] **Step 6: Commit**
```bash
git add packages/brust/src/build/compile.ts packages/brust/test/build-compile.test.ts packages/brust/test/fixtures/shared-root/Row.tsx packages/brust/test/fixtures/shared-root/List.tsx packages/brust/test/fixtures/shared-root/Board.tsx packages/brust/test/fixtures/shared-root/routes-ab.tsx packages/brust/test/fixtures/shared-root/routes-ba.tsx
git commit -m "fix(build): keep one compile per component by role, not route order (F75)

A stateless route root that another route's stateful parent links compiled
differently per tree after F70; the first tree's compile won, so in one route
order the linked parent's rows froze with no error. compileApp now keeps the
highest-role compile (linked child > unlinked child > root) whole, logs the
kept compile's diagnostics once and checks outlet-outside-layout after every
tree. Two child compiles that disagree on ir/serverTs (or on anything, same
role) fail with component-compile-divergent.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline m3p..HEAD     # 1 commit
```

---

### Task 3: Gates, Chromium proof, READY

**Files:** none modified.

- [ ] **Step 1: Full gate list** (paste the last line of each run in the note):
```bash
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && bun test --timeout 120000 test/e2e-child-chunks.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
git status --short       # empty
```
If Chromium is missing locally: `bunx playwright install chromium` (CI: `ci.yml:128`). If `hydrate.chromium.test.ts` or `pokedex.test.ts` fails, compare with a run on `m3p` first. The pokedex build has no diverging component (Evidence §3), so this lane cannot change its output.

- [ ] **Step 2: One-off Chromium proof (NOT committed).** Write this to `<your scratchpad>/f75-chromium.ts`:
```ts
// One-off F75 proof (not committed). Usage: bun f75-chromium.ts <laneRoot>
// Builds packages/brust/test/fixtures/shared-root in both route orders, starts each, and in Chromium
// clicks "reverse" on /b (rows must reorder) and loads /a (rows render); prints console errors/warnings.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
const lane = process.argv[2]!
const { chromium } = await import(Bun.resolveSync('playwright', join(lane, 'tests/server')))
const bin = join(lane, 'packages/brust/bin/brust')
const app = join(lane, 'packages/brust/test/fixtures/shared-root')
const browser = await chromium.launch()
for (const order of ['ab', 'ba']) {
  const [entry, dist] = [`routes-${order}.tsx`, `dist-${order}`]
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(b.stderr.toString())
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--entry', entry, '--dist-dir', dist], { cwd: app, env, stdout: 'pipe', stderr: 'ignore' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(out)
    out += new TextDecoder().decode(value)
  }
  void (async () => { for (;;) if ((await reader.read()).done) return })()
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  for (const path of ['/a', '/b']) {
    const page = await browser.newPage()
    const msgs: string[] = []
    page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(m.text()) })
    page.on('pageerror', (e: Error) => msgs.push(`pageerror ${e.message}`))
    await page.goto(base + path, { waitUntil: 'load' })
    await page.waitForTimeout(300)
    const before = await page.locator('li').allTextContents()
    if (path === '/b') { await page.getByRole('button', { name: 'reverse' }).click(); await page.waitForTimeout(300) }
    const after = await page.locator('li').allTextContents()
    console.log(`${order} ${path} rows ${JSON.stringify(before)} -> ${JSON.stringify(after)} console ${JSON.stringify(msgs)}`)
    await page.close()
  }
  proc.kill('SIGINT')
  await proc.exited
  rmSync(join(app, dist), { recursive: true, force: true })
}
await browser.close()
```
Run it against the lane:
```bash
bun <your scratchpad>/f75-chromium.ts /Users/detoro/code/brust-lane-m3p-g-compile-dedupe 2>&1 | grep -v INFO
git status --short       # empty (the script removes dist-ab / dist-ba)
```
Expected (verified on a scratch copy of the Task 2 code):
```
ab /a rows ["Ann","Bob"] -> ["Ann","Bob"] console []
ab /b rows ["Ann","Bob"] -> ["Bob","Ann"] console []
ba /a rows ["Ann","Bob"] -> ["Ann","Bob"] console []
ba /b rows ["Ann","Bob"] -> ["Bob","Ann"] console []
```
On unfixed `m3p` the second line reads `ab /b rows ["Ann","Bob"] -> ["Ann","Bob"] console []` (frozen, silent).

- [ ] **Step 3: Ledger.** Do NOT edit `docs/plans/m1a-followups.md`; the lead closes F75 at merge. Put the closing text in the READY note.

- [ ] **Step 4: Self-check against Review Focus.** Run `git diff m3p..HEAD --stat`: exactly 7 files, all inside the boundary, with no `manifest.ts` and no `app.expected-manifest.json`.

- [ ] **Step 5: READY note** (post on the Conclave task):
```
READY lane/m3p-g-compile-dedupe @ <sha>  (base m3p @ <sha>)
F75: compileApp keeps one compile per id by role (linked child > unlinked child > root), whole record (ir+jinja+clientJs+serverTs);
     diagnostics logged once from the kept compile; outlet-outside-layout checked after every tree; guard component-compile-divergent
     (child compiles must agree on ir/serverTs; same role on everything) via exported replaces(), unit-tabled.
regression: test/fixtures/shared-root (List = root on /a, linked child of Board on /b); routes-ab/routes-ba compile and build identically;
     Chromium one-off: ab+ba /b rows reorder, /a renders, console [] (paste the 4 lines).
byte identity: app.expected-manifest.json untouched; build-manifest/e2e/pokedex/hydrate green.
ruling notes for the lead: R1 (non-root jinja too; per-route jinja needs a second id = manifest.ts amendment, not done),
     R2 (Row = non-root in both trees, differs by linked-ness: chunk-bearing compile wins, not a divergence), R3 (guard unreachable by construction today), R4 (no `bun run ci` in v2).
gates: <paste>
ledger text: F75 DONE — m3p-g-compile-dedupe (keep-by-role in compile.ts; route A pays pre-F70 bytes only for a component another route links)
side finding for the ledger: `[...state]` in a handler compiles to a spread of the signal (runtime "e is not iterable").
```

## Self-review

**Ruling coverage.**
- "Keep the NON-ROOT compile's IR/clientJs/serverTs (superset chunk)": Task 2 `roleOf`/`replaces`. A child always beats the root, and the chunk-bearing child beats the chunk-less one (R2 refines "non-root" for the linked axis).
- "Each route keeps its own jinja": amended to "the kept record is whole" (R1, for the lead to confirm), with the server-side evidence and the Chromium evidence that route A renders and hydrates from the non-root jinja. Per-route jinja would need a second id; it is described as the alternative and not planned.
- "Two disagreeing non-root compiles fail the build with `component-compile-divergent`": Task 2 `replaces()`, with the disagreement defined in R2 so the regression fixture itself does not trip it. Tested by the `replaces()` table (three divergent shapes, two keep directions per ranking edge).
- "Regression: routes A,B and B,A build the same component chunk and /b hydrates in both orders": Task 1/2 tests (compile level + `runBuild` manifest level, both orders, chunk members vs template directives). Task 3 Step 2 adds the Chromium hydration proof, which is local and one-off because `packages/brust` has no Playwright dependency and `tests/server` is outside the boundary.

**Risk ledger.**
1. *Logging order or error precedence changes.* Warnings now print after every tree compiles instead of interleaved. For apps without shared ids the order is identical (Evidence §3). When a later tree throws an Error diagnostic, earlier trees' warnings are no longer printed before it. No test asserts warning text or order (`grep` over `packages/brust/test`, `tests/server` and `examples/pokedex/test` finds none). An app with both an outlet error and a later compile error now reports the compile error first. That case is rare and both errors still fail the build.
2. *Route A's bytes for a shared component* return to their pre-F70 size (host + seed + chunks). This is accepted by the ruling's "superset chunk", and it applies only when a component is also linked by another route. That happens in no app in the repo today.
3. *A non-Static component compiled as chunk-less child*: React-tier islands have no `clientJs` from `compileTree` (`lower/mod.rs` early return, `Artifacts { jinja, ..Default }`), so they are always `ROLE.child`. Their compiles are identical across trees, so they are never divergent and never replaced.
4. *Guard comparing raw IR strings*: these come from serde's serialisation of the same struct. A future HashMap-ordered field would show up as a spurious divergence, not as a silent wrong pick. That is fail-closed, and the error names both trees.
