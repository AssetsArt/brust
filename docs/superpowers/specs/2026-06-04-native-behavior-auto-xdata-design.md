# Native `behavior` → auto-injected `x-data` (implicit mount via `x-behavior`, unique name)

**Date:** 2026-06-04 · **Status:** approved (pending user spec review)

## Problem

A native interactive component today must hand-write `x-data="<name>"` on its root
element to wire its co-located `export const behavior` to the DOM:

```tsx
export const behavior = ({ props }) => { /* ... */ }

export default function AddToTeamButton({ data }) {
  return (
    <div x-data="addToTeamButton" x-props={data} className="relative">…</div>
  )
}
```

The string `"addToTeamButton"` is redundant — it just restates the file's camelCase
basename, which the build already derives independently (`registerName` in
`runtime/native/build.ts`) to name the `<name>.directive.js` chunk and the runtime
registry key. The author has to (a) know the convention, (b) keep the string in sync,
and (c) avoid colliding with another file of the same basename (today a hard build
error). We want the author to write **only** `export const behavior` + the JSX root;
the framework wires `x-data` automatically with a guaranteed-unique name.

## Goal

When a native component file has `export const behavior`, the compiler auto-injects
`x-data="<uniqueName>"` onto the component's host element (the **root** by default, or
a bare-`x-behavior`-tagged element for a non-root host), where `uniqueName` is
**deterministic and unique per source file**. The author writes no `x-data` — at most a
bare `x-behavior` marker. A literal hand-written `x-data` still wins (raw escape,
non-breaking).

## Decisions (from brainstorming)

1. **Injection site — Approach A (Rust auto-inject).** TS owns the names; Rust places
   the string it is handed. Mirrors the lucide-icons precedent (a map threaded into
   `compileJsx` → `compile_full` → `lower_with_sources`). No runtime change.
2. **Unique id — deterministic from path.** `uniqueName = camelCase(basename) + "_" +
   shortHash(relPath)`, e.g. `addToTeamButton_a3f9c1`. Same value every build (CI /
   cache / diff stable). Unique because the relative path is unique.
3. **Suffix always present.** Uniform rule; a name never depends on whether another
   file happens to collide (no non-local behavior).
4. **Author-facing attribute is `x-behavior` (bare); `x-data` is the compiled wire
   format.** Authors never write `x-data`. The framework always owns the mount name
   (no author-supplied custom names). Two author-facing modes:
   - **No marker** (common case): the file has `export const behavior` → the compiler
     auto-injects `x-data="<uniqueName>"` on the component's **root element**.
   - **Bare `x-behavior`** (escape hatch for a non-root host): the author tags the
     element that should host the behavior → the compiler replaces that `x-behavior`
     with `x-data="<uniqueName>"` and does **not** auto-pick the root.

   `x-behavior` is **bare-only** — a valued `x-behavior="…"` is a compile error (names
   are framework-owned). A literal author-written `x-data` is still honored verbatim as
   the lowest-level raw escape (back-compat), and suppresses auto-injection for that
   mount. Existing pokedex components (`AddToTeamButton`, `HeroSearch`, `DexFilter`)
   mount on their root, so they are migrated to **drop the marker entirely** (fully
   implicit). `runtime` is unchanged — it only ever sees `x-data`.

## Architecture

```
                       ┌──────────────────────── TS (build/dev) ─────────────────────────┐
 routes entry ──BFS──► scanDirectiveComponents ──► Map<uniqueName, absPath>               │
                          │ (regex export const behavior + directiveName(path))           │
                          │                                                                │
   ┌──────────────────────┼─────────────────────────────┐                                │
   ▼ (chunks)             ▼ (loader bake)                ▼ (compile)                       │
 buildDirectives     native-routes-emit            native-routes-emit                      │
  <uniqueName>.        bakeDirectiveLoader           build ident→uniqueName map ───┐        │
  directive.js         (size>0 only — unchanged)     pass as 5th compileJsx arg    │        │
                                                                                   ▼        │
                                                          compileJsx(src, path, sources,    │
                                                              lucideIcons, directiveNames)  │
                       └──────────────────────────────────────────────┬───────────────────┘
                                                                       ▼ Rust
                                       compile_full → lower_with_sources(.., directive_names)
                                          on lowering a component (route-root OR <Comp native/>)
                                          whose ident ∈ directive_names: resolve host
                                          (literal x-data → skip · bare x-behavior → that el,
                                           strip it · else root) → add x-data="<uniqueName>"
                                                                       ▼
                                            jinja → HTML: <div x-data="addToTeamButton_a3f9c1" …>
                                                                       ▼ browser (unchanged)
                                  _directives.ts runtime sees x-data → import()s the matching chunk
```

