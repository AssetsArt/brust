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
  (`SsrComponentInMapNotSupported`); this feature preserves that — lucide-in-`.map()` keeps
  today's behavior (error/fallback). Deferred to a follow-up.
- **Not** dynamic `absoluteStrokeWidth` (needs runtime `strokeWidth*24/size` arithmetic in
  jinja). Static `absoluteStrokeWidth` computes at compile time; dynamic → soft-fallback.
- **Not** React-island usage of lucide (different code path, unaffected).

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
- Threaded into `Scope` alongside `inline_env` (new `lucide: Option<Rc<LucideEnv>>` field, or
  carried inside the existing `InlineEnv` struct — plan-time decision; the `inline_env`
  pattern at lower.rs:70-78 is the template).

## TS extraction (native-routes-emit.ts)

1. `scanImportRefs(file)` already returns `Map<localName, {spec, bare, kind, imported?}>`.
   Lucide detection: `entry.bare && entry.spec === 'lucide-react'`.
2. For each lucide entry actually referenced as a tag in the route (reuse the existing
   component-usage scan; if usage detection is costly, passing all lucide imports is
   acceptable — superset is harmless, only adds a file read):
   - `imported` name (or local name for default import) is the PascalCase icon → `toKebabCase`
     (`ChevronRight`→`chevron-right`, matching lucide's own util: insert `-` between
     `[a-z0-9][A-Z]`, lowercase).
   - `await import('lucide-react/dist/esm/icons/<kebab>.mjs')` → read `mod.__iconNode`
     (an `Array<[tag, attrsObject]>`). This is **pure data**, no React invoked.
   - Strip the `key` property from each attrs object (lucide-internal, not an SVG attr).
   - Build `{ cls: "lucide lucide-<kebab>", node }` and JSON-stringify.
3. Map is keyed by **local name** (the identifier used in JSX). Aliased import
   `import { Search as Icon }` → key `"Icon"`, iconNode resolved from `"Search"`.
4. Pass the `{ localName: json }` map as the 4th arg to `compileJsx`.
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
| `aria-*`, `data-*`, valid passthrough attrs | emitted verbatim as attrs | — |
| `isr`, `key`, `ref` | **stripped** (no-op) | — |
| spread `{...x}` | → soft-fallback to React SSR | — |

Always-static SVG attributes (emitted unless explicitly overridden by a passthrough prop):
`xmlns="http://www.w3.org/2000/svg"`, `viewBox="0 0 24 24"`, `fill="none"`,
`stroke-linecap="round"`, `stroke-linejoin="round"`.

Static prop value → emitted as a literal attr (`width="16"`). Dynamic prop value (lowered to
a non-static `Expr`) → `AttrValue::Expr` → `emit_attr` emits `width="{{ (expr) | e }}"`.

### class merge

`class` value = `"lucide lucide-<kebab>"` + optional user `className`.
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

- `crates/brust/src/jsx_compile.rs` — add 4th param, thread to `compile_full`.
- `crates/jsx-rust-compiler/src/lib.rs` — `compile_full` signature + thread to `lower_with_sources`.
- `crates/jsx-rust-compiler/src/lower.rs` — `lucide` env in `Scope`; lucide branch in
  `lower_ssr_component`; `build_lucide_svg` helper; kebab-case + class-merge logic.
- `crates/jsx-rust-compiler/src/emit_jinja.rs` — likely **no change** (reuses Element +
  emit_attr + Concat). Verify.
- `runtime/cli/native-routes-emit.ts` — lucide detection + `__iconNode` extraction + pass map.
- `runtime/native.d.ts` (or wherever `compileJsx` is typed) — add 4th param to the type.
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

- lucide inside `.map()` → not static-inlined (preserves `in_map` hard error). Follow-up.
- dynamic `absoluteStrokeWidth` → soft-fallback to React.
- On-the-wire: icon node data is embedded per-occurrence (no dedup across repeated icons on a
  page). Acceptable — static markup, no runtime cost; gzip handles repetition.

## Open questions resolved at plan-time

- Exact home of the lucide map in `Scope` (new field vs inside `InlineEnv`).
- Whether `emit_jinja.rs` needs any change or is purely reuse (verify Concat-in-class path).
- Internal Rust representation of the parsed icon (`serde_json::Value` vs typed struct).
- Whether to gate extraction on actual tag-usage or pass all lucide imports (superset).
