# Native SSR-component import resolution — support all import forms + package specifiers

> Status: design · 2026-06-03 · branch `feat/native-ssr-import-forms` (off main). FRAMEWORK change
> (TS-side `runtime/cli/native-routes-emit.ts`; Rust compiler likely untouched — verify at impl).
> Motivation: enable third-party React components (e.g. `lucide-react` icons) to auto-SSR inside
> native routes — currently blocked by the import scanner.

## Problem (root-caused empirically)

A native route can embed **SSR React components** — the Rust compiler (`compileJsx`) detects a
`<Component/>` it can't lower to jinja, lists it in `componentsJson`, and the TS side
(`emitComponentArtifacts`) generates a `.factory.ts` that `import`s the component and SSR-renders it
via `createElement`. To resolve the component's module, the TS side scans imports with `scanImports`:

```ts
const re = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm   // DEFAULT import only
...
if (!importPath.startsWith('.')) continue                 // SKIPS package specifiers
```

So an SSR component is resolvable **only** if imported as a **default import from a relative path**.
This blocks:
- `import { Search } from 'lucide-react'` (named import) → not matched.
- `import * as Lucide from 'lucide-react'` (namespace import) → not matched.
- `import Search from 'lucide-react/dist/esm/icons/search.mjs'` (default, but **package** spec) →
  matched by the regex but dropped by the `startsWith('.')` skip.

Confirmed: `<Search/>` from lucide-react in a native directive (`HeroSearch`) →
`SSR component "Search" in native route "HomePage" has no matching import in the page source`.
The Rust compiler DID list `Search` in `componentsJson` (the error is TS-side, post-detection), so the
fix is **TS-side import resolution** — no Rust change for simple-ident components.

## Goal

Extend the TS import scanner + resolution so native **SSR components AND islands**, in native **pages
AND native directive/chain components**, can be imported via any of:

| form | example | today | after |
|---|---|---|---|
| default, local | `import X from './X'` | ✓ | ✓ |
| default, package | `import S from 'lucide-react/.../search.mjs'` | ✗ (skipped) | ✓ |
| named, local/package | `import { S } from 'lucide-react'` / `{ S as Icon }` | ✗ | ✓ |
| namespace, local/package | `import * as L from 'lucide-react'` | ✗ | ✓ (see member-expr below) |

- **Local specifiers** (`./`, `../`) resolve to an absolute file path (as today).
- **Package specifiers** (bare: `lucide-react`, `lucide-react/x`, `@scope/pkg`) are kept **verbatim**
  as the import spec — never relativized, never `readFileSync`'d.
- The factory regenerates the **correct import form** per kind:
  - default → `import X from '<spec>'`
  - named → `import { <imported> as X } from '<spec>'`
  - namespace → `import * as X from '<spec>'`

## Member-expression usage (`<Lucide.Search/>`) — scoped

`import * as Lucide` is typically used as `<Lucide.Search/>` (a member-expression component). Whether
the Rust compiler lists member-expression components in `componentsJson` is **unverified**.
- **At impl, verify empirically** (build a native page with `import * as L from 'lucide-react'` +
  `<L.Search/>`). 
- If Rust lists it → support it (the factory imports the namespace + renders `L.Search`).
- If Rust does NOT list it → **out of scope** (documented Rust follow-up). The namespace import FORM is
  still parsed (so an `import * as L` line never breaks the scanner) and a simple-ident component from
  any import form resolves. The headline lucide use-cases (`import { Search }` named, or
  `import Search from '.../search.mjs'` default-package) are fully covered without member-expr.

## High-level design

### Import model (the core change)
`scanImports` (and the maps it feeds — `mergedImports` in `gatherComponentSources`/`gatherChainSources`)
change their value type from `string` to a structured `ResolvedImport`:

```ts
export interface ResolvedImport {
  /** Module specifier: an ABSOLUTE file path for local imports, or the verbatim bare
   *  specifier for package imports. */
  spec: string
  /** true ⇒ `spec` is a package/bare specifier (keep verbatim; do not readFileSync/relativize). */
  bare: boolean
  /** How the symbol was imported, so the factory regenerates the right import statement. */
  kind: 'default' | 'named' | 'namespace'
  /** For `named`, the exported name (may differ from the local alias). */
  imported?: string
}
```
`scanImports` returns `Map<localName, ResolvedImport>`. (A localName is the in-source identifier used
in JSX, e.g. `Search`, `Icon`, `Lucide`.)

### `scanImports` — parse all forms
Replace the single default-only regex with a scanner matching:
- `import Default from '<spec>'` → `{kind:'default'}`
- `import * as Ns from '<spec>'` → `{kind:'namespace'}`
- `import { A, B as C } from '<spec>'` → one entry per specifier; `B as C` → local `C`, imported `B`,
  `{kind:'named', imported:'B'}`
