# M2c3 — every native child's chunk is linked (ledger F66) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @fcd7faa

**Goal:** A native child that has no precompute job and no `useId` (the pokedex `ThemeToggle`: `useState` + `useEffect`, a button) currently paints but is dead: its client chunk is built, but the manifest has no record linking it to the parent (no `instances[]` entry because it has no job), so the server's asset injection never emits its `<script>`. Mellow reproduced it with the Chromium test. Fix at the build: the manifest lists every inlined native child with a client chunk; the server is unchanged.

**Architecture:** the same precedent as `client_only` react children (spec S6: a static `children[]` entry `{ id, instances: "static", props: {} }` links a chunk). The build writes such an entry for every inlined native child (transitively: a child's children too) whose component record has a `client` chunk and which has no `instances[]` record of its own. `inject_assets` already walks `children[]` for chunks; a child record with no jobs drives nothing else.

**Tech Stack:** TypeScript (`packages/brust/src/build/manifest.ts`), bun:test, the m2c e2e harness.

**Spec:** S6 amendment (client_only static entry) extended to native children (the lead amends the spec in the same commit as this plan); S9 asset injection; ledger F66.

## Global Constraints

- The server is not touched: `crates/brust-server` stays byte-identical in this lane (if the server's child-walk turns out NOT to inject a chunk for a child with no jobs, file a challenge with the file:line — do not patch the server here).
- No duplicate script tags: a child reachable through two parents or twice in one parent is linked once per page (the server dedups by chunk path; Task 1 asserts a single tag in the e2e).
- Build goes through lowering as before; the IR's `children[]` (ChildRef with `tier`) is the source of the child list — not the template text.
- Gates: `cd packages/brust && bun test`, `bun test tests/server` (the pokedex Chromium test must now pass with ThemeToggle alive), `cargo test -p brust-server` (unchanged), `bun run battery` (no diff).
- Boundary: `packages/brust/src/build/manifest.ts`, `packages/brust/src/build/index.ts` (only if the child list is assembled there), `packages/brust/test/**`, `packages/brust/README.md`. NOT `docs/plans/m1a-followups.md` (m2e owns it; the lead closes F66 after merge) and NOT `examples/pokedex/**` or `tests/server/**` (m2e's lane).

## Review Focus

1. **Grandchild chunk** (parent → native child → native grandchild with a handler): the grandchild's entry lands on the CHAIN component's `children[]` (the only level the server walks) and its chunk is linked — Task 1's fixture has three levels.
2. **Static child** (no handlers, no state → no client chunk): NO entry is written (nothing to link) — Task 1 pins it.
3. **A child that already has an `instances[]` record** (job or useId): exactly one entry, not two — Task 1 pins it.
4. **A react child**: untouched by this lane (its link comes from the ssr job `target` / the client_only entry) — Task 1 pins that the manifest for `react-child`-style fixtures is unchanged.
5. **Page with every component static**: still no runtime script (S9) — Task 1 pins it.

---

### Task 1: Static entries for chunk-bearing native children

**Files:**
- Modify: `packages/brust/src/build/manifest.ts` (where `children[]` is written from IR `instances[]` and the client_only rule; add: for every `ir.children[]` entry with a non-react tier whose compiled record has `client != null` and which has no `instances[]` record, push `{ id, instances: 'static', props: {} }` ON THE CHAIN COMPONENT'S record for every chunk-bearing native DESCENDANT reachable through inlining — child, grandchild, descendants of instance children — deduped and skipped when that id already has a record there; child component records keep only their own instances-derived `children[]` (lead ruling on Dew's challenge 5f0dafd5: `inject_assets` walks only a chain component's direct `children[]`, render.rs:126-135)), `packages/brust/README.md` (one line under the manifest section)
- Create: `packages/brust/test/fixtures/child-chunks/{routes.tsx,Page.tsx,Toggle.tsx,Deep.tsx,Static.tsx}` (Page renders `<Toggle/>` (useState button) and `<Static/>` (plain markup); Toggle renders `<Deep/>` (another useState button))
- Test: `packages/brust/test/build-manifest.test.ts` (append) and `packages/brust/test/e2e.test.ts` (append one case: the page HTML contains exactly one `<script type="module" src="/_brust/client/toggle_…">` and one for `deep_…`, none for `static_…`)

- [ ] **Step 1: Failing tests**
```ts
test('native children with a client chunk are linked via a static children[] entry, transitively', async () => {
  const m = await buildFixture('child-chunks')
  const page = m.components[idOf(m, 'page')]
  const ids = page.children.map((c) => c.id)
  expect(ids.some((i) => i.startsWith('toggle_'))).toBe(true)
  expect(ids.some((i) => i.startsWith('static_'))).toBe(false)            // no chunk → no entry
  const toggle = m.components[ids.find((i) => i.startsWith('toggle_'))!]
  expect(ids.some((i) => i.startsWith('deep_'))).toBe(true)                 // grandchild flattened onto the PAGE (chain) record
  for (const c of page.children) expect(page.children.filter((x) => x.id === c.id).length).toBe(1)
})
test('react-child style manifests are unchanged', async () => { /* buildFixture('app') snapshot of components[...].children equals the committed expected JSON */ })
```
- [ ] **Step 2–3**: run (fails), implement, run `cd packages/brust && bun test`.
- [ ] **Step 4**: e2e: start the fixture app, GET the page, assert the two script tags (one each) and that `/_brust/client/toggle_….js` is 200.
- [ ] **Step 5**: commit `fix(brust): link every chunk-bearing native child through a static children[] entry — F66`.

---

### Task 2: Prove it on the pokedex (read-only check, no edits in m2e's boundary)

- [ ] From this lane's worktree run the m2e Chromium test against a pokedex built with this lane's build: `bun test tests/server/hydrate.chromium.test.ts` (the suite lives in m2e's merged tree once m2e lands; until then run it from `/Users/detoro/code/brust-lane-m2e-pokedex-exit` with `BRUST_BUILD_FROM=<this worktree>` if the harness supports it, else document the manual steps in the task note). Expected: ThemeToggle flips the theme. Paste the output in the task note. No commit.

## Verification (READY evidence)

```
cd packages/brust && bun test                                   # green incl. build-manifest + e2e
git diff --stat origin/v2 -- crates/                            # empty (server untouched)
bun run battery && git status --short docs/                     # unchanged
```
PR `lane/m2c3-child-chunks` → `v2`, CI green, lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2c3-child-chunks` | 1–2 | routine | Implementer (Routine) | none (parallel to m2e; disjoint boundary) | standard | Verification block pasted; Task 2 output pasted; PR → `v2` CI green; lane HEAD sha |
