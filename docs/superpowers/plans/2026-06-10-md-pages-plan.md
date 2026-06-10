# Plan 2: Markdown pages (`mdRoutes` + native-pipeline splice)

Spec: `docs/superpowers/specs/2026-06-10-md-pages-ssg-design.md`. Builds on Plan 1
(SSG ships first; md routes are ordinary native routes by the time SSG crawls).

**Rules for implementers:** TDD per task. `bun test <file>` then `bun run ci` before
DONE. NO Rust edits — `git diff --stat crates/` must stay empty; if you believe a
Rust change is required, report BLOCKED with the reason (do not make it). Avoid
`git add -A`. After any change under `runtime/` that the fixture app consumes, the
integration tests rebuild fixtures themselves — do not hand-edit
`tests/fixtures/app/.brust/*`.

## Spec coverage

| Spec item | Task |
|---|---|
| scan + frontmatter + sorted walk | 2.1 |
| template naming, path→route mapping | 2.2 |
| md→HTML, heading anchors, shiki-optional, brace-neutralization | 2.3 |
| component-tag grammar → host markup + island entries | 2.4 |
| `propsLiteral` in native-render | 2.5 |
| `mdRoutes()`/`mdNav()`/synthetic component/frozen manifest | 2.6 |
| emit step: wrapper TSX → compileJsx → splice → merge → bake | 2.7 |
| build integration (3 emit sites, extraIslands, manifest emit) | 2.8 |
| dev watcher + staleness + worker restart | 2.9 |
| fixture + integration + acceptance | 2.10 |
| deps + docs | 2.11 |

Dependency order: 2.1 → 2.2 → {2.3, 2.4, 2.5 parallelizable in principle but run
sequentially} → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.11.

## Task 2.1 — `runtime/md/scan.ts`

```ts
export interface MdFile {
  relPath: string          // 'query/where.md' (posix separators)
  absPath: string
  frontmatter: { title?: string; description?: string; nav?: { group?: string; order?: number }; [k: string]: unknown }
  body: string             // md source after frontmatter strip
}
export function scanMdDir(contentDir: string): MdFile[]   // sorted by relPath
```

- Frontmatter: hand-rolled `---\n…\n---\n` block parsed as YAML-subset (string,
  number, boolean, one-level nested map for `nav`) — NO yaml dependency; malformed
  frontmatter → throw with `<file>:<line>`. (If a real YAML lib proves necessary,
  BLOCKED-report rather than adding a dep silently.)
- Tests (`runtime/md/scan.test.ts`, tmp dirs): sorted order, nested dirs,
  frontmatter kinds, missing frontmatter (empty object), malformed → error message
  contains path, CRLF tolerance.

## Task 2.2 — naming + route mapping (`runtime/md/routes.ts`, pure parts)

```ts
export function mdTemplateName(relPath: string): string   // Md_<sanitized>_<8hex sha256(relPath)>
export function mdUrlPath(relPath: string, prefix: string): string
```

- Sanitize `[^A-Za-z0-9_]` → `_`; hash like `islandChunkBasename`
  (`runtime/islands/chunk-id.ts`) for collision proofing.
- `index.md` → prefix itself; `query/where.md` + prefix `/docs` → `/docs/query/where`.
- Tests: collisions (`a-b.md` vs `a_b.md` differ by hash), index at root and
  nested (`guide/index.md` → `/docs/guide`), prefix normalization (`/docs/` ==
  `/docs`).

## Task 2.3 — markdown rendering (`runtime/md/render.ts`)

- Parser: **marked** (root `package.json` regular dep) with `gfm: true`; custom
  renderer for heading ids (slugger: lowercase, spaces→`-`, strip non-word, dedupe
  with `-2` suffixes).
- Code fences: `highlightCode(code, lang)` — lazy `await import('shiki')` once,
  cached; themes `{ light: 'github-light', dark: 'github-dark' }` (CSS-variables
  dual output). shiki missing → escape-only `<pre><code class="language-x">` +
  ONE warning per build via a module-level flag. shiki goes in root
  `package.json` `peerDependencies` + `peerDependenciesMeta.optional: true` (2.11).
- `neutralizeBraces(html: string): string` — post-render pass over the FINAL HTML
  for md-origin segments: replace `{{` → `{{ "{{" }}`, `{%` → `{{ "{%" }}`, and
  `}}`/`%}` likewise. Island/x-data host markup is injected AFTER neutralization
  so its jinja stays live (order enforced by the pipeline in render.ts, locked by
  test).
