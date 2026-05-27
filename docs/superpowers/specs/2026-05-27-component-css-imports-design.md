# Component CSS Imports + CSS Modules — Design

**Date:** 2026-05-27
**Status:** Designed, awaiting plan
**Scope:** Sub-project E in the build-pipeline roadmap. Adds `import './foo.css'` (side-effect, contributes to a route-scoped chunk) and `import styles from './foo.module.css'` (returns a hashed class-name map). Component CSS is processed through Tailwind (so `@apply` resolves) and Lightning CSS (modules + bundle). Output is split per-route — the renderer injects only the CSS chunks the matched route uses, not a single global bundle.

---

## Goal

Give brust users two new CSS authoring patterns alongside the already-shipped Tailwind v4 (`app.css`) flow:

1. **Plain component CSS** — `import './Card.css'` is a side-effect import that contributes to the bundle. Class names are unchanged; users own naming.
2. **CSS Modules** — `import styles from './Card.module.css'` returns `{ primary: 'primary_<hash>', ... }`. Class names are scoped by a deterministic hash of `<relative path>:<class name>` so styles can't leak across components.

Both forms support `@apply` (Tailwind v4 utilities) because every component CSS file is piped through the same Tailwind compiler that handles `app.css`. Hot-reload works in dev: a class-content edit hot-swaps the `<link>` href without a page reload; a name change (class added/renamed/removed) triggers a full reload (the bundled JS-side hash map needs refresh).

**Critical SSR contract:** the same hash map is used in SSR and client hydration. React must not see a className mismatch. We achieve this via a Bun.plugin that reads a manifest at boot — both main and workers register the plugin and read the same on-disk manifest.

---

## Non-goals

- Sass / Less / Stylus preprocessors.
- CSS-in-JS (styled-components, Emotion, vanilla-extract).
- CSS Modules `composes:` directive. Users combine classes via `@apply` or runtime concat (e.g. `clsx`).
- Dynamic-import-aware route chunking. Static imports only.
- Source maps for CSS chunks.
- Per-island CSS chunking. Islands inherit their route's chunk set.
- Watching CSS files outside `scanRoot` (e.g. node_modules shared libs).
- CSS minification beyond Lightning CSS's defaults.

---

## High-level architecture

```
BUILD TIME (brust build + dev boot)
─────────────────────────────────────────────────────────────────
1. Scan TS/TSX in scanRoot for CSS imports:
     - import './foo.css'           → side-effect, plain bundle
     - import styles from './x.module.css'  → module, hash map

2. For each .css file:
     - Pipe through Tailwind compile (so @apply resolves)
     - Plain .css  → emit <distDir>/css/components/<sha8>.css
     - .module.css → Lightning CSS with cssModules:true →
                     emit <distDir>/css/components/<sha8>.css
                     + capture name map { primary: "primary_<hash>" }

3. Write manifest <distDir>/css/component-manifest.json:
     {
       "modules": {
         "/abs/path/to/Button.module.css": {
           "chunk":   "/_brust/css/components/<sha8>.css",
           "exports": { "primary": "primary_a3b9", ... }
         },
         "/abs/path/to/foo.css": {
           "chunk":   "/_brust/css/components/<sha8>.css",
           "exports": null    // side-effect import
         }
       },
       "routeChunks": {
         "/":             ["/_brust/css/components/<sha1>.css", ...],
         "/blog/{slug}":  [...]
       }
     }

4. Write co-located .d.ts (gitignored via *.module.css.d.ts):
     declare const styles: { readonly primary: string; ... }
     export default styles

RUNTIME (SSR + dev boot)
─────────────────────────────────────────────────────────────────
brust.run() registers a Bun.plugin (main + workers):
  onLoad({ filter: /\.module\.css$/ }, ({ path }) => {
    const mod = manifest.modules[path]
    return {
      contents: `export default ${JSON.stringify(mod?.exports ?? {})}`,
      loader:   'js',
    }
  })
  onLoad({ filter: /\.css$/ }, () => ({
    contents: '', loader: 'js',   // side-effect; nothing at JS layer
  }))

Renderer (per request):
  - route.fullPath matches a key in manifest.routeChunks
  - hrefs = ['/_brust/css/app.css', ...routeChunks[route.fullPath]]
  - injectCssLink(body, hrefs)   ← existing helper, multiple <link>s

DEV MODE (file watch)
─────────────────────────────────────────────────────────────────
.css / .module.css change → coordinator:
  - rerun affected build steps
  - update manifest in memory + on disk
  - if exports name set changed (rename / add / remove) → broadcast 'reload'
    (because the bundled JS-side hash map for already-shipped islands is now stale)
  - else                                                 → broadcast 'css-update'
    per affected chunk with ?v=<ms> cache-bust
```

