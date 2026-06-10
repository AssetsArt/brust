# Markdown Pages + SSG — Design Spec

**Date:** 2026-06-10
**Status:** Reviewed (subagent pass applied) — ready for planning
**Branch:** `feat/md-ssg`
**Plans:** TWO implementation plans cut from this spec — Plan 1: SSG export
(independently shippable against today's TSX routes), Plan 2: markdown pages
(lands on top of Plan 1's mechanics).

## Goal

Two framework features for brustjs, shipped together because the driving use case (a
VitePress-class docs site) needs both:

1. **Markdown pages** — `.md` files (CommonMark + GFM + YAML frontmatter) become
   first-class brust routes via a new `mdRoutes()` helper. Components can be embedded
   in markdown with plain tags (`<Counter start={5} />`) and go through the **existing
   native pipeline**: React islands hydrate via the island bootstrap, native behavior
   components mount via x-data directives.
2. **SSG export** — `brust build --ssg` prerenders every static route (md and TSX
   alike) into plain `.html` files + assets under `dist/static/`, deployable to any
   static host (GitHub Pages user/org site, CDN). Islands still hydrate on the static
   host.

## Non-goals (v1)

- No MDX: no `import` statements or JS expressions inside `.md`. Component tags with
  **literal** props only (string / number / boolean / JSON object-literal).
- No default docs theme. Layout/sidebar/search are user code. The framework only
  exposes the nav tree (`mdNav()`) built from frontmatter.
- No `getStaticPaths`: routes with `{param}`/wildcard segments (matchit syntax) are
  skipped by SSG with a warning.
- No SPA-nav payload endpoint on static hosts: cross-page navigation on an SSG deploy
  is a full page load. Mechanism: the nav interceptor's fetch gets a non-ok response
  or unparsable payload → the `catch` in `runtime/islands/bootstrap.ts:255,281-285`
  falls back to `location.href` navigation.
- No base-path support: SSG output assumes **root-path deploys** (`/_brust/...` and
  asset URLs are root-absolute, partly baked Rust-side in `emit_jinja.rs:128`).
  GitHub Pages *project* sites (`user.github.io/repo/`) are NOT supported in v1 —
  documented limitation.
- No `:::tip` custom containers, no md-level `<Outlet>`, no md in `create-brustjs`
  templates (template can come later).

## High-level architecture

**Strategy: wrapper-TSX + post-compile splice.** Markdown never goes through the Rust
JSX compiler. Instead, per `.md` file the build:

1. **Renders markdown → static HTML** TS-side (md parser + `shiki` for build-time
   syntax highlighting; frontmatter parse). Library choices at plan time; the md
   parser is a regular dependency in the ROOT `package.json` (the published package;
   `runtime/package.json` is private), `shiki` is an **optional** peerDependency
   lazy-`import()`ed in the build path only — when absent, code fences render
   unhighlighted with a one-time build warning.
2. **Transforms component tags** found in the markdown into the exact host markup the
   Rust emitter produces (`emit_jinja.rs:218-229`), with the **content-addressed id
   already resolved** (`islandChunkBasename`) so the markers bypass
   `reconcileIslandManifest`'s rewrite regex cleanly:
   - React island → `<div data-brust-island="Name_<hash>" data-brust-props="…"
     data-brust-hydrate="…" [data-brust-csr]>…</div>`
   - native behavior component (file with `export const behavior`) → the component's
     JSX BODY compiled through the existing native-inline path (same `compileJsx`,
     literal md-tag props substituted statically, string/number only) with
     `x-data="<camelCase>_<8hex>"` auto-injected on the inlined root (same naming as
     `directiveName()`); a body referencing anything non-literal is a hard build error.
     *(amended post-scrutiny: the originally spec'd bare `<div x-data>` host was
     functionally empty — no children, no `x-on-*` targets, so the behavior could
     never do anything)*
3. **Generates an in-memory wrapper TSX** per md page (precedent:
   `buildChainWrapperSource` in `runtime/cli/native-routes-emit.ts:189-214` already
   compiles synthetic sources that don't exist on disk — `routeSourcePath` need not
   exist, lines 553-557). The wrapper is **two-mode**, matching the existing
   layout-owns-the-document rule:

   - **Standalone md route** (no `layout`): wrapper renders the `<BrustPage>` shell
     itself, with `<main data-brust-md-slot="…"></main>` inside.
   - **Chained md route** (under `opts.layout` via the existing Outlet/chain
     mechanism): wrapper is a **bare fragment** — `<article data-brust-md-slot="…"/>`
     only. NO `<BrustPage>`, NO `<main>` — the layout owns the document shell and the
     single `<main>` (nested `<main>` silently truncates SPA-nav payloads,
     `runtime/routes.ts:1214`; nested BrustPage emits nested `<html>` documents).

   Head values (`title`/`description` from frontmatter) are passed as literal
   BrustPage props in standalone mode; in chained mode the layout's BrustPage uses
   loader member-paths as today — md frontmatter feeds them via a tiny generated
   loader returning `{ __md: { title, description } }` (the ONE dynamic piece;
   everything else is static).
4. **Splices** the rendered markdown HTML into the compiled `.jinja` text, replacing
   the `data-brust-md-slot` host's inner content. Static md HTML is **baked into the
   template** (it does not flow through loader data or jinja variables).

   **Brace safety (pinned):** spliced md content uses **segmented
   brace-neutralization** — literal `{{` / `{%` / `}}` / `%}` sequences in the md
   HTML are emitted via jinja interpolation of string literals (e.g.
   `{{ "{{" }}`), while the island-host markers we inject stay LIVE jinja
   (`data-brust-props="{{ island_N_props }}"`, `{{ island_N_html | safe }}`).
   Wholesale `{% raw %}` wrapping is **forbidden**: (a) SSR island hosts inside the
   content need live jinja, (b) docs that document templating contain literal
   `{% endraw %}` in code fences and would terminate the block early. A test locks
   brace-bearing md content + an SSR island in the same file.
5. **Merges island manifest entries**: md-embedded islands get `NativeIslandEntry`
   rows appended to `<Name>.islands.json` with instance numbers offset past any
   wrapper/layout islands. Because md props are literals, `NativeIslandEntry` gains
   an optional `propsLiteral?: unknown` field (TS-side only,
   `runtime/islands/native-render.ts`). In `resolveIslandContext` the
   `propsLiteral !== undefined` branch must run BEFORE the existing
   `propsPath === '' → {}` mapping (`native-render.ts:165`); md entries still write
   `propsPath: ''` (the field is required). Old manifests are unaffected.
6. **Bakes client runtime tags itself.** `reconcileIslandManifest` only runs when the
   Rust compiler saw `<Island>`s in TSX (`compiled.islandsJson !== '[]'`,
   `native-routes-emit.ts:630`) — it never fires for pages whose only islands come
   from md. The md emit step therefore bakes `ISLANDS_IMPORTMAP_AND_BOOTSTRAP`
   (idempotently — the existing reconcile append at lines 944-945 has NO
   `includes()` guard, so the pipeline must guarantee a single bake pass),
   `bakeDirectivesIfUsed`, and the dev-client WS tag (parity with
   `native-routes-emit.ts:619-621` — without it md pages never auto-reload in dev).

   **Pinned order of operations per md template:**
   `compileJsx(wrapper)` → splice md HTML → merge manifest → single bake pass
   (importmap/bootstrap + directives + dev client).

**No Rust changes.** The integration points are: jinja text files, `.islands.json`
sidecars, and `napiLoadJinjaTemplates` — all already consumed by the existing
pipeline.

### Name resolution for embedded components

Three names must coincide, and the spec makes this explicit: the **md tag name** ==
the **`components` registry key** == the **routes.tsx default-import ident**
(`scanImports` keys by local default-import ident only,
`native-routes-emit.ts:849-870`; named imports/aliases are not resolved — same
constraint layouts already have). The registry value (`ComponentType`) is
deliberately the component itself, not a string: referencing it in `routes.tsx`
keeps the import alive (a `string[]` registry would let lint strip the import that
resolution depends on). A tag whose name is missing from the registry or whose ident
has no default import in the routes entry is a **build error** with `file.md:line`.

### Route registration

`mdRoutes(dir, opts)` runs at routes-module eval time. Per `.md` file it returns a
`Route` entry with:

- `path` derived from the file path (`index.md` → the prefix itself;
  `query/where.md` → `query/where`). Walk order is **sorted** (deterministic
  route_id positions — route_id is array position, `routes.ts:539`).
- `native: true` and a synthetic leaf component whose `name` is the deterministic
  template name `Md_<sanitized-rel-path>_<8hex(sha256(relPath))>` (hash guards
  collisions after sanitizing `/`, `-`, `.` to `_`). Named synthetic functions pass
  `validateRoute` (`routes.ts:382-409`).
- A marker field (`__mdSource`) carrying the absolute `.md` path + parsed
  frontmatter, surviving into `FlatRoute.chain` for the emit step and `mdNav()`.
- The generated frontmatter loader (chained mode only, see §3 above).

**Dist self-containment (prebuilt boot):** `brust build` bundles `routes.tsx` into
`dist/index.js`, so `mdRoutes()` re-executes at every dist boot — but the content
dir is not part of the dist contract. The build therefore **emits a frozen md
manifest** (`md-manifest.json`: ordered relPaths + frontmatter + template names)
into the dist (and `.brust/`), and `mdRoutes`/`mdNav` read the manifest instead of
walking the filesystem when running prebuilt (same detection the runtime already
uses for prebuilt dist). Source-mode dev scans the fs directly. This keeps the
route table byte-identical between build time and dist boot even if the content dir
is absent or has drifted.

### Build integration (three emit sites)

`emitNativeTemplates` is called from **three** places: `build.ts:387`, `dev.ts:92`
(+ the `reEmit` closure), and the boot-staleness path `runtime/index.ts:521-542`.

- md-route exclusion lives **inside** `emitNativeTemplates` (filter on the chain
  leaf's `__mdSource`) so no caller logs "no import → skip" noise per md page.
- New `emitMdTemplates()` is invoked at the same three points, with the same
  dual-emit mirroring (dist + `.brust/jinja`).
- `isJinjaStale` currently walks `.tsx` mtimes only
  (`runtime/cli/jinja-staleness.ts:22`) — extended to include `.md` files under
  registered content dirs, else source-mode boot serves stale md.
- Island chunk discovery: `scanIslandChunks` gains an `extraIslands` parameter (the
  md-referenced island set) — a parameter, NOT per-call-site injection, because the
  three island-build sites (build.ts:281-307, index.ts:439-463, coordinator
  index.ts:632-650) are exactly the known add-to-all-three trap. Components
  referenced **only** from md still produce chunks and `_islands.js` map entries.

### Dev mode

Watch `.md` files: new `ChangeKind` in `runtime/dev/watcher.ts` (`classifyPath`
returns null for `.md` today) + coordinator wiring.

- md change → re-render that page's HTML → re-splice → rewrite
  `.brust/jinja/<Name>.jinja` → reload via existing
  `reEmitJinja`/`napiLoadJinjaTemplates` → **worker restart** (the same coordinator
  restart path TSX edits use, `runtime/index.ts:595-617`) because
  `loadIslandManifest` caches per-isolate permanently (`native-render.ts:101-107`)
  and would serve stale `propsLiteral` otherwise. Browser reload via existing
  dev-WS.
- Adding/removing `.md` files changes the route table → requires restart in v1
  (print a clear message), same as TSX route edits today.

### `mdNav()`

`mdNav(dir)` (same module) returns a stable, ordered tree built from frontmatter
(`nav: { group, order }`, `title`) for layouts to render sidebars. Pure data; no
component shipped. Shares one scan (or the frozen manifest, prebuilt) with
`mdRoutes`.

### SSG: `brust build --ssg`

1. Run the normal `brust build` to completion (jinja, islands, css, public, server
   bundle).
2. Boot the **built** app in a child process. **Port mechanics (pinned):**
   `BRUST_PORT=0` is rejected by config validation (`runtime/config.ts:163-171`) —
   pick a free port JS-side (pattern: `tests/integration.test.ts:8-18 freePort()`),
   pass via `BRUST_PORT`, and probe readiness on the Rust stdout line
   `[brust] listening on {addr}` (precedent: `tests/integration.test.ts:1273-1275`).
3. Enumerate `FlatRoute`s; for every route with no `{param}`/wildcard segment and
   not SSE/WS: `GET` it, require HTTP 200 (anything else → build **fails**, no
   partial site), write the body to `dist/static/<path>/index.html`
   (`/` → `index.html`).
4. Copy runtime assets preserving server URL shape: islands →
   `dist/static/_brust/islands/`, css → `dist/static/_brust/css/`, `public/*` →
   `dist/static/*`.
5. Print a summary: N pages written, M routes skipped (with reasons: dynamic param,
   sse, ws), output size.
6. Actions/treaty calls in an SSG deploy hit nothing — documented limitation. One
   fixture covers a React-streaming/Suspense route to prove the awaited full body
   (with React's inline reveal scripts) works statically.

## API surface

```tsx
// brustjs/routes (new exports, implemented under runtime/md/)
mdRoutes(contentDir: string, opts: {
  prefix?: string                      // URL prefix, default '/'
  layout?: ComponentType               // native layout component (Outlet chain)
  components?: Record<string, ComponentType>  // tags allowed in md
}): Route[]

mdNav(contentDir: string): MdNavGroup[]  // frontmatter-driven nav tree

// CLI
brust build --ssg [--out dist/static]
```

Markdown component-tag grammar (line-level, outside code fences):
`<Name prop="str" n={42} flag json={{"a":1}} hydrate="visible" csr />` —
`hydrate` ∈ load|idle|visible|interaction (default load); `csr` flag opts out of
SSR (default: SSR on, matching native islands).

## File structure

```
runtime/md/
  scan.ts          # fs walk + frontmatter parse + frozen-manifest read/write
  routes.ts        # mdRoutes(), mdNav(), synthetic component factory
  render.ts        # md → HTML (parser + optional shiki), component-tag transform
  emit.ts          # emitMdTemplates(): wrapper TSX gen → compileJsx → splice → manifest merge → bake
  *.test.ts
runtime/cli/build.ts        # + emitMdTemplates step, + --ssg flag → ssg.ts, + md-manifest emit
runtime/cli/ssg.ts          # SSG crawl/export
runtime/cli/dev.ts          # + .md watcher kind → re-splice → reEmitJinja + worker restart
runtime/cli/jinja-staleness.ts    # + .md mtime walk
runtime/dev/watcher.ts      # + ChangeKind for .md
runtime/islands/build.ts    # scanIslandChunks(+extraIslands)
runtime/islands/native-render.ts  # NativeIslandEntry.propsLiteral (checked before propsPath)
tests/fixtures/app/         # + md fixture routes (content/*.md + registry)
package.json                # ROOT: + md parser dep; shiki as optional peer
```

## Behavior invariants

- Markdown HTML is baked at build time; a request never parses markdown. The route
  table is frozen via `md-manifest.json` so build-time templates and boot-time
  route_ids never desync.
- Escaping: md-derived HTML is spliced with segmented brace-neutralization (§4);
  island props attrs use the same `entityEncode(JSON.stringify(...))` as
  `resolveIslandContext`. md content is the same trust level as TSX source.
- Template names are deterministic and collision-free (hash of rel path); walk order
  sorted.
- Island instance numbering inside one template never collides between
  wrapper/layout-origin islands and md-origin islands.
- Exactly ONE importmap/bootstrap bake per template (the bake step is idempotent).
- `brust build` (no flag) behavior is byte-identical for projects with no md routes.
- SSG output requires zero server at root path: every asset URL referenced by the
  HTML exists under `dist/static/`.

## Tests

- **Unit (runtime/md/)**: path→route mapping (index, nested, prefix, sorted order),
  frontmatter parse errors, template-name sanitize/hash, component-tag grammar (each
  prop kind, unknown tag → error with file:line, tag inside code fence ignored),
  brace-neutralization (literal `{{`/`{%`/`{% endraw %}` in code fences + SSR island
  in the SAME md file), splice correctness, manifest merge offsets, propsLiteral
  branch order, frozen-manifest round-trip.
- **Integration (existing fixture-app pattern)**: fixture md route with one SSR
  island + one CSR island + one behavior component → `brust build` → assert jinja
  contains spliced HTML + content-addressed island ids + single bootstrap bake; boot
  server → GET page → island hosts present with encoded props. Dist boot WITHOUT the
  content dir present (manifest-only) serves identical pages.
- **Hydration**: server-emitted marker assertions per the existing
  native-island tests (`tests/native-island.test.ts` pattern — this repo has NO
  playwright infra, `tests/native-island.test.ts:21-22`); real-browser hydration is
  verified manually via MCP browser tooling before release, as done for prior island
  features.
- **SSG**: fixture build `--ssg` → assert file tree (html per route, islands, css,
  public), skipped-route warnings for a `{param}` fixture, non-200 → build fails,
  Suspense-route fixture renders statically. Serve `dist/static` with a dumb static
  file server → GET pages → 200 + island chunk URLs resolve.
- **Dev**: md edit → jinja re-emitted + reload event (unit-level on the watcher
  handler).
- Gates: `bun test` (full), `bun run ci` (biome), `cargo fmt --check` + CI clippy
  args unchanged (no Rust edits expected — gate proves it stays green).

## Acceptance criteria

1. A fixture app with `content/docs/*.md` + `mdRoutes()` serves `/docs/...` pages
   from `brust dev` AND from a `brust build` dist boot (content dir absent), with
   GFM rendering, highlighted code fences (shiki installed), frontmatter-driven
   `<title>`.
2. `<Counter start={5} />` in md produces a correct island host (asserted
   server-side: content-addressed id, encoded props, hydrate attr, bootstrap baked)
   on both dev and dist; browser hydration verified manually via MCP tooling.
3. `brust build --ssg` on that fixture produces `dist/static/` that works served by
   a plain static file server at root path: pages render, island chunks resolve,
   cross-page links work (full page loads).
4. All existing test suites stay green; zero Rust diffs (`git diff --stat` on
   `crates/` is empty).
5. `mdNav()` returns the documented tree for the fixture content.

## Known limitations

- SPA-feel navigation is lost on static hosts (full reloads) — by design in v1.
- Root-path deploys only (no GitHub Pages project sites) — base-path support needs
  Rust-side URL changes, deferred.
- md routes can't use user loaders/actions/SSE in v1 (`__mdSource` routes are static
  apart from the generated frontmatter loader).
- Adding/removing md files in dev requires restart.
- Component tags must be top-level block lines in md (not inline mid-paragraph).
- shiki absent → unhighlighted code fences (warning, not error).

## Open questions → resolve at plan time

1. md parser choice (GFM tables, heading ids/anchors out of the box) + shiki
   dual-theme (light/dark) strategy.
2. Dev re-splice base: note `reEmitJinja` recompiles ALL native templates anyway
   (`dev.ts:102-108`) — a `.jinja.base` sidecar only pays off if the md path
   bypasses that; decide in plan with measurements if needed.
3. Frozen-manifest detection: which existing prebuilt-dist signal `mdRoutes` keys on
   (env var vs dist marker file).
4. Whether the SSG crawler reads routes via importing the routes module or via a
   `/_brust`-style introspection endpoint (import is simpler; pick at plan time).