- mixed `import Default, { A } from '<spec>'` → both (default + named)
Resolve `spec`: local (`.`-prefixed) → absolute file via the existing `.tsx/.ts/index` candidates
(`bare:false`); else keep verbatim (`bare:true`). NO `continue`-skip of package specs.

### Consumers updated for `ResolvedImport`
- `gatherComponentSources` / `gatherChainSources`: only **recurse/`visit`** into LOCAL (`!bare`) imports
  (a bare spec has no local source to BFS). mergedImports carries all (local + bare). Ambiguity check
  compares by `spec`.
- `emitComponentArtifacts`:
  - resolution lookup returns a `ResolvedImport` (or undefined → the existing error).
  - `components.json` `sourcePath`: for local → project-relative path (as today); for bare → the bare
    spec verbatim (it's build-time metadata; the factory import is what's load-bearing).
  - factory import line: regenerate per `kind` (default/named/namespace), spec relativized ONLY when
    `!bare` (local), kept verbatim when `bare`.
  - the `<Island component={X}>` scan that does `readFileSync(entry.sourcePath)`: **guard** — skip
    entries whose import is `bare` (no readable local file).
- `reconcileIslandManifest`: same lookup-type change; islands imported from packages are rare but the
  type must line up (an island is normally a local default import — behavior unchanged for that case).

### `.factory.ts` SSR render
Unchanged in mechanism — `createElement(Component, props)` + `renderToString`. lucide-react icons are
ordinary React components, so SSR-rendering them yields `<svg>…</svg>` inline in the native template's
output. (This is why icons "just work" once the import resolves.)

## File structure
- `runtime/cli/native-routes-emit.ts` — `scanImports`, `ResolvedImport` (exported), `gatherComponentSources`,
  `gatherChainSources`, `emitComponentArtifacts`, `reconcileIslandManifest`. One file.
- `runtime/cli/native-routes-emit.test.ts` — extend.
- No Rust / no napi rebuild (verify member-expr question doesn't force Rust; if it does, that part is a
  separate follow-up, not this slice).

## Behavior invariants
- **Backward compat:** existing local default imports (`import X from './X'`) resolve identically; the
  factory emits `import X from './rel'` exactly as before. Existing native routes/islands unaffected.
- A bare specifier is NEVER `readFileSync`'d or relativized (would crash / corrupt the spec).
- Ambiguous idents (same localName → two different specs) still throw (existing guard, by `spec`).
- An SSR component still unresolved (used but imported nowhere reachable) still throws the existing
  legible error.

## Tests (`native-routes-emit.test.ts`)
- `scanImports` parses: default-local, default-package, `{named}`, `{named as alias}`, `* as ns`,
  mixed `default, {named}`; resolves local→abs path (`bare:false`), package→verbatim (`bare:true`).
- `emitComponentArtifacts` factory regenerates each form: default/named/namespace, bare vs local
  (relativized) — assert the emitted import lines.
- bare-import entry: components.json keeps the bare spec; the Island `readFileSync` scan is skipped (no
  throw).
- backward-compat: a local default import produces byte-identical factory output to today.
- ambiguity throw preserved.

## Acceptance criteria
1. `cd runtime && bun run ci` (biome) clean; `bun test runtime/cli/native-routes-emit.test.ts` green +
   full `bun test runtime/` no regression (baseline 449).
2. No Rust change (assert `git diff --stat` = `native-routes-emit.ts` + its test + this spec/plan).
   If member-expr forces Rust → STOP, descope member-expr, note it.
3. **Empirical lucide verify** (the real goal): in the example, `import { Search } from 'lucide-react'`
   (and `import * as L from 'lucide-react'` for the namespace-form parse) used in a native directive →
   `brust build` succeeds AND the rendered native template contains the inline `<svg>` (lucide icon
   SSR'd). Captured, not just asserted in prose.
4. `bun run typecheck:treaty` 0.

## Known limitations
- Member-expression components (`<Ns.Member/>`) supported only if the Rust compiler already lists them
  (verified at impl); otherwise documented Rust follow-up. Namespace import FORM always parses.
- SSR-rendering a heavy third-party component on every native render has a cost; icons are cheap, but
  this isn't a license to SSR large component trees in native routes (use islands for those).

## Open questions — resolved at design time
- import-model shape ✅ `ResolvedImport {spec,bare,kind,imported?}`, `Map<local, ResolvedImport>`.
- package specifiers kept verbatim ✅ (no resolve, no readFileSync, no relativize).
- factory regenerates per kind ✅.
- member-expr ✅ scoped (verify; descope to Rust follow-up if needed).