**Key contract:** SSR + client hydrate use the SAME hash map (read from manifest at module load via Bun.plugin). React does not see a className mismatch.

---

## Decisions locked

| Question | Decision |
|---|---|
| Scope | Both plain CSS imports AND CSS Modules. |
| Output strategy | Per-route chunking. Build-time manifest maps `route.fullPath` → CSS hrefs. |
| TypeScript typing | Auto-generate `.d.ts` next to each `.module.css`. Gitignored via `*.module.css.d.ts`. |
| Hash style | `sha256(<relative_path_from_scanRoot>:<class_name>).slice(0, 8)`. Deterministic across runs. Append after the original class name (`primary_a3b9`). |
| Dev hot-reload | CSS hot-swap on content change; full reload on exports-set change. |
| `@apply` support | Yes — component CSS is piped through the Tailwind compiler before Lightning CSS. |
| Processing engine | Lightning CSS (`lightningcss` npm). Single dep; modules + bundle in one API. |

---

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `runtime/css/scan-imports.ts` | Walk TS/TSX in scanRoot, parse each file with TypeScript compiler API, return per-file CSS imports: `{ source, cssDeps: [{ path, isModule, importedName }] }`. |
| `runtime/css/process-modules.ts` | `processCssFile({ entry, isModule, tailwindCompile })`. Pipes file through Tailwind (resolves `@apply`), then through `lightningcss` with `cssModules: true` for `.module.css`. Returns `{ code: string, exports: Record<string,string> \| null }`. |
| `runtime/css/component-build.ts` | Orchestrator. `buildComponentCss({ scanRoot, outDir, tailwindCompile, routes })` — scan + process every CSS file, write chunk files, write `component-manifest.json`, write `.d.ts` files. Returns the in-memory manifest for the caller. |
| `runtime/css/component-loader.ts` | Bun.plugin factory `cssLoaderPlugin(manifest)`. Registers `onLoad` for both `.css` and `.module.css`. |
| `runtime/css/route-deps.ts` | `computeRouteChunks(routes, scan)` — for each route, statically walk its `Component:` source's import graph, collect CSS deps. Returns `Record<route.fullPath, string[]>`. |
| `runtime/css/manifest.ts` | Type defs + read/write helpers for `component-manifest.json`. |
| `runtime/css/scan-imports.test.ts` | Unit: parse fixture .tsx files with various import forms. |
| `runtime/css/process-modules.test.ts` | Unit: .module.css → hashed output + exports; .css → passthrough; @apply with Tailwind. |
| `runtime/css/component-build.test.ts` | Unit: tmp project → run buildComponentCss → assert chunk files, manifest, .d.ts files. |
| `runtime/css/component-loader.test.ts` | Unit: plugin's onLoad returns correct JS for known module path + no-op for plain CSS. |
| `runtime/css/route-deps.test.ts` | Unit: synthetic route → expected chunk list. |

**Modified files:**

| File | Change |
|---|---|
| `runtime/cli/build.ts` | New step 4.6 (between Tailwind compile and prebuilt-actions): if any `.css`/`.module.css` exists in source tree, call `buildComponentCss`. Bun.build's `plugins` array gets `cssLoaderPlugin` so bundled output bakes in resolved class maps. |
| `runtime/index.ts::brust.run()` | Both main + worker branches: if scanCssImports finds CSS files, call buildComponentCss, load manifest, `Bun.plugin(cssLoaderPlugin(manifest))`. Main also seeds `configureCssHrefsForRoute(routePath, hrefs)` from `manifest.routeChunks`. |
| `runtime/css.ts` | Extend the existing `cssHrefs` store with a parallel route-keyed map: `configureCssHrefsForRoute(routePath, hrefs)` + `getCssHrefsForRoute(routePath): readonly string[]`. The existing `getCssHrefs()` continues to return the global hrefs (`/_brust/css/app.css`). |
| `runtime/render/stream.ts` | Renderer reads `route.fullPath` from the dispatch envelope (the existing route table makes this available). Combines `getCssHrefs()` + `getCssHrefsForRoute(fullPath)` and passes to `injectCssLink`. |
| `runtime/dev/coordinator.ts` | New `kind: 'component-css'` branch. On change: rerun buildComponentCss for the affected file, compare new manifest.modules entry's exports vs cached. If exports changed → broadcast `{type:'reload'}`; else broadcast `{type:'css-update', href: chunk + '?v=' + Date.now()}`. |
| `runtime/dev/watcher.ts::classifyPath` | Distinguish `.module.css` and plain `.css` from `app.css`. Add cases — `app.css` keeps kind `'css'`; other `.css`/`.module.css` get kind `'component-css'`. Generated `.module.css.d.ts` returns `null` (ignored). |
| `package.json` (root) | Add `lightningcss` to `dependencies`. |
| `.gitignore` (root + `example/hello-world/`) | Add `*.module.css.d.ts`. |
| `architecture.md` | Promote component CSS imports + Modules to Built; describe per-route chunking + manifest + plugin loader. |
| `tests/cli-build.test.ts` | Add 2 cases: a route with `.module.css` builds + serves correctly; manifest has expected route mapping. |

