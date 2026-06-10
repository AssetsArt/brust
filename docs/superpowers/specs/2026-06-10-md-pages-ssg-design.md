# Markdown Pages + SSG — Design Spec

**Date:** 2026-06-10
**Status:** Approved direction (interactive brainstorm) — pending reviewer pass
**Branch:** `feat/md-ssg`

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
   static host (GitHub Pages, CDN). Islands still hydrate on the static host.

## Non-goals (v1)

- No MDX: no `import` statements or JS expressions inside `.md`. Component tags with
  **literal** props only (string / number / boolean / JSON object-literal).
- No default docs theme. Layout/sidebar/search are user code. The framework only
  exposes the nav tree (`mdNav()`) built from frontmatter.
- No `getStaticPaths`: routes with `:param` are skipped by SSG with a warning.
- No SPA-nav payload endpoint on static hosts: cross-page navigation on an SSG deploy
  is a full page load (the existing standalone-document fallback, ef1a87c, handles
  this).
- No `:::tip` custom containers, no md-level `<Outlet>`, no md in `create-brustjs`
  templates (template can come later).

## High-level architecture

**Strategy: wrapper-TSX + post-compile splice.** Markdown never goes through the Rust
JSX compiler. Instead, per `.md` file the build:

1. **Renders markdown → static HTML** TS-side (marked or markdown-it + `shiki` for
   build-time syntax highlighting; `gray-matter`-style frontmatter parse — exact
   libraries chosen at plan time, must be pure-JS, Bun-compatible).
2. **Transforms component tags** found in the markdown into the exact host markup the
   Rust emitter produces:
   - React island → `<div data-brust-island="Name" data-brust-props="…"
     data-brust-hydrate="…" [data-brust-csr]>…</div>`
   - native behavior component (file with `export const behavior`) →
     `<div x-data="<camelCase>_<8hex>">` host (same naming as `directiveName()`).
3. **Generates an in-memory wrapper TSX** per md page (precedent:
   `buildChainWrapperSource` in `runtime/cli/native-routes-emit.ts` already compiles
   synthetic sources that don't exist on disk):

   ```tsx
   export default function MdDocsIntroduction() {
     return (
       <BrustPage title="Introduction" description="What brust is">
         <main data-brust-md-slot="docs/introduction"></main>
       </BrustPage>
     )
   }
   ```

   The wrapper is compiled through the **existing** `compileJsx` napi call, composed
   with the route's layout chain by the **existing** Outlet/chain mechanism (md leaf
   routes are nested as children of the layout route). This is what buys us the
   document shell, `<head>` props, `__brust_component_css__` / `__brust_store__`
   slots, layout composition, and importmap/bootstrap baking — all unchanged.
4. **Splices** the rendered markdown HTML into the compiled `.jinja` text, replacing
   the `data-brust-md-slot` host's inner content. Static md HTML is **baked into the
   template** (it is not loader data; `| e` escaping is irrelevant because the
   content never passes through a jinja variable).
5. **Merges island manifest entries**: md-embedded islands get `NativeIslandEntry`
   rows appended to `<Name>.islands.json` with instance numbers offset past any
   wrapper/layout islands. Because md props are literals, `NativeIslandEntry` gains a
   `propsLiteral?: unknown` field (TS-side only, `runtime/islands/native-render.ts`)
   that `resolveIslandContext` uses instead of `propsPath` when present. SSR islands
   render at request time exactly as today; CSR islands get their props baked
   directly into the spliced attr.

**No Rust changes.** The integration points are: jinja text files, `.islands.json`
sidecars, and `napiLoadJinjaTemplates` — all already consumed by the existing
pipeline.

### Name resolution for embedded components

`mdRoutes({ components: { Counter, Playground } })` keys declare which tags are
allowed. The **source path** of each component is resolved the same way native TSX
pages resolve theirs: via `scanImports(routesFile)` (ident → absolute path) — i.e.
the component must be imported in `routes.tsx`. A tag whose name is missing from the
registry or whose ident has no import in the routes entry is a **build error** with
`file.md:line`.

