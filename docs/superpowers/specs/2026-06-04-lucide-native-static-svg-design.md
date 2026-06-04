# Spec — lucide-react as static SVG in native routes (zero-React)

**Date:** 2026-06-04
**Status:** Design approved (brainstorm), pending spec review
**Repo:** brust · github.com/AssetsArt/brust

## Goal

Render `lucide-react` icons used in **native routes** (`native:true` templates using
`brustjs/native` x-* directives) as **static inline SVG at compile time**, with **zero
React** — no `react-dom/server` `renderToString`, no `.factory.ts`, no `{{ comp_N_html }}`
slot. Static props bake into the SVG markup; dynamic props (from loader / `.map()` item)
become `{{ (expr) | e }}` jinja substitutions.

### Motivation (user-confirmed)
1. **Performance** — eliminate per-request `renderToString` + react-dom/server load for what
   is fundamentally static data.
2. **Cut React dependency** — a native page using only lucide should not pull React.
3. **DX / simplicity** — no `factory.ts` / `components.json` / slot pipeline for icons.

## Non-goals (explicit — out of scope)

- **Not** removing React SSR from native routes in general. React SSR machinery stays for
  every other 3rd-party component / `<Island>`. This feature is **lucide-react only**.
- **Not** other icon libraries (react-icons, feather, heroicons). Only `lucide-react`.
- **Not** lucide icons inside `.map()` bodies. `lower_ssr_component` hard-errors on `in_map`
  (`SsrComponentInMapNotSupported`, lower.rs:1244, fires BEFORE the lucide check); this
  feature preserves that **hard error unchanged**. Deferred to a follow-up.
- **Not** dynamic `absoluteStrokeWidth` (needs runtime `strokeWidth*24/size` arithmetic in
  jinja). Static `absoluteStrokeWidth` computes at compile time, and **only when both
  `strokeWidth` and `size` are static** (if either is dynamic the product is uncomputable) →
  soft-fallback. Default `size` is 24 so `<Search absoluteStrokeWidth strokeWidth={3}/>` =
  `stroke-width="3"`.
- **Not** React-island usage of lucide (different code path, unaffected).
- **Not** `LucideProvider` context. The static compiler cannot observe a runtime
  `<LucideProvider size=…>`. Lucide defaults (size 24, strokeWidth 2, color currentColor) are
  assumed; context overrides are unsupported.

## Architecture — "Lucide-aware compiler" (Approach B)

The TS build step extracts each lucide icon's static node data and passes it to the Rust
compiler. The compiler recognizes a lucide tag and emits an `<svg>` `JsxNode::Element`
directly (static markup + jinja substitutions for dynamic props), reusing the existing
`emit_jinja::emit_attr` escaping (`| e`).

### Data flow

```
import { Search } from 'lucide-react'           example/.../HeroSearch.tsx (native route)
export default ... <Search size={16} color={t.c}/>
        │
        ▼  TS: native-routes-emit.ts
scanImportRefs → detect bare spec 'lucide-react'
  for each lucide local name in use → kebab → dynamic import
  'lucide-react/dist/esm/icons/search.mjs' → read .__iconNode → strip `key`
  build { cls:"lucide lucide-search", node:[["path",{d:"..."}],["circle",{cx:"11",...}]] }
        │
        ▼  compile_jsx(source, path, component_sources, lucide_icons)   ← NEW 4th param
lucide_icons: { "Search": "<json {cls,node}>" }   (key = LOCAL name used in JSX)
        │
        ▼  Rust: lower_ssr_component — lucide check BEFORE native-inline branch
<svg xmlns viewBox="0 0 24 24" fill="none" stroke-linecap=round stroke-linejoin=round
     width="16" height="16" stroke="{{ (t.c) | e }}" class="lucide lucide-search">
  <path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>
</svg>
        │
        ▼  emit_jinja → static SVG embedded in the page template. No slot, no factory.
```

## Boundary (TS → Rust napi)

Extend `compile_jsx` (crates/brust/src/jsx_compile.rs) and `compile_full`
(crates/jsx-rust-compiler/src/lib.rs) and `lower_with_sources` (lower.rs) with a new
**optional** parameter:

```rust
pub fn compile_jsx(
    source: String,
    path: String,
    component_sources: Option<HashMap<String, String>>,
    lucide_icons: Option<HashMap<String, String>>,   // NEW: localName → JSON {cls,node}
) -> Result<NapiCompiledJsx>
```