**Single source of truth for the name = TS.** Rust never computes the hash; it only
substitutes the exact string TS supplies per ident. The three sites that must agree
(jinja `x-data`, chunk filename, runtime registry key) all derive from the one TS
helper.

## Components & changes

### 1. TS — `directiveName(absPath, projectRoot)` helper (`runtime/native/build.ts`)
- New exported pure function. `camelCase(basename(path, ext)) + "_" + shortHash(rel)`.
- `rel` = path relative to `projectRoot` (cwd), normalized to forward slashes
  (cross-platform stable). `shortHash` = first 8 hex chars of `sha256(rel)` (node
  `crypto`). Result matches the runtime's `^[A-Za-z0-9_-]+$` chunk-name guard.
- `scanDirectiveComponents` returns `Map<uniqueName, absPath>` using this helper
  instead of the bare camelCase `registerName`. The existing "two files derive the
  same name" throw is retained as a safety net for an (astronomically unlikely) hash
  truncation collision; the message is updated to mention the hash.

### 2. TS — `compileJsx` 5th arg (`runtime/index.d.ts`, napi binding, `native-routes-emit.ts`)
- `compileJsx(source, path, componentSources?, lucideIcons?, directiveNames?)` where
  `directiveNames?: Record<string /*ident*/, string /*uniqueName*/>`.
- In `emitNativeRoutes` (call site ~`native-routes-emit.ts:578`): build `directiveNames`
  from the already-resolved `sources` (ident→text) + `mergedImports` (ident→spec/path):
  for each ident whose source matches `BEHAVIOR_RE`, set
  `directiveNames[ident] = directiveName(specPath, projectRoot)`. Pass as 5th arg.

### 3. Rust — `compile_full` / `lower_with_sources` 5th param (`lib.rs`, `lower.rs`)
- `compile_full(source, path, component_sources, lucide_icons, directive_names: HashMap<String,String>)`.
- `lower_with_sources(.., directive_names)` stores it on a new field of the route
  `Scope` (alongside `inline_env` / `lucide_env`): `directive_names: Option<Rc<HashMap<String,String>>>`.
- napi layer: expose the optional 5th arg; default empty map (so `compile` / existing
  callers and all current Rust tests pass `HashMap::new()` — additive).

### 4. Rust — resolve the host element + inject `x-data`
- When lowering a component whose ident is in `directive_names` — both the route-root
  default function path and the `<Comp native/>` inline path (`lower_component_inline`)
  — resolve the **host element** and inject `x-data="<uniqueName>"` on it. The inline
  path already keys components by ident via `inline_env.sources`; the route-root path
  uses the default function's name.
- **Host resolution (in priority order):**
  1. If any element in the component subtree carries a literal `x-data` → leave it
     untouched (raw escape, back-compat); **no** injection for this component.
  2. Else if exactly one element carries a bare `x-behavior` → that is the host: strip
     the `x-behavior` attribute and add `x-data="<uniqueName>"`. (More than one
     `x-behavior`, or a valued `x-behavior="…"`, is a compile error.)
  3. Else → the host is the component's **root element**: add `x-data="<uniqueName>"`.
- The injected attribute is a static string emitted through the existing attr path —
  byte-identical to a hand-written `x-data` today.
- **Constraint:** the resolved host must be a single plain **element** (it has to host
  an attribute). If the root is reached in case 3 but is not a plain element (fragment
  / bare expression / `.map()` / conditional at the very root), raise a clear compile
  error: *"native component `<Name>` has `export const behavior` but no single element
  to host its mount; give the host a bare `x-behavior` or wrap it in one root element"*.
  (Locked by a test, like the lucide-in-`.map()` hard error.)
- `x-behavior` is consumed entirely at compile time; it must never reach the emitted
  jinja/HTML.

### 5. Runtime — no change
- The runtime only ever sees `x-data` (the compiled wire format); `x-behavior` is a
  compile-time-only author sugar and never reaches the DOM.