### Route registration

`mdRoutes(dir, opts)` runs at routes-module eval time (sync `readdirSync` walk — the
routes module is imported by `runBuild`, `runDev`, and the runtime boot, so all three
see identical routes). Per `.md` file it returns a `Route` entry with:

- `path` derived from the file path (`index.md` → the prefix itself;
  `query/where.md` → `query/where`).
- `native: true` and a synthetic leaf component whose `name` is the deterministic
  template name `Md_<sanitized-rel-path>_<8hex(sha256(relPath))>` (hash guards
  collisions after sanitizing `/`, `-`, `.` to `_`).
- A marker field (`__mdSource`) carrying the absolute `.md` path + parsed frontmatter
  so the build's md emit step and `mdNav()` don't re-parse.
- No loader in v1 (everything is static at build time).

`flattenRoutes` requires nothing new: the synthetic component provides
`nativeTemplate` via `Component.name` as today. The md emit step is a **new branch in
the native emit flow** (alongside `emitNativeTemplates`) keyed off `__mdSource` —
md routes are excluded from the normal TSX emit loop (which would warn "no import").

### Build integration (`runBuild` + dev boot + HMR)

- New step `emitMdTemplates()` runs at the same point `emitNativeTemplates()` runs,
  in **both** emit sites (build.ts dist emit AND dev/boot `.brust/jinja` emit), with
  the same dual-emit mirroring.
- Island chunk discovery: md-referenced island components are added to the
  `scanIslandChunks` result in **all three** island-build sites (build.ts,
  runtime/index.ts boot, dev HMR) — known trap, see memory `brust-boot-rebuilds-islands-dir`.
- Components referenced **only** from md (no `<Island>` usage in TSX) must still
  produce chunks and `_islands.js` map entries.

### Dev mode

Watch `.md` files (and the content dir) in `brust dev`:

- md change → re-render that page's HTML → re-splice from the cached compiled
  wrapper jinja base (kept as `<Name>.jinja.base` beside the emit, or recompiled —
  plan decides) → rewrite `.brust/jinja/<Name>.jinja` → reload via the existing
  `reEmitJinja` / `napiLoadJinjaTemplates` path → existing dev-WS browser reload.
- Adding/removing `.md` files changes the route table → requires restart in v1
  (print a clear message), same as TSX route edits today.

### `mdNav()`

`mdNav(dir)` (same module) returns a stable, ordered tree built from frontmatter
(`nav: { group, order }`, `title`) for layouts to render sidebars. Pure data; no
component shipped. Computed at module eval from the same scan `mdRoutes` does (shared
cache; one fs walk).

### SSG: `brust build --ssg`

1. Run the normal `brust build` to completion (jinja, islands, css, public, server
   bundle).
2. Boot the **built** app in a child process on an ephemeral port
   (`BRUST_PORT`-driven), wait for readiness.
3. Enumerate `FlatRoute`s; for every route with no `:param`/`*` segment and not
   SSE/WS: `GET` it, require HTTP 200 (anything else → build **fails**, no partial
   site), write the body to `dist/static/<path>/index.html` (`/` → `index.html`).
4. Copy runtime assets: `dist/islands/*` → `dist/static/_brust/islands/*`, css →
   `dist/static/_brust/css/*`, `public/*` → `dist/static/*` (same URL shape the
   server exposes, so the HTML works unmodified).
5. Print a summary: N pages written, M routes skipped (with reasons: dynamic param,
   sse, ws), output size.
6. Actions/treaty calls in an SSG deploy hit nothing — documented limitation (static
   hosting is for static+islands sites).

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
  scan.ts          # fs walk + frontmatter parse (shared by mdRoutes/mdNav/build)
  routes.ts        # mdRoutes(), mdNav(), synthetic component factory
  render.ts        # md → HTML (marked/markdown-it + shiki), component-tag transform
  emit.ts          # emitMdTemplates(): wrapper TSX gen → compileJsx → splice → manifest merge
  *.test.ts