- Value is a **JSON string** (not a `#[napi(object)]`) to avoid napi-rs camelCase key
  rewriting ([[napi-object-camelcase-keys]]) and to keep the nested `node` array trivially
  serializable. Rust parses it with serde_json into an internal `LucideIcon { cls: String,
  node: Vec<(String, Vec<(String,String)>)> }` (or `serde_json::Value`).
- `None` / absent → byte-identical to today (every existing caller + the golden harness
  `compile_with_path` passes `None`/empty and is unaffected).
- **Threaded into `Scope` as a NEW field `lucide_env: Option<Rc<LucideEnv>>`, INDEPENDENT of
  `inline_env`** (decided — was an open question; reviewer B1/OQ1). Rationale: lucide
  inlining must work on routes that have **no** `native`-attributed components, where
  `inline_env` is `None`. Coupling the lucide map to `InlineEnv` would force every
  lucide-using route to also supply `component_sources` — wrong coupling. `LucideEnv` carries
  the parsed icon map + a `RefCell<Vec<String>>` warnings sink (mirrors `InlineEnv`'s warning
  accumulation so soft-fallback warnings surface through the same `Compiled.warnings`).
- Plumbing chain (ALL must take the new arg): `compile_jsx` → `compile_full`
  (lib.rs:88) → `lower_with_sources` (lower.rs:150, grows a 3rd param) → seeds
  `Scope.lucide_env`. The `jsx-rustc` binary (`crates/jsx-rust-compiler/src/bin/jsx-rustc.rs`,
  calls `compile_full` directly) passes `None`/empty.

## TS extraction (native-routes-emit.ts)

A **new pass inside the per-route build loop** (the loop at ~line 512 that already calls
`compileJsx!` at ~line 565). Note: the existing `importMap` is built via `scanImports`
(line ~497), which **skips bare/package specifiers** — so lucide imports are invisible to it.
This feature adds a **separate `scanImportRefs(routeSourcePath)` call** (that function keeps
bare specifiers) to discover lucide imports.

1. `scanImportRefs(file)` returns `Map<localName, {spec, bare, kind, imported?}>`.
   Lucide detection: `entry.bare && entry.spec === 'lucide-react'`. (Verified: `resolveSpec`
   seeds `kind:'default'` for bare specs but the named-import code overwrites it with
   `kind:'named', imported:<Name>`; detection on `bare && spec` is sound — reviewer F7.)