- Tests: GFM table, heading anchor ids + dedupe, fence with `{{`/`{%`/
  `{% endraw %}` content survives to identical visible text when rendered through
  minijinja-style substitution (assert the emitted jinja contains the
  neutralized form and NOT a raw `{% endraw %}`), shiki-absent fallback (mock the
  import failure), shiki-present path (skip if not installed in repo —
  `test.skipIf`).

## Task 2.4 — component-tag transform (`runtime/md/render.ts`)

Grammar (line-level, outside code fences, BEFORE markdown parsing — extract to
placeholder, render md, re-insert):

```
^<([A-Z][A-Za-z0-9]*)((\s+[a-zA-Z][\w-]*(=("[^"]*"|\{[^}]*\}))?)*)\s*/>$
```

- Props: `p="str"` → string; `p={42}`/`p={true}` → JSON-parsed scalar;
  `p={{"a":1}}` → JSON object (the `{…}` content is `JSON.parse`d; parse failure →
  build error `file.md:line`); bare `flag` → `true`. Reserved: `hydrate`
  (load|idle|visible|interaction, default load), `csr` (flag).
- Output per tag, given a resolver `(name) => { kind: 'island', id: string } |
  { kind: 'behavior', directive: string }`:
  - island, SSR (default):
    `<div data-brust-island="<id>" data-brust-props="{{ island_<N>_props }}" data-brust-hydrate="<h>">{{ island_<N>_html | safe }}</div>`
  - island, `csr`: same + ` data-brust-csr`, empty inner.
  - behavior: `<div x-data="<directive>"></div>` (self-closing tags only in v1 —
    behavior components with children are out of scope, error if attempted via
    non-self-closing syntax).
- Returns `{ html, islands: MdIslandUse[] }` where
  `MdIslandUse = { name, instanceLocal, props, hydrate, csr, line }` — instance
  numbers are LOCAL (0-based per page); the emit step offsets them.
- Unknown tag name → throw `file.md:line — <Name> is not in mdRoutes components
  registry`. Tag inside a code fence → ignored (test locks it).
- Tests: every prop kind, hydrate/csr variants, two instances of the same
  component, unknown tag error, fence-shielded tag, malformed JSON prop error,
  tag in mid-paragraph NOT matched (line-anchored).

## Task 2.5 — `propsLiteral` (`runtime/islands/native-render.ts`)

- `NativeIslandEntry` gains `propsLiteral?: unknown`. In `resolveIslandContext`,
  branch BEFORE the `propsPath === '' → {}` mapping (line ~165): if
  `entry.propsLiteral !== undefined`, use it as the props value (then the existing
  entityEncode + optional SSR renderToString flow unchanged — md entries carry
  `propsPath: ''` since the field is required).
- Tests (`runtime/islands/native-render.test.ts` or the file's existing test
  home): literal used when present (including falsy literals `0`, `""`, `false`,
  `null` — note `null` IS a valid literal, guard with `!== undefined` only),
  absent → old behavior byte-identical (existing tests stay green).

## Task 2.6 — `mdRoutes()` / `mdNav()` / frozen manifest (`runtime/md/routes.ts`, `runtime/md/scan.ts`)

- Synthetic leaf per file:
  `const C = () => null; Object.defineProperty(C, 'name', { value: templateName })`
  — passes `validateRoute` (routes.ts:382-409). Route entry:
  `{ path, native: true, Component: C, loader }` + non-enumerable-OK plain field
  `__mdSource: { absPath, relPath, contentDir, frontmatter, components, layoutName }`
  (must survive `flattenRoutes` into `FlatRoute.chain` — it does, chain holds the
  node objects; test locks it).
- `layout` opt → return ONE parent route `{ path: prefix, Component: layout,
  children: [...mdLeaves] }`; no layout → leaves carry the full prefixed path.
- Generated loader (chained mode AND standalone — uniform):
  `async () => ({ __md: { title, description } })` from frontmatter.
- Frozen manifest: `writeMdManifest(dir, entries)` / `readMdManifest(file)` —
  JSON `{ version: 1, contentDir, entries: [{ relPath, templateName, urlPath, frontmatter }] }`.
  `mdRoutes` resolution order: if `<cwd>/.brust/md-manifest.json` OR
  `<distDir>/md-manifest.json` applies — investigate the existing prebuilt-dist
  detection used by the runtime (how jinjaDir is resolved at boot,
  `runtime/index.ts:504-545` + `configureJinjaDir`) and key off the SAME signal;
  fs-scan otherwise. Record the chosen signal in the task report.
