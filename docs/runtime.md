# The client runtime

A page loads a small core and only the feature modules its components use (L33, F139). The compiler decides; the server links exactly that set.

## What a page loads

`brust build` writes these files to `dist/client/` (all content-hashed, served `immutable`):

| file | what | loaded |
|---|---|---|
| `runtime-<hex>.js` | the core: signals, `defineBehavior`, `mount`, the binder registry; mounts the document | every page with a native or React component |
| `rt-basics-<hex>.js` | `x-text`, `x-show`, `x-bind-*`, `x-on-*`, `x-ref` | pages whose output uses one of them |
| `rt-if-`, `rt-for-`, `rt-model-`, `rt-html-` | one directive each | pages that use it |
| `rt-island-<hex>.js` | React island hydration glue | pages with a React island |
| `rt-store-<hex>.js` | `defineStore` and the reactive primitives a store imports | pulled in by the chunks that import a store (no tag) |

Core and features are single shared ESM files: two components on a page share one signal graph and one binder registry, and a feature file is cached across pages because it is per feature, not per route.

## How the set is chosen

1. The compiler's output is the source of truth. `src/build/features.ts` reads each component's template: an `x-*` attribute on a tag maps to a module (`x-text`/`x-show`/`x-bind-*`/`x-on-*`/`x-ref` → `basics`, `x-if`/`x-for`/`x-model`/`x-html` → their own module; `x-data`/`x-props*`/`x-raw` belong to the core); a React-tier component needs `island`.
2. `manifest.json` records it: `components[id].features` (load order) and `assets.features` (module name → file).
3. The server unions `features` over the components a route renders (the layout chain, inlined children, island targets) and writes, before `</body>`: the store tags, the core, the needed feature modules, then the component chunks. Module scripts run in document order, so every binder exists before a behavior defines.
4. A directive no module binds is a build error (`runtime-feature-missing`), and a manifest that lists a feature `assets.features` lacks fails `brust start` (`MissingFeature`). Nothing is a silent no-op in the browser.

## Budget

`docs/runtime-budget.json` holds the gzip budget of the core and of each module (first set at the measured size + 10%). `cd packages/runtime-dom && bun scripts/size.ts --check` (CI, `runtime-dom` job) fails when one grows; raise the number in the PR that grows it and put the reason in the file's `reason` line.

## Adding a feature

Follow the rule in `packages/runtime-dom/README.md` ("Feature modules"): a new feature is its own module under `src/features/`, registered with the core on import, listed in `RUNTIME_FEATURES` and `featureOfAttr` (`src/build/features.ts`), and given a budget line.