runtime/cli/build.ts        # + emitMdTemplates step, + --ssg flag → ssg.ts
runtime/cli/ssg.ts          # SSG crawl/export
runtime/cli/dev.ts          # + .md watcher → re-splice → reEmitJinja
runtime/islands/native-render.ts  # NativeIslandEntry.propsLiteral
tests/fixtures/app/         # + md fixture routes (content/*.md + registry)
```

## Behavior invariants

- Markdown HTML is baked at build time; a request never parses markdown.
- Escaping: md-derived HTML is spliced verbatim (markdown IS the trusted source, same
  trust level as TSX). Island props attrs are entity-encoded with the same
  `entityEncode(JSON.stringify(...))` used by `resolveIslandContext`. The splice MUST
  NOT introduce unescaped `{{`/`{%` into jinja text — raw md content is wrapped in
  `{% raw %}…{% endraw %}` or brace-escaped (plan decides; test locks it).
- Template names are deterministic and collision-free (hash of rel path).
- Island instance numbering inside one template never collides between
  wrapper/layout-origin islands and md-origin islands.
- `brust build` (no flag) behavior is byte-identical for projects with no md routes.
- SSG output requires zero server: every asset URL referenced by the HTML exists
  under `dist/static/`.

## Tests

- **Unit (runtime/md/)**: path→route mapping (index, nested, prefix), frontmatter
  parse errors, template-name sanitize/hash, component-tag grammar (each prop kind,
  unknown tag → error with file:line, tag inside code fence ignored), jinja-brace
  safety in md content, splice correctness, manifest merge offsets, propsLiteral.
- **Integration (existing fixture-app pattern)**: fixture md route with one SSR
  island + one CSR island + one behavior component → `brust build` → assert jinja
  contains spliced HTML + reconciled island ids; boot server → GET page → island
  hosts present with encoded props; hydration covered by the existing
  native-island e2e harness.
- **SSG**: fixture build `--ssg` → assert file tree (html per route, islands, css,
  public), skipped-route warnings for a `:param` fixture, non-200 → build fails.
  Serve `dist/static` with a dumb static file server → GET pages → 200 + island
  chunk URLs resolve.
- **Dev**: md edit → jinja re-emitted + reload event (unit-level on the watcher
  handler; full WS e2e only if the existing dev harness supports it).
- Gates: `bun test` (full), `bun run ci` (biome), `cargo fmt --check` + CI clippy
  args unchanged (no Rust edits expected — gate proves it stays green).

## Acceptance criteria

1. A fixture app with `content/docs/*.md` + `mdRoutes()` serves `/docs/...` pages
   from `brust dev` AND from a `brust build` dist boot, with GFM rendering,
   highlighted code fences, frontmatter-driven `<title>`.
2. `<Counter start={5} />` in md hydrates in the browser (verified via the existing
   playwright/e2e harness) on both dev and dist.
3. `brust build --ssg` on that fixture produces `dist/static/` that works served by
   a plain static file server: pages render, islands hydrate, cross-page links work
   (full page loads).
4. All existing test suites stay green; zero Rust diffs.
5. `mdNav()` returns the documented tree for the fixture content.

## Known limitations

- SPA-feel navigation is lost on static hosts (full reloads) — by design in v1.
- md routes can't use loaders/actions/SSE in v1 (`__mdSource` routes are fully
  static).
- Adding/removing md files in dev requires restart.
- Component tags must be top-level block lines in md (not inline mid-paragraph) — v1
  grammar keeps parsing trivial and unambiguous.

## Open questions → resolve at plan time

1. marked vs markdown-it (plugin needs: GFM tables, heading ids/anchors). shiki
   theme choice + dual light/dark strategy.
2. Splice base caching for dev (`.jinja.base` sidecar vs recompile-on-md-change).
3. Whether `scanIslandChunks` gains an `extraIslands` param vs md scan injecting into
   its result at each call site.
4. SSG readiness probe + port selection mechanics for the child process.
5. Exact `data-brust-md-slot` host element (`<main>` vs `<article>`) w.r.t. SPA-nav
   `<main>` extraction and layout-owns-`<main>` rule for Outlet chains.