- `loadBehavior`'s `^[A-Za-z0-9_-]+$` guard already admits `addToTeamButton_a3f9c1`.
- `mountElement` / `register` / chunk `import()` all key off the same string.

### 6. Examples — migrate (`example/pokedex/components/*`)
- Drop the manual `x-data="…"` from `AddToTeamButton`, `HeroSearch`, `DexFilter`
  (they mount on their root → fully implicit; keep `x-props={…}` on the same root).
  Rebuild + browser-smoke to prove implicit wiring renders the right
  `x-data="<name>_<hash>"` on the un-annotated root and the chunk loads/mounts.
- Dogfood the explicit escape hatch in at least one place (a focused fixture or one
  example) with a bare `x-behavior` on a non-root host, asserting the compiled root
  stays bare and the tagged element gets the `x-data`.

## Data flow (one component, one build)

1. `scanDirectiveComponents(routes)` → `{ "addToTeamButton_a3f9c1" → /abs/AddToTeamButton.tsx }`.
2. `buildDirectives` emits `/_brust/islands/addToTeamButton_a3f9c1.directive.js`
   (self-registers under `"addToTeamButton_a3f9c1"`).
3. `emitNativeRoutes` builds `directiveNames = { AddToTeamButton: "addToTeamButton_a3f9c1" }`,
   passes to `compileJsx`. Rust injects `x-data="addToTeamButton_a3f9c1"` on the inlined
   `<AddToTeamButton>` root → jinja → HTML.
4. Browser: runtime sees the `x-data`, `import()`s the matching chunk, mounts. Identical
   to the hand-written flow today — only the name is framework-generated.

## Error handling

- **No host element** (case 3, root not a plain element): hard compile error (§4).
- **Valued `x-behavior="…"`** or **more than one `x-behavior`** in a component: hard
  compile error (names are framework-owned; the host must be unambiguous).
- **Hash truncation collision** (two paths → same uniqueName): retained build throw,
  message mentions the hash.
- **Literal author-written `x-data` present:** not an error — honored verbatim, no
  injection (lowest-level raw escape, back-compat).
- **No behavior in file:** no injection. A stray `x-behavior` in a file with no
  `export const behavior` is a no-op marker (its ident is not in `directive_names`);
  surface a compile warning so it is not silently dropped.

## Testing (TDD)

- **Rust (`jsx-rust-compiler`):**
  - inline `<Comp native/>` whose source has `export const behavior` AND is in
    `directive_names`, no marker → root gains `x-data="<unique>"`; no other element does.
  - bare `x-behavior` on a non-root element → that element gets `x-data="<unique>"`,
    the `x-behavior` attr is stripped, the root stays bare.
  - literal `x-data` present → left unchanged (no double attr, no injection).
  - valued `x-behavior="x"` → hard error; two `x-behavior` in one component → hard error.
  - registered component, case-3 root is a fragment/expression → hard error (locked).
  - `x-behavior` in a file with no behavior → compile warning, attr is a no-op.
  - empty `directive_names` → byte-identical output to today (additive guarantee);
    existing golden fixtures unchanged.
- **TS (`runtime/native/build.test.ts`):**
  - `directiveName` deterministic, unique per path, matches `^[A-Za-z0-9_-]+$`,
    suffix always present.
  - `scanDirectiveComponents` returns hashed names; chunk filenames follow.
- **Integration (`tests/`):** pokedex native page served — assert the rendered HTML
  carries `x-data="<name>_<hash>"` on the (un-annotated) component root and the chunk
  is fetchable. Mirror the existing native-island integration assertions.

## Out of scope (YAGNI)

- No `x-props` auto-injection — the author still passes loader data via `x-props={data}`.
- No random (non-deterministic) names.
- No change to the runtime mount/dispose model (the separate `effect`-in-`behavior`
  teardown follow-up is unrelated).
- No multi-root / fragment behavior hosts — single root element required.

## Build / verify (mirror ci.yml)

`cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -- -D
warnings` · `cargo test --workspace --locked` · **`cd runtime && bun run build`** after
the Rust change (stale `.node` otherwise) · `bun run ci` (biome, repo root) · `bun test
runtime/` · native integration suites separately. Pokedex dogfood: `brust build` +
`dev` curl-smoke for `x-data="…_<hash>"` + chunk 200.