**Zero Rust changes.**

---

## Bun.plugin loader

Reads the on-disk manifest at boot. Both `.css` and `.module.css` get JS-side no-ops; the real CSS lives on disk + ships via `<link>`.

```ts
// runtime/css/component-loader.ts
import type { BunPlugin } from 'bun'
import type { ComponentCssManifest } from './manifest.ts'

export function cssLoaderPlugin(manifest: ComponentCssManifest): BunPlugin {
  return {
    name: 'brust-component-css',
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, ({ path }) => {
        const mod = manifest.modules[path]
        if (!mod) {
          // file imported but not in manifest — log + return empty (build
          // error surfaces via dev overlay or build exit later)
          return { contents: 'export default {}', loader: 'js' }
        }
        return {
          contents: `export default ${JSON.stringify(mod.exports ?? {})}`,
          loader: 'js',
        }
      })
      build.onLoad({ filter: /\.css$/ }, () => ({
        contents: '',
        loader: 'js',
      }))
    },
  }
}
```

**Registration site:** `brust.run()` calls `Bun.plugin(cssLoaderPlugin(manifest))` once per isolate (main + each worker) after loading the manifest. Bun.plugin registrations are global within an isolate and persist for the process lifetime — Bun.build invocations later (e.g. `brust build`'s server bundle step) also see the plugin if the same isolate runs them.

---

## CSS-Modules hash format

```ts
import { createHash } from 'node:crypto'

function moduleClassName(relPath: string, className: string): string {
  const h = createHash('sha256').update(relPath).update(':').update(className).digest('hex').slice(0, 8)
  return `${className}_${h}`
}
```

- `relPath` is the file's path relative to `scanRoot` (so the hash is independent of absolute filesystem location — same project boots identically on dev machines and CI).
- Result: `.primary` → `.primary_a3b94f12` (8 hex chars).
- Stable across runs as long as path + name don't change.
- Collision odds with 8 hex chars: ~1 in 4 billion per class pair. We accept; the build logs a warning if Lightning CSS reports any internal collision.

Lightning CSS exposes a `cssModules` option that accepts a custom name generator. We pass our hash function so the output is consistent with the `exports` map written to the manifest.

---

## Manifest shape

```ts
// runtime/css/manifest.ts
export interface ComponentCssManifest {
  /** Module-keyed by absolute path (matches what Bun.plugin's onLoad sees). */
  modules: Record<string, {
    /** Absolute href under /_brust/css/components/<sha>.css */
    chunk:   string
    /** null for side-effect (.css) imports; map for .module.css */
    exports: Record<string, string> | null
  }>
  /** Route fullPath → ordered list of CSS chunk hrefs. */
  routeChunks: Record<string, string[]>
  /** Manifest format version — bump on shape break. */
  version: 1
}
```

Written to `<outDir>/css/component-manifest.json` at build time, read at boot.

---

## Per-route walker

`computeRouteChunks` walks the import graph from each route's `Component` reference:

1. Start from `routes.tsx` — find each route's `Component:` identifier and the file it's imported from.
2. Walk that file's `import` statements via TS compiler API.
3. Recurse into local imports (anything resolving inside `scanRoot`, not into `node_modules`).
4. Collect every `.css` / `.module.css` import along the way.
5. Map each collected import path → its chunk href via the manifest's `modules` table.
6. Output: `routeChunks[route.fullPath] = ordered, deduplicated href list`.

**Why static:** we explicitly skip `await import()` — dynamic imports aren't followed. If a user lazy-imports a component, its CSS won't appear in the route's chunk list. The component would still SSR correctly (Bun.plugin still resolves the `.module.css` to its hash map), but its CSS chunk wouldn't load → unstyled until the user hard-refreshes. Documented as a known limitation; future enhancement (out of scope here).

---

## Renderer wiring

```ts
// runtime/render/stream.ts (sketch — applied to both buffering + streaming paths)
const globalHrefs = getCssHrefs()                              // [app.css]
const routeHrefs  = getCssHrefsForRoute(envelope.fullPath)     // route-specific
const hrefs       = [...globalHrefs, ...routeHrefs]            // app.css FIRST
body = injectCssLink(body, hrefs)
```

`app.css` is injected first so Tailwind preflight + theme variables come before component styles. Order within `routeHrefs` is deterministic per-route (sorted by file path) so the cascade is stable across builds.

---

## Dev mode hot-reload behavior

`runtime/dev/watcher.ts::classifyPath` distinguishes file kinds:

| Path | Kind |
|---|---|
| `<scanRoot>/app.css` | `'css'` (Tailwind pipeline, existing) |
| `*.module.css.d.ts` | `null` (generated file, ignored) |
| `<scanRoot>/**/*.module.css` | `'component-css'` (NEW) |
| `<scanRoot>/**/*.css` (other) | `'component-css'` (NEW) |

`runtime/dev/coordinator.ts` gains the `'component-css'` branch:

```ts
case 'component-css': {
  const before = manifest?.modules[changedPath]?.exports
  await this.deps.buildComponentCss({ scanRoot, outDir, tailwindCompile, routes })
  const after  = manifest?.modules[changedPath]?.exports
  if (!exportsEqual(before, after)) {
    // exports renamed or added/removed → bundled JS-side map is stale
    await this.deps.broadcast({ type: 'reload' })
  } else {
    const href = manifest.modules[changedPath]?.chunk
    if (href) {
      await this.deps.broadcast({
        type: 'css-update',
        href: `${href}?v=${Date.now()}`,
      })
    }
  }
  break
}
```

`exportsEqual(a, b)` returns true if both are null or both have the same key set (values are derived from path+key, so if keys match values match).

CSS-only content change → live `<link>` swap, page state preserved. Class-name change → full reload (because the JS modules that reference the names have stale hashes — only a fresh module import picks up the new map).

---

## Error handling

| Failure | Where | Behavior |
|---|---|---|
| `lightningcss` not installed | dynamic import in `processCssFile` | Throw `bun add lightningcss`. Build exits 1; dev → red overlay. |
| `.module.css` syntax error | Lightning CSS parser | Catch + rethrow with file + diagnostic. Build exits 1; dev → red overlay. Prior good chunk on disk untouched. |
| `@apply` references unknown utility | Tailwind compile step | Tailwind's diagnostic propagates verbatim. Same overlay pattern. |
| Imported `.module.css` doesn't exist on disk | scan-imports | Skip silently — TS will report during user's typecheck. |
| `styles.notDefined` used in code | Runtime | `undefined` ends up in className. Page renders, class missing. `.d.ts` would have caught it at typecheck. |
| Manifest read fails at boot | brust.run | Treat as "no component CSS"; log warning; no crash. |
| Bun.plugin sees an unknown path | onLoad | Return empty exports + warn once. Next dev rebuild refreshes manifest. |
| Per-route lookup miss | Renderer | Empty array. Page renders without route-specific CSS. `app.css` still applied. |
| Hash collision | Build | Lightning CSS validates uniqueness — would throw. We re-throw with hint. |
| Watcher fires for generated `.d.ts` | classifier | Returns `null`. Ignored. |
| Edit during in-flight render | Coordinator | Single-flight drops the change (existing behavior). Next save retries. |
| No Tailwind compiler (no `app.css`) | processCssFile | Skip Tailwind step. `@apply` left literal → browser ignores. Log info once. |

**Invariants:**
- Renderer NEVER crashes over CSS state.
- Build phase fails loudly; dev mode fails noisily (overlay) but main process survives.
- Old chunks on disk stay until next successful rebuild — no torn state.

---

## Backward compatibility

- Projects without any `.css`/`.module.css` imports see zero new behavior (component build step is a no-op skip).
- Existing Tailwind v4 flow (`app.css` only) is unchanged — its pipeline runs first, component build is layered on top.
- Production bundles (`brust build`) still emit a self-contained `dist/`; new files at `dist/css/components/*.css` + `dist/css/component-manifest.json` are added but no removal.
- `bun run dist/index.js` reads the prebuilt manifest from `<distDir>/css/component-manifest.json` — same code path as dev mode after manifest load.

---

## Testing

### Unit

- `runtime/css/scan-imports.test.ts`: fixture .tsx files with various import forms (default `.module.css`, side-effect `.css`, no-CSS, mixed) → assert dep lists.
- `runtime/css/process-modules.test.ts`: `.module.css` with 3 classes → hashed output + exports; plain `.css` → passthrough; `@apply` resolution.
- `runtime/css/component-build.test.ts`: tmp project (one .module.css + one .css) → buildComponentCss → assert chunks, manifest, .d.ts.
- `runtime/css/component-loader.test.ts`: synthetic manifest + simulated onLoad call → correct JS string returned.
- `runtime/css/route-deps.test.ts`: synthetic route + import graph → expected chunk list (deduplicated, sorted).

### Integration: extend `tests/cli-build.test.ts`

- Build a fixture with one route using `.module.css` → assert `dist/css/components/<sha>.css` exists.
- Assert `dist/css/component-manifest.json` has expected `modules` + `routeChunks`.
- `GET /_brust/css/components/<sha>.css` returns 200 + `text/css`.
- SSR HTML for `/` contains `className="primary_<8-char-hash>"` (Bun.plugin resolved the import at SSR).
- SSR HTML contains all expected `<link>` tags for the route (in addition to `app.css`).

### Real-browser smoke (Chrome MCP) — non-negotiable

1. `brust dev example/hello-world/index.ts` (already running with Tailwind shipped).
2. Migrate one component to use `.module.css`:
   ```tsx
   import styles from './Counter.module.css'
   <button className={styles.counter} />
   ```
3. Verify Counter renders with hashed class; chunk loads (network request); button restyles per CSS.
4. Edit `Counter.module.css` color (no new class) → CSS hot-swap, no page reload, button restyles.
5. Edit `Counter.module.css` to add a new class → `{type:'reload'}`, page reloads, new class available.
6. Counter island hydrates + click still works after each iteration.
7. Edit `.module.css` to introduce syntax error → red overlay; fix → overlay clears.

### Existing baselines after change

- Rust: 99 (no change).
- Runtime: 160 + ~12 new = ~172.
- Integration: 77 + 2 new = 79.

---

## Documentation

- `architecture.md`:
  - Add to Built list: component CSS imports + Modules — describe per-route chunking, Bun.plugin loader, manifest, hash format.
  - Cross-reference Tailwind v4 + dev tooling entries.
- `example/hello-world/`: migrate at least one component to `.module.css` as the canonical example.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Lightning CSS native binary not present on host platform | Lightning CSS ships prebuilts for darwin/linux/windows on x64+arm64. Same concern as `@tailwindcss/oxide` — we already accept this. |
| Bun.plugin registered in main but Bun.build still inlines the actual `.module.css` text | Plugin's `onLoad` fires for every matched path, including during bundling. Verified pattern in Tailwind sub-project (where the `customCssResolver` runs in the same isolate). |
| Worker isolate doesn't see the plugin | Each worker re-imports the runtime entry; brust.run worker branch re-registers the plugin. Same pattern as the dev-tooling `installWorkerBroadcastListener`. |
| User has a CSS file inside a hidden directory or symlink path | scan-imports respects the same ignores as the existing watcher (`node_modules`, `.git`, `.brust`, `dist`). Symlinks resolved via `realpath` once. |
| Tailwind compile step taking long on many CSS files | Tailwind v4's compile is fast (~50ms per file). For projects with >100 CSS files, we'd revisit; MVP accepts the cost. |
| `@apply` only resolves if Tailwind compiler is available | Documented. If no `app.css`, `@apply` is left literal → silent breakage. Log info once at boot. |

---

## Acceptance criteria

1. `import styles from './x.module.css'` returns a name map with hashed class names; `styles.foo` typechecks against an auto-generated `.d.ts`.
2. `import './foo.css'` contributes to the route's CSS chunk; the file's class names appear unchanged in the chunk.
3. `brust build example/hello-world/index.ts` emits `dist/css/components/<sha>.css` files and `dist/css/component-manifest.json` with the expected route mapping.
4. `bun run dist/index.js` serves `/_brust/css/components/<sha>.css` (200 + text/css) and SSR HTML contains the expected `<link>` tags + resolved class names.
5. `brust dev` hot-swaps CSS for content-only edits; full-reloads for class-name changes; surfaces syntax errors via the red overlay.
6. Real-browser Chrome MCP smoke: Counter migrated to `.module.css` works end-to-end (renders, hot-swap, reload, errors clear).
7. Baselines: Rust 99 / Runtime ~172 / Integration 79 — all green.
8. Projects without any component CSS see zero behavior change.
