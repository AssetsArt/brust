# Spec B — Native interactivity via DOM directives

> **Status:** design · 2026-06-03 · target release 0.1.22-alpha
> **Decomposition:** **Spec B** of the two-spec store feature. Spec A
> (`2026-06-02-isomorphic-store-core-design.md`) shipped the isomorphic store
> (`signal`/`computed`/`effect`/`batch` + `defineStore`, client `window`
> singleton, server per-request ALS, React `useStore`). Spec B adds **client-side
> interactivity to native (jinja) pages** without React islands, built on Spec A's
> reactive core.

## Goal

Let a `native: true` page be interactive — reactive text, show/hide, attribute
binding, event handlers, list rendering — **without** authoring a React island.
This closes the last reason pokedex native pages still embed React: today the
"Add to team" button is a client-only React island (`components/AddToTeamButton.tsx`).
Spec B turns it into a **native interactive component**: one `.tsx` file whose JSX
template compiles to jinja (server-rendered, unchanged compiler path) and whose
co-located `behavior` function is bundled to a client runtime that binds the DOM to
the store via Alpine.js-style directives.

The dogfood proves **cross-paradigm store sharing**: the native directive button and
the React island `TeamBuilder` dock resolve the *same* `teamStore` window singleton
(Spec A's S4 fix) — a native `x-on-click` mutation is observed reactively by a React
island on the same document.

Spec B delivers:

1. A **directive runtime** (`runtime/native/`, react-free, dom-only) that scans the
   DOM for `x-*` directives and binds them to component instances via Spec A's
   `effect`. A `MutationObserver` (Alpine-style) handles initial load, SPA-nav swaps,
   and dynamic content uniformly — no coupling to the React islands bootstrap.
2. **Single-file native interactive components**: a `.tsx` with a `default` export
   (JSX template → jinja, existing compiler) **and** a co-located
   `export const behavior` (client logic → bundle). The build extracts and registers
   `behavior` under the component name (derived from filename); the template references
   it with `x-data`.
3. A **build step** (`runtime/native/build.ts`, mirrors `runtime/islands/build.ts`)
   that scans the routes graph for behavior-bearing components, generates a
   registration entry, `Bun.build`s a self-contained `_directives.js`, and **bakes its
   `<script>` tag into the jinja** at build time (mirrors `reconcileIslandManifest`'s
   `{% raw %}…{% endraw %}` bootstrap baking) — **no Rust change, no compiler change.**
4. The **v1 directive set** (Scheme 1 — JSX-safe, no `:`/`@`, all lowercase+hyphen so
   the native compiler passes them through as static string attrs):
   `x-data` · `x-props` · `x-text` · `x-show` · `x-bind-<attr>` · `x-on-<event>` · `x-for`.
5. **Dogfood:** `AddToTeamButton` converted from a React island to a native
   interactive component; `TeamBuilder` stays a React island (showcase of
   island↔directive store sharing).

## Non-goals (loud)

- **No native store-snapshot injection.** Spec A deferred native snapshot delivery to
  Spec B; Spec B **defers it again** (Option A, decided at brainstorm). The dogfood
  `teamStore` is client-only and seeds via the behavior's `init()` action fetch — there
  is **no server-seeded native store** in pokedex, so injecting a per-request snapshot
  into native HTML has no consumer in v1. Adding it later is the build-baked jinja
  placeholder `<script data-brust-store-snapshot>{{ __brust_stores | safe }}</script>`
  filled from `collectSnapshot()` via the existing SAB context — a follow-up (Spec B.1),
  not this spec. **Spec B touches no Rust and no compiler.**
- **No inline expression evaluation (`new Function`/`with`).** Logic lives in the typed
  `behavior` module; directives reference **member names** (`x-text="label"`) or, inside
  `x-for`, **dotted member paths** (`x-text="item.name"`) resolved by a tiny path
  resolver. No JS is evaluated from attribute strings (CSP-safe, XSS-safe).
- **No Alpine `:`/`@` shortcuts, no `x-on:click` colon form.** The native compiler
  rejects namespaced (`:`) attributes (`lower.rs` `NamespacedAttrNotSupported`) and
  `on[A-Z]` handlers (`EventHandlerNotSupported`). v1 uses hyphenated lowercase names
  only.
- **No SPA navigation in the directive runtime.** Native SPA nav stays owned by the
  islands bootstrap (`runtime/islands/bootstrap.ts`); a native page with directives but
  **zero** islands does full-reload navigation (directives re-init on load). pokedex
  keeps `TeamBuilder` as an island, so its pages still load the bootstrap and SPA-nav
  normally.
- **No keyed `x-for` diff.** v1 `x-for` does whole-list re-render on change (remove +
  recreate). Fine at pokedex scale; keyed reconciliation is a later optimization.
- **No `x-if`, `x-model`, `x-effect`, `x-init` as a separate directive, `x-html`,
  transitions, or magics (`$el`/`$refs`/`$dispatch`).** v1 is exactly the 7 directives
  above. `init()` is a reserved method on the instance (run once after instantiate),
  not a directive.

## High-level architecture

```
AUTHORING (single .tsx file)
  default export  → JSX template (native constraints) → compiler → .jinja  (server, UNCHANGED path)
  export behavior → ({el, props}) => ({ ...signals/computeds, ...methods, init? })  → client bundle

BUILD (brust build / brust dev — runtime/cli/build.ts, runtime/cli/dev.ts)
  scanDirectiveComponents(routesEntry)  ── BFS routes graph; a component is "interactive"
        │                                   iff its source has `export const behavior`
        │                                   AND a native template references x-data="<name>"
        ▼
  buildDirectives(components, {outDir})  ── mirrors buildIslands:
        1. generate registration entry: register(name, behavior) for each, then start()
        2. Bun.build → <outDir>/islands/_directives.js   (self-contained, react tree-shaken out)
        ▼
  bake DIRECTIVES_BOOTSTRAP <script> into each native .jinja that uses x-data
        (mirrors reconcileIslandManifest's {% raw %}bootstrap{% endraw %} append)

RUNTIME (browser — runtime/native/runtime.ts, shipped in _directives.js)
  start() ── scan document for [x-data], instantiate; MutationObserver for add/remove
  per [x-data="name"]:
     instance = factory({ el, props: JSON.parse(el@x-props || '{}') }); instance.init?.()
     walk subtree (stop at nested x-data):
        x-text        → effect(() => el.textContent = read(scope,'member'))
        x-show        → effect(() => el.style.display = read(...) ? '' : 'none')
        x-bind-<attr> → effect(() => setBound(el, attr, read(...)))
        x-on-<event>  → el.addEventListener(event, (e) => callMethod(scope,'member',e))
        x-for="i in m"→ effect(() => render list from read(scope,'m'); per item child scope {i})
     dispose: MutationObserver removal → stop all effects + listeners under the node

STORE (Spec A — UNCHANGED)
  behavior imports { signal, computed } from 'brustjs/store'  (window singleton on client)
  → teamStore.members.set(...) in a native handler is observed by useStore(teamStore) in a React island
```

### Directive runtime (`runtime/native/runtime.ts`)

React-free, DOM-only. Built on `effect` from `brustjs/store`.

```ts
type Behavior = (ctx: { el: HTMLElement; props: any }) => Record<string, unknown>
export function register(name: string, behavior: Behavior): void   // registry: Map<string, Behavior>
export function start(root?: ParentNode): void                     // scan + MutationObserver (idempotent)
```

- **`start()`** (called once by the generated entry): scans `root ?? document` for
  `[x-data]` not already mounted, mounts each, then attaches a single
  `MutationObserver(document.body, {childList,subtree:true})`: added subtrees are scanned
  for `[x-data]`, removed subtrees are disposed. Idempotent — a second `start()` is a
  no-op (guarded by a module flag). On DOMContentLoaded if the body isn't ready yet.
- **Mount** (`[x-data="name"]`): resolve the registered `name` (unknown → `console.warn`
  + skip, forward-compatible). Parse props: `JSON.parse(el.getAttribute('x-props') ?? '{}')`
  (the browser has already HTML-unescaped the attribute the compiler emitted as
  `{{ (data) | e }}`). Call `behavior({ el, props })` → instance. Store `{instance, disposers[]}`
  on the element via a `WeakMap`. Run `instance.init?.()` (may be async; errors logged, not
  thrown). Then bind the subtree.
- **Subtree walk:** depth-first from the `x-data` element; **do not descend into a nested
  `[x-data]`** (it owns its own subtree, mounted separately). For each element, read its
  directive attributes and set up bindings/listeners. The `x-data` element itself is
  bindable (can carry `x-show`, etc.).
- **`read(scope, path)`:** `scope` = the instance object, optionally extended with an
  `x-for` loop binding (`{ [itemName]: value }`, prototype-chained to the instance so
  `label`/methods stay visible). Resolve `path` left-to-right by member access
  (`item.name`, `props.id`). At the **leaf**, if the resolved value is a `signal`/`computed`
  (branded) or a function → call it to obtain the reactive value (this is the read that
  `effect` tracks); else use the value as-is. A missing member → `undefined` (warn once).
- **`callMethod(scope, name, event)`:** resolve `name` on scope; if a function, call with
  `(event)`; else warn.
- **`setBound(el, attr, value)`:** boolean-ish DOM props (`disabled`, `checked`,
  `hidden`, `readonly`, `required`, `selected`) set the **property** and reflect/remove the
  attribute by truthiness; `class` sets `className`; `value` sets the property; everything
  else `setAttribute(attr, String(value))` (or `removeAttribute` when `value == null`/`false`).
- **`x-for="<item> in <member>"`:** parse once (regex `^\s*(\w+)\s+in\s+([\w.]+)\s*$`; bad
  syntax → warn + skip). The `x-for` element is the **template**: capture its outerHTML
  minus the `x-for` attr, then run an `effect` that reads `member` (reactive), and on each
  run replaces the rendered siblings with one clone per item. Each clone is bound with a
  child scope `{ [item]: value }`. v1 = full re-render per change (documented limitation).
  Clones are tracked in a comment-anchored range so re-render is scoped to this directive.

### Reactivity binding (built on `effect`)

Each binding directive creates one `effect(() => { const v = read(...); applyToDom(v) })`.
`effect` (Spec A `signal.ts`) runs immediately, tracks the signals/computeds read inside,
and re-runs on change — synchronous notify. Disposers returned by `effect` are collected
per `x-data` instance and called on removal. `x-on-*` is **not** an effect (one
`addEventListener`; the listener is removed on dispose). This is the `effect` consumer Spec
A built the primitive for.

### Single-file component shape

```tsx
// components/AddToTeamButton.tsx
import { signal, computed } from 'brustjs/store'   // reactive core — react-free
import { client } from 'brustjs/client'            // treaty action client — react-free (treaty.ts)
import { teamStore } from '../stores/team'
import type { Actions } from '../actions'

export interface AddProps { id: string; name: string; displayName: string; num: string; types: string[]; artwork: string }

const api = client<Actions>()

// behavior → client bundle, registered as "addToTeamButton" (camelCase of filename).
export const behavior = ({ props }: { props: AddProps }) => {
  const busy = signal(false)
  const toast = signal<string | null>(null)
  const inTeam = computed(() => (teamStore.members() ?? []).some((m) => m.id === props.id))
  const label = computed(() => (inTeam() ? '✓ In your team' : '＋ Add to team'))
  const btnClass = computed(() => `aa-btn aa-btn--full${inTeam() ? ' aa-btn--secondary' : ''}`)
  const showToast = computed(() => toast() !== null)
  async function init() {
    const r = await api.team.get()
    if (r.data) teamStore.members.set(r.data.team)
  }
  async function toggle() {
    busy.set(true)
    try {
      if (inTeam()) {
        const { data } = await api.team({ id: props.id }).delete()   // bodyless DELETE OK (GAPS S12 fixed)
        if (data) teamStore.members.set(data.team)
      } else {
        const { data } = await api.team.post(props)
        if (data?.full) { toast.set('ทีมเต็มแล้ว · สูงสุด 6 ตัว'); setTimeout(() => toast.set(null), 2200) }
        else if (data) teamStore.members.set(data.team)
      }
    } finally { busy.set(false) }
  }
  return { busy, toast, inTeam, label, btnClass, showToast, init, toggle }
}

// default → jinja (server). directives are static string attrs (compiler passthrough).
export default function AddToTeamButton({ data }: { data: string }) {
  return (
    <div x-data="addToTeamButton" x-props={data} className="aa-add" style={{ position: 'relative' }}>
      <button
        type="button"
        x-text="label"
        x-bind-class="btnClass"
        x-bind-disabled="busy"
        x-on-click="toggle"
        className="aa-btn aa-btn--full"
        style={{ width: '100%' }}
      >
        ＋ Add to team
      </button>
      <div x-show="showToast" x-text="toast" className="aa-toast" />
    </div>
  )
}
```

`data` is loader-precomputed (`addProps: JSON.stringify({ id, name, displayName, num, types, artwork })`),
emitted by the compiler as `x-props="{{ (data) | e }}"` (attribute-escaped → XSS-safe; the
browser unescapes it for `getAttribute`). Detail page: `<AddToTeamButton data={d.addProps} />`.

### Build pipeline (`runtime/native/build.ts` + wiring)

Mirrors `runtime/islands/build.ts`:

```ts
// scanDirectiveComponents(routesEntryFile): Map<registerName, sourcePath>
//   BFS the local import graph (reuse scanImports). A file qualifies iff its source
//   matches /export\s+const\s+behavior\b/. registerName = camelCase(basename without ext)
//   = lowercased-first-char (AddToTeamButton → addToTeamButton); collisions across files
//   → throw (mirrors islands' app-unique id rule). Returns the components to bundle.
//   (An x-data cross-reference check — "is this behavior actually used by a template" — is
//   deferred YAGNI: registerName is filename-derived so x-data must match it anyway, and a
//   bundled-but-unreferenced behavior is harmless — start() simply finds no matching element.)
export function scanDirectiveComponents(routesEntryFile: string): Map<string, string>

// buildDirectives(components, {outDir}): writes <outDir>/_directives.js (and nothing if empty)
//   1. generate an in-memory entry:
//        import { register, start } from 'brustjs/native'
//        import { behavior as addToTeamButton } from '<abs source>'
//        register('addToTeamButton', addToTeamButton)
//        ...
//        start()
//   2. Bun.build({ entrypoints:[tmpEntry], outdir, naming:'_directives.js',
//                  format:'esm', target:'browser', minify:true, external:[],   // NO externals — self-contained
//                  define:{'process.env.NODE_ENV':'"production"'} })
//   3. ASSERT react is not bundled — scan the output text for a concrete react marker
//      (e.g. a react-dom / react internal symbol or the importmap bare specifier 'react'),
//      NOT a size threshold (treaty.ts + signal.ts are tiny, so a size guard false-passes/
//      fails). A hit means a behavior imported a react-pulling symbol (e.g. useStore) →
//      fail the build loud.
export async function buildDirectives(components, options): Promise<{ outDir: string; count: number }>
```

`DIRECTIVES_BOOTSTRAP = '<script type="module" src="/_brust/islands/_directives.js" defer></script>'`
(new const beside `ISLANDS_IMPORTMAP_AND_BOOTSTRAP`). Served from the existing
`/_brust/islands/` static route (underscore-prefixed, passes `is_safe_island_filename`) —
**no Rust change**.

**Baking into jinja:** `emitNativeTemplates` (native-routes-emit.ts), after compiling each
template, knows whether the template references `x-data` (scan `compiled.template` for
`x-data=`). If so, append `{% raw %}${DIRECTIVES_BOOTSTRAP}{% endraw %}` to the `.jinja`
(idempotent guard like the islands bake). This is independent of islands — a directives-only
page (no `<Island>`) still gets the script. The wrap is `{% raw %}` for symmetry/safety even
though the tag has no `{{`/`}}`.

**Wiring in `build.ts`:** after the islands build block, add a directives build block:
`scanDirectiveComponents(routesFile)` → if non-empty, `buildDirectives(..., {outDir:
<outDir>/islands})` and mirror into `cwd/.brust/islands` (same dual-write the islands block
does for the source runtime). **Hard ordering requirement:** directives build runs *after*
`buildIslands`, because `buildIslands` starts with `rm -rf outDir` (`islands/build.ts:100`) —
running directives first would wipe `_directives.js`. The directives block must **also create
`<outDir>/islands` itself** (`mkdir -p`): when `islandMap.size === 0` the entire islands block
is skipped (`build.ts:247`) and the dir is never created, but a directives-only app still needs
it.

**Dev (`dev.ts`) — NO islands/directives bundle build (matches the existing islands story).**
`dev.ts` does not build islands; it only `emitNativeTemplates` and relies on a prior `brust
build` having produced `.brust/islands` (repo rule: "must `brust build` before run"). So in dev
the **jinja `x-data` bake happens for free** — it lives in `native-routes-emit.ts`
(`emitNativeTemplates`), which both `build` and `dev` call — but the **`_directives.js` bundle
comes from `brust build`** (stale/absent otherwise, exactly like island chunks today). `dev.ts`
needs **no edit**; the bake is in `native-routes-emit.ts`.

### Package export

Add `"./native": "./runtime/native/index.ts"` to `package.json` `exports`.
`runtime/native/index.ts` re-exports `{ register, start }` from `runtime.ts` (internal
surface for the generated entry). Authors do **not** import it — they import `signal`/`computed`
from `brustjs/store` and `client` from `brustjs/client`. `runtime/native/index.ts` is
react-free and dom-only (safe to bundle for the browser).

## File structure

```
runtime/native/
  runtime.ts          # register, start, mount, bind, read, callMethod, setBound, x-for  (new)
  runtime.test.ts     # directive runtime units (happy-dom)                               (new)
  build.ts            # scanDirectiveComponents, buildDirectives                          (new)
  build.test.ts       # scan + generated-entry + react-leak-guard units                  (new)
  index.ts            # brustjs/native barrel: export { register, start }                 (new)
runtime/islands/importmap.ts   # + export const DIRECTIVES_BOOTSTRAP                      (edit)
runtime/cli/native-routes-emit.ts  # bake DIRECTIVES_BOOTSTRAP when template uses x-data  (edit)
runtime/cli/build.ts           # directives build block (scan → build → dual-write; AFTER islands) (edit)
                               # (dev.ts needs NO edit — bake is in native-routes-emit.ts; bundle from `brust build`)
package.json                   # + "./native": "./runtime/native/index.ts"               (edit)
tests/native-directives.test.ts # integration: build a fixture native route w/ directives (new)
example/pokedex/components/AddToTeamButton.tsx  # island → native interactive component   (rewrite, dogfood)
example/pokedex/lib/loaders.ts # + addProps JSON precompute                               (edit, dogfood)
example/pokedex/pages/DetailPage.tsx # <AddToTeamButton data={d.addProps} />              (edit, dogfood)
example/pokedex/FRAMEWORK-GAPS.md  # mark native interactivity addressed                  (edit, dogfood)
```

## Behavior / invariants

1. **Compiler passthrough:** `x-data`/`x-props`/`x-text`/`x-show`/`x-bind-*`/`x-on-*`/`x-for`
   are all lowercase, hyphenated, colon-free → `lower_attr` emits them as static string
   attrs (or `x-props={member}` as an escaped interp). No compiler change; a unit test
   asserts a directive-bearing template compiles and the directive attrs survive into the
   jinja byte output.
2. **Cross-paradigm store identity (S4 reuse):** a native `x-on-click` handler calling
   `teamStore.members.set(...)` and a React `useStore(teamStore)` island resolve the same
   window singleton — the pokedex store is `defineStore('pokedex.team', …)`, so the key is
   `window.__BRUST_STORES__['pokedex.team']` (Spec A `Symbol.for` cross-chunk identity).
   Verified in a real browser (the dogfood acceptance).
3. **Reactive update:** changing a signal/computed read by `x-text`/`x-show`/`x-bind-*`
   re-runs only that binding's `effect`; `Object.is`-equal writes notify nobody (Spec A guard).
4. **Lifecycle:** per mount the order is: (a) create instance, (b) bind the subtree — each
   binding `effect` runs **synchronously once** against the instance's *initial* state, (c)
   fire-and-forget `instance.init?.()`. `init()` is typically async (seeds the store via a
   fetch); when its await resolves and writes a signal, the already-bound effects re-run with
   the new value. So a first paint with initial state, then a reactive update after `init()` —
   no ordering hazard. `init()` runs exactly once per mount. Removal disposes every effect +
   listener under the node (no leaked effects after an SPA-nav swap).
5. **No-directive pages unaffected:** a native route with no `x-data` gets no `_directives.js`
   script and a byte-identical `.jinja` (no-island/no-directive regression parity).
6. **react-free bundle:** `_directives.js` contains no React (build-time assert).

## Tests

Unit (`bun test`, happy-dom for DOM):

- `runtime/native/runtime.test.ts`:
  - `x-text` binds initial value and updates on signal change; reads a `computed`.
  - `x-show` toggles `display` (`''` ↔ `none`) on a boolean signal.
  - `x-bind-class` sets `className`; `x-bind-disabled` toggles the `disabled` property +
    attribute reflection; generic `x-bind-data-foo` sets an attribute.
  - `x-on-click` calls the named method with the event; a non-function name warns, no throw.
  - `x-for` renders one node per item, updates on list change (add/remove), child
    `x-text="item.name"` resolves via the loop scope; instance members still visible in scope.
  - `x-data` mount: parses `x-props` JSON → `props`; runs `init()` once; unknown component
    name warns + skips.
  - nested `x-data`: outer walk stops at the inner; inner mounts independently with its own
    scope.
  - dispose: removing the `x-data` element (MutationObserver) stops its effects — a later
    signal write does not touch detached DOM. **Cover the SPA-nav swap shape**, not just a
    bare `removeChild`: an element removed and a fresh `x-data` element added in the same
    observer batch must dispose-then-mount (no double-mount, no leaked effect from the old node).
  - `start()` idempotent (second call no-op); `read` leaf calls signal/computed/function but
    passes plain values through.
- `runtime/native/build.test.ts`:
  - `scanDirectiveComponents` finds a file with `export const behavior` referenced by a
    template's `x-data`, derives `registerName` from filename, throws on name collision,
    ignores a `behavior`-less component.
  - generated registration entry shape (imports + register calls + trailing `start()`).
  - `buildDirectives` emits `_directives.js`; the react-leak guard fails when a behavior
    imports `useStore` (fixture that mis-imports) and passes for a react-free behavior.

Integration (`tests/native-directives.test.ts` — boots the server; **rebuild the addon
first** per repo rule, though Spec B adds no Rust):

- A fixture native route with a directive component builds: `_directives.js` exists in the
  islands out dir, the route's `.jinja` contains the `_directives.js` `<script>` baked, and
  the served HTML contains the directive attributes + the script tag. A sibling native route
  with no directives gets neither.

Dogfood (manual, chrome-devtools MCP — per handoff, cross-island/SPA store behavior can
only be confirmed in a real browser):

- pokedex builds; the detail page's "Add to team" button is native (no `AddToTeamButton`
  island chunk emitted); clicking it mutates `teamStore`; the `TeamBuilder` React island dock
  updates reactively (count + members) — proving native↔React store sharing. SPA-nav to
  another detail page preserves the team (TeamBuilder island keeps the bootstrap/nav alive).