2. For each lucide entry (passing all lucide imports is acceptable — superset is harmless,
   only adds a file read; gating on actual tag usage is an optional optimization):
   - `imported` name (or local name for a default import) is the PascalCase icon →
     `toKebabCase` (`ChevronRight`→`chevron-right`: insert `-` between `[a-z0-9][A-Z]`, then
     lowercase — matches lucide's own util and its per-icon filename).
   - `await import('lucide-react/dist/esm/icons/<kebab>.mjs')` → read `mod.__iconNode`
     (an `Array<[tag, attrsObject]>`). This is **pure data**, no React invoked.
   - Strip the `key` property from each attrs object (lucide-internal, not an SVG attr).
   - Build `{ cls: "lucide lucide-<kebab>", node }` and JSON-stringify. The TS side does NOT
     read `defaultAttributes.mjs` — the static default SVG attrs are hard-coded on the **Rust**
     side (already kebab-case), so the camelCase keys in `defaultAttributes` (`strokeLinecap`,
     etc., reviewer B4) never enter the payload. The payload carries ONLY `cls` + `node`.
3. Map is keyed by **local name** (the identifier used in JSX). Aliased import
   `import { Search as Icon }` → key `"Icon"`, iconNode resolved from `imported="Search"`.
4. Pass the `{ localName: json }` map as the 4th arg to `compileJsx`. **Two type sites must
   be updated** (reviewer B3): (a) the local annotation of the `compileJsx` binding at
   native-routes-emit.ts ~line 479-485 (hand-written 3-arg signature — rejects a 4th arg
   regardless of the .d.ts); (b) `runtime/index.d.ts` regenerates automatically from the
   napi macro when the Rust binding changes.
5. Graceful degrade: if the icon file doesn't resolve or `__iconNode` is missing, omit that
   entry (Rust then treats the tag as a normal SSR component — existing React path).

## Rust lucide path (lower.rs + emit_jinja.rs)

In `lower_ssr_component`, **after** the `in_map` guard (preserves the hard error for
lucide-in-`.map()`) and **before** the `has_native` native-inline branch, add:

> If `component_name` is in the lucide map → attempt `build_lucide_svg(...)`. On success
> return the `<svg>` `JsxNode::Element`. On soft-fallback (spread props / dynamic
> `absoluteStrokeWidth`) → push a warning to the env and fall through to the **existing
> SSR-component emission** (React path). The tag is then treated exactly as today.

### Prop semantics

| call-site prop | SVG output | default when absent |
|---|---|---|
| `size={n}` / `size={expr}` | `width` **and** `height` | `width="24" height="24"` |
| `color={…}` | `stroke` | `stroke="currentColor"` |
| `strokeWidth={…}` | `stroke-width` | `stroke-width="2"` |
| `className={…}` / `className="…"` | merged into `class` (see below) | `class="lucide lucide-<kebab>"` |
| `absoluteStrokeWidth` (static only) | `stroke-width = strokeWidth*24/size` computed | n/a |
| `aria-*`, `role`, `data-*`, valid passthrough attrs | emitted verbatim as attrs | — |
| `isr`, `key`, `ref` | **stripped** (no-op) | — |
| spread `{...x}` | → soft-fallback to React SSR | — |

Always-static SVG attributes, **hard-coded on the Rust side as kebab-case literals** (not
read from lucide's camelCase `defaultAttributes.mjs`), emitted unless overridden by a
passthrough prop: `xmlns="http://www.w3.org/2000/svg"`, `viewBox="0 0 24 24"`,
`fill="none"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.

**Default `aria-hidden="true"`** (reviewer F3): lucide's runtime adds `aria-hidden="true"`
when the icon has no children and no a11y prop. To preserve a11y/visual parity, the static
SVG emits `aria-hidden="true"` **by default**, suppressed when the call-site supplies any
`aria-*` or `role` prop. (Also why hyphenated-prop emission is sidestepped in practice —
[[pokedex-redesign-tailwind]].)

Static prop value → emitted as a literal attr (`width="16"`). Dynamic prop value (lowered to
a non-static `Expr`) → `AttrValue::Expr` → `emit_attr` emits `width="{{ (expr) | e }}"`.

### class merge

`class` value = `"lucide lucide-<kebab>"` + optional user `className`. Note we emit a
**single** `lucide-<kebab>` class intentionally — lucide's runtime emits it twice (via both
`toKebabCase(toPascalCase(name))` and `name`); the duplicate is cosmetic and CSS targeting
(`.lucide`, `.lucide-search`) is unaffected (reviewer F1/OQ3).
- `className` static literal → concat at compile time: `class="lucide lucide-search w-4 h-4"`.
- `className` dynamic → `Expr::Concat([StaticText("lucide lucide-<kebab> "), <className expr>])`
  → `emit_attr` emits `class="lucide lucide-search {{ (className) | e }}"` (the `Concat`
  path already used for serialized `style={{…}}`, emit_jinja.rs:408-425).

### children

Each `__iconNode` entry `[tag, attrs]` → a static `JsxNode::Element { tag, attrs:[…], children:[] }`
(self-closing). Attrs are static strings. `key` already stripped TS-side.

## Escaping / XSS

Dynamic attribute values flow through the existing `emit_attr` `| e` path
(AutoEscape::None; [[brust-jinja-autoescape-none]]). No new escaping code. Static node data
comes from the trusted lucide package, embedded as literal markup.

## File structure (touch list)

- `crates/brust/src/jsx_compile.rs` — add 4th param, parse JSON map, thread to `compile_full`.
- `crates/jsx-rust-compiler/src/lib.rs` — `compile_full` 4th param + thread to `lower_with_sources`.
- `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs` — call site of `compile_full`; pass `None`/empty.
- `crates/jsx-rust-compiler/src/lower.rs` — new `lucide_env: Option<Rc<LucideEnv>>` field in
  `Scope` (independent of `inline_env`); `LucideEnv` struct; `lower_with_sources` 3rd param;
  lucide branch in `lower_ssr_component` (after `in_map` guard, before `has_native` branch);
  `build_lucide_svg` helper; kebab-case + class-merge + aria-hidden logic.
- `crates/jsx-rust-compiler/src/emit_jinja.rs` — likely **no change** (reuses
  `JsxNode::Element` + `emit_attr` + `Concat`-in-class path). Verify (reviewer F6 confirms).
- `runtime/cli/native-routes-emit.ts` — `scanImportRefs`-based lucide detection +
  `__iconNode` extraction + 4th-arg pass; update the local `compileJsx` type annotation
  (~line 479-485) to a 4-arg signature.
- `runtime/index.d.ts` — regenerates from napi macro (auto, via `bun run build`).
- `example/pokedex/**` — migrate (strip now-redundant `isr` on icons; verify render).

## Tests / acceptance criteria

### Rust (crates/jsx-rust-compiler) — goldens + units
- AC1: `<Search/>` (no props) + lucide map → emits `<svg ... class="lucide lucide-search"
  width="24" height="24" stroke="currentColor" stroke-width="2" ...><path .../><circle .../></svg>`,
  **no** `{{ comp_*_html }}` slot, **no** entry in `components_json`.
- AC2: `<Search size={16}/>` → `width="16" height="16"`.
- AC3: `<Search color={data.c} strokeWidth={data.w}/>` → `stroke="{{ (data.c) | e }}"
  stroke-width="{{ (data.w) | e }}"`.
- AC4: `<Search className="w-4 h-4"/>` → `class="lucide lucide-search w-4 h-4"`;
  `<Search className={data.cls}/>` → `class="lucide lucide-search {{ (data.cls) | e }}"`.
- AC5: aliased name `<Icon/>` with map key `Icon`→ same as AC1 with its own kebab class.
- AC6: `<Search {...props}/>` → soft-fallback: produces an SSR `components_json` entry +
  a warning. (lucide map present but inline declined.)
- AC7: tag NOT in lucide map → unchanged SSR component behavior, **no** warning.
- AC8: `None` lucide param → byte-identical template to pre-feature (regression guard).

### TS (native-routes-emit.test.ts)
- AC9: extraction maps `Search`→`{cls:"lucide lucide-search", node:[…]}` with `key` stripped.
- AC10: `ChevronRight`→kebab `chevron-right`, class `lucide-chevron-right`.
- AC11: aliased import `{ Search as Icon }` → map key `Icon`, node from `search.mjs`.
- AC12: unresolvable icon name → omitted from map (graceful).

### Integration / browser
- AC13: pokedex `bun run runtime/cli/index.ts build example/pokedex/index.ts` → an
  icon-only page's template contains literal `<svg class="lucide …">` and **no**
  `comp_N_html` slot / **no** lucide import in any emitted `.factory.ts`.
- AC14: playwright MCP smoke — icons render visually on the pokedex homepage; dynamic-prop
  icon (if any) renders with the substituted value.

### Baselines (mirror ci.yml; [[release-mirror-ci-gates]])
`cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings` ·
`cargo test --workspace --locked` · **`cd runtime && bun run build`** (rebuild .node —
[[stale-napi-node-after-compiler-change]]) · `bun run ci` (biome) · `bun test runtime/` ·
native integration separately.

## Known limitations (shipped-with)

- lucide inside `.map()` → not static-inlined (preserves `in_map` hard error; locked by test
  `lucide_in_map_is_intentional_hard_error`). Follow-up.
- dynamic `absoluteStrokeWidth` → soft-fallback to React.
- **Alias icons** (e.g. `ArrowDownAZ`): some lucide names whose `toKebabCase` (`arrow-down-az`)
  points at a re-export ALIAS module that only re-exports the component `default` and has NO
  `__iconNode` (the real data lives in `arrow-down-a-z.mjs` — lucide splits consecutive
  capitals differently). `extractLucideIcons` hits its `!Array.isArray(__iconNode)` graceful
  skip → the icon soft-falls to React SSR (no crash, no regression). Discovered against pokedex
  `DexFilter`. **Follow-up:** map alias names → their canonical kebab (or read the alias's
  default export's iconNode).
- lucide used inside a **React island** (client-rendered) stays React-rendered — out of scope
  (spec Non-goal). Observed: `ArrowDownAZ` in pokedex `DexFilter` (which is an island).
- On-the-wire: icon node data is embedded per-occurrence (no dedup across repeated icons on a
  page). Acceptable — static markup, no runtime cost; gzip handles repetition.

## Open questions — resolved (post spec-review)

- **Home of the lucide map** — RESOLVED: new `Scope.lucide_env: Option<Rc<LucideEnv>>`,
  independent of `inline_env` (must work when `inline_env` is `None`).
- **emit_jinja.rs change** — RESOLVED: no change; reuse `Element` + `emit_attr` + `Concat`
  (reviewer F6 confirmed `emit_expr_path` joins `Concat` with ` ~ `, wrapped in `{{ … | e }}`).
- **`__iconNode` source** — RESOLVED: per-icon `.mjs` file's `__iconNode` export (the main
  `lucide-react` named export is the component constructor, NOT the node data — reviewer B5).

### Still deferred to plan-time
- Internal Rust representation of the parsed icon (`serde_json::Value` vs typed
  `LucideIcon { cls, node: Vec<(String, Vec<(String,String)>)> }`).
- Whether to gate extraction on actual tag-usage or pass all lucide imports (superset OK).