- `mdNav(contentDir)`: group by `frontmatter.nav.group` (ungrouped → top-level),
  sort by `nav.order` then title; returns
  `{ group: string | null, items: { title, path, order }[] }[]`.
- Tests: route shapes (with/without layout), loader output, manifest round-trip
  (scan → write → read → identical routes), nav grouping/ordering, `__mdSource`
  present in flattened chain (use `defineRoutes` directly).

## Task 2.7 — emit step (`runtime/md/emit.ts`) — THE CORE TASK

```ts
export async function emitMdTemplates(opts: {
  entryFile: string                 // routes.tsx (for scanImports + directives)
  flatRoutes: FlatRouteLike[]       // filter chains whose leaf has __mdSource
  outDir: string                    // jinja out dir (same as emitNativeTemplates)
  withDevClient?: boolean
}): Promise<{ mdIslands: Map<string, string> }>  // name → abs source path (for extraIslands)
```

Per md route:

1. Resolve embedded component names: registry keys → `scanImports(entryFile)`
   (default-import idents only). Missing import → error naming all three
   identities (tag/registry/import). Classify island vs behavior via the same
   check `scanDirectiveComponents` uses (`export const behavior` in source —
   reuse `runtime/native/build.ts` helpers, don't reimplement).
2. Render md (2.3) + transform tags (2.4) with resolver →
   `{ html, islands }`. Island ids: `islandChunkBasename(name, absPath)`;
   behavior: `directiveName(absPath, projectRoot)`.
3. Wrapper TSX (in-memory, precedent `buildChainWrapperSource`):
   - standalone: `export default function <T>() { return <BrustPage title={...literal} description={...literal}><main data-brust-md-slot="x"></main></BrustPage> }`
   - chained: `export default function <T>() { return <article data-brust-md-slot="x"></article> }`
     and compose via the EXISTING chain path: reuse `emitNativeTemplates`'s chain
     branch by injecting the wrapper source — implementation choice: call
     `compileJsx` directly with `componentSources` = gathered chain sources
     (mirror `gatherChainSources`) + the synthetic wrapper as the leaf source.
     READ `native-routes-emit.ts:553-640` first and reuse its helpers
     (`gatherChainSources`, `buildChainWrapperSource`, factory/sidecar emission)
     rather than copying.
4. Splice: replace the slot element's inner content
   (`<main data-brust-md-slot="x"></main>` or `<article …>`) in the compiled
   template with the md HTML. The slot attr itself stays (hydration-neutral,
   useful for tests). Exactly-one-slot assert.
5. Manifest merge: read compiler's `.islands.json` (wrapper/layout islands),
   offset md instances past `max(instance)+1`, rewrite the spliced markers'
   `island_<N>_*` numbers accordingly, append entries
   `{ component, instance, propsPath: '', propsLiteral, ssr: !csr, hydrate,
   sourcePath: <project-relative> }`.
6. Bake (idempotent, single pass): `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` if any island
   (md or TSX) present; `bakeDirectivesIfUsed`; dev-client tag when
   `withDevClient` (parity with `native-routes-emit.ts:619-621`).
7. md-route exclusion in `emitNativeTemplates`: filter out chains whose LEAF has
   `__mdSource` (build.ts callers stay unchanged — the filter lives inside).

- Tests (`runtime/md/emit.test.ts`): drive against a tmp fixture (mini routes.tsx
  + components + content dir). Assert: emitted jinja has spliced HTML, neutralized
  braces, live island markers with OFFSET instance numbers when the layout also
  has a TSX island, exactly one bootstrap bake (run emit twice → still one),
  `.islands.json` merged shape, behavior host x-data name matches
  `directiveName()`, standalone vs chained wrapper shapes, exclusion: the md leaf
  does NOT produce a "no import" warning from `emitNativeTemplates`.

**BLOCKED fallbacks:**
- If chain-mode composition via in-memory leaf fights `compileJsx`
  (member-path/validation errors), write the wrapper to
  `.brust/md-gen/<T>.tsx` as a REAL file and seed it into the import map — same
  net effect, still zero Rust.
- If splice-time instance renumbering is error-prone, allocate md instances in a
  RESERVED high range (e.g. start at 1000) instead of compacting — manifest
  entries are keyed by instance, nothing requires density. (Prefer this only if
  renumbering actually breaks; report which was chosen.)

## Task 2.8 — build integration (`runtime/cli/build.ts`, `runtime/index.ts`, `runtime/cli/dev.ts`)

- `scanIslandChunks(routesFile, extraIslands?: Map<string,string>)` — merge param
  into result (collision = same name different path → throw, same path → ok).
- Call `emitMdTemplates` + thread `mdIslands` as `extraIslands` at ALL THREE island
  build sites and BOTH jinja emit sites + boot-staleness path
  (`runtime/index.ts:521-542`): build.ts (dist, withDevClient:false), dev.ts boot +
  reEmit (withDevClient:true), index.ts staleness re-emit. Where those sites get
  `flatRoutes`, reuse the already-imported routes module.
- Emit `md-manifest.json` (2.6) into BOTH dist and `.brust/` next to jinja.
- Dual-emit mirroring identical to the TSX jinja mirror.
- Tests: extend the build tests — fixture with md route → dist contains
  `Md_*.jinja`, `md-manifest.json`, island chunk for an md-only island, and
  `_islands.js` map entry; a NO-md fixture build output is unchanged
  (`brust build` byte-identical invariant — compare the jinja dir file list before/
  after the change on the existing fixture).

## Task 2.9 — dev mode (`runtime/dev/watcher.ts`, `runtime/cli/dev.ts`, `runtime/cli/jinja-staleness.ts`)

- `classifyPath`: `.md` under the project (skip node_modules/.brust as existing
  kinds do) → new kind `'md'`.
- Coordinator on `'md'`: re-run `emitMdTemplates` (re-splice), reload via existing
  `reEmitJinja`/`napiLoadJinjaTemplates` path, **restart workers** (same path TSX
  edits use, `runtime/index.ts:595-617` — REQUIRED: `loadIslandManifest` caches
  per-isolate, `native-render.ts:101-107`), fire dev-WS reload.
- `isJinjaStale`: also walk `.md` mtimes under content dirs registered in
  `md-manifest.json` (read it from `.brust/` — it lists contentDir).
- Add/remove md file: detect (emit set differs from manifest) → log
  `"[brust dev] md routes changed — restart required"` once; no crash.
- Tests: watcher classify unit test; staleness unit test (`jinja-staleness.test.ts`
  pattern: touch md → stale).

**BLOCKED fallback:** if the lighter re-splice path serves stale anything, dev md
change = full dev-process restart (same UX as routes edits today); note it in the
report.

## Task 2.10 — fixture + integration + acceptance

**Files:** `tests/fixtures/app/content/docs/*.md` (3 files: index.md, intro.md with
SSR island + CSR island + behavior component + brace-bearing code fence,
`query/where.md` nested), fixture `routes.tsx` gains
`...mdRoutes('content/docs', { prefix: '/docs', layout: <existing native layout>,
components: { …existing fixture islands/behavior comps… } })`, `tests/md-routes.test.ts`.

- Integration asserts (server boot, follow `tests/native-island.test.ts` pattern —
  NO playwright):
  - GET `/docs` + `/docs/intro` + `/docs/query/where` → 200, GFM rendered,
    `<title>` from frontmatter.
  - `/docs/intro` HTML: island host with content-addressed id + entity-encoded
    props + `data-brust-hydrate`, SSR island has inner HTML, CSR island empty +
    `data-brust-csr`, behavior host `x-data` present, bootstrap script tag present
    EXACTLY once, code fence shows literal `{%`-bearing text.
  - Dist boot WITHOUT content dir: build fixture to tmp, delete/rename content dir,
    boot dist → same pages 200 (manifest-frozen routes).
  - SSG (Plan 1 shipped): `--ssg` build includes `/docs/*` pages; serve statically →
    island chunk URLs 200.
- Run the integration file SEPARATELY from cli-build tests if port-race flake
  appears (known ~1/5 combined-run flake).
- Manual browser verification (orchestrator, not subagent): dev server → Chrome MCP
  → island hydrates (click Counter), behavior component reacts — per acceptance
  criterion 2.

## Task 2.11 — deps + docs + exports

- ROOT `package.json`: `marked` (dependencies), `shiki`
  (peerDependencies + peerDependenciesMeta optional). `bun install` to update
  `bun.lock`. devDependencies: `shiki` (so repo tests cover the highlighted path).
- `runtime/routes.ts` (or the package's export surface — check how `brustjs/routes`
  maps to runtime files in root package.json `exports`): re-export `mdRoutes`,
  `mdNav` types + functions from `runtime/md/routes.ts`.
- `brust build --help` + README section (short; full docs site usage comes with the
  dogfood follow-up). architecture.md: one subsection on the md pipeline (wrapper +
  splice diagram in text).

Verify (whole plan): full `bun test`, `bun run ci`, `git diff --stat crates/` empty.