## Acceptance criteria

- `bun run ci` (biome) clean — the lint gate (NOT `tsc`; cf. memory
  `brust-ts-ci-gates-biome-not-cargo`).
- New unit suites green; existing `runtime` suite green (no regressions vs this branch's base
  count — re-measure at impl time, don't freeze a literal).
- `cargo test` baselines **unchanged** (Spec B touches no Rust, no compiler): jsx-rust-compiler
  + brust lib byte-for-byte.
- Integration suite green + the new `native-directives` test.
- `import { register, start } from 'brustjs/native'` resolves under `bun test`; `_directives.js`
  builds and contains no React (build-time assert green).
- Dogfood: pokedex `brust build` succeeds with `AddToTeamButton` as a native component (its
  island chunk is gone); browser verification of cross-paradigm store sharing passes.

## Known limitations (shipped intentionally)

- **No native store-snapshot injection** (Option A) — native stores seed via client
  interaction/`init()` fetch, not SSR snapshot. Follow-up Spec B.1 if a server-seeded native
  store appears.
- **`x-for` full re-render** on change (no keyed diff). Fine at pokedex scale.
- **No inline expressions** — directives reference instance members / `x-for` dotted paths
  only; all logic lives in the typed `behavior` (no `new Function`).
- **No `:`/`@` Alpine shortcuts** — compiler rejects colon attrs; v1 uses `x-on-*`/`x-bind-*`.
- **SPA nav owned by islands bootstrap** — a native page with directives but zero islands
  does full-reload nav (directives still re-init on load).
- **Behaviors must be react-free** — importing a react-pulling symbol (e.g. `useStore`) fails
  the directives build's react-leak guard. Use `signal`/`computed` from `brustjs/store`.
- **`x-data` inside an `ssr` React island subtree is unsupported** — React owns/replaces that
  subtree on render, which would leak or double-bind a directive instance. The directive
  namespace (`x-*`) and the island namespace (`data-brust-island`) are disjoint and authors
  should keep directive markup outside island-rendered DOM. v1 does not actively guard this
  (no warn); documented as an authoring constraint.

## Open questions resolved at design/plan time

1. **Snapshot scope** — deferred (Option A), see Non-goals. No native render-path edit.
2. **react tree-shaking from `brustjs/client`** — behaviors import only `{ client }` (from
   `treaty.ts`, react-free); `_directives.js` bundles with **no externals** and a build-time
   react-leak assert guards regressions. BLOCKED fallback: if tree-shaking proves unreliable,
   add a react-free `brustjs/treaty` subpath export and switch behaviors to it.
3. **SPA-nav re-scan** — solved by a `MutationObserver` in the runtime (Alpine pattern); no
   coupling to `bootstrap.ts`. Covered by the dispose-on-removal unit test.
4. **Compiler attr passthrough** — verified against `lower.rs:2092` (`lower_attr`): lowercase
   hyphenated colon-free names pass; a unit test pins it so a future compiler change can't
   silently drop directives.

## BLOCKED fallbacks

- **react leaks into `_directives.js`:** add `"./treaty"` export (react-free), switch
  behaviors' `client` import to `brustjs/treaty`, keep the leak guard. Gate on the build test.
- **MutationObserver misses an SPA-nav swap shape:** expose `start(root)` and have the islands
  bootstrap `navigate()` also call `start(newMain)` after `swapMainContent` (the same place it
  calls `hydrateMarkersIn`/`applyStoreSnapshot`) — re-introduces a small coupling but is
  deterministic. Gate on the dogfood browser check.
- **Bun.build can't tree-shake the unused `default` template export:** split the file —
  `behavior` moves to a co-located `<Name>.client.ts`; the build scans for the companion
  instead of the in-file export. The single-file ergonomic is the preference, not a hard
  requirement.
