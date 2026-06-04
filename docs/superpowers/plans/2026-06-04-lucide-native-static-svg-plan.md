# Plan — lucide-react static SVG in native routes (zero-React)

Spec: `docs/superpowers/specs/2026-06-04-lucide-native-static-svg-design.md`
Branch: `feat/lucide-native-static-svg`

## Conventions
- **TDD:** write the failing test first in each task, then implement to green.
- **After ANY Rust edit:** `cd runtime && bun run build` rebuilds the napi `.node`
  ([[stale-napi-node-after-compiler-change]]) — TS/integration tests use the stale binary
  otherwise.
- TS lint gate is `bun run ci` (biome), NOT cargo ([[brust-ts-ci-gates-biome-not-cargo]]).
- Never `git add -A`; add explicit paths.

## Spec-coverage map
| Spec section | Task |
|---|---|
| Boundary (4th param plumbing) | T1 |
| Rust static emission, defaults, aria-hidden, children, class single | T2 |
| Dynamic props, class merge (Concat), soft-fallback | T3 |
| TS extraction (`__iconNode`, kebab, JSON) | T4 |
| TS wiring (call site, type annotation, per-route extraction) | T5 |
| pokedex migration + browser smoke + baselines | T6 |
| AC1-8 | T2/T3 | AC9-12 | T4 | AC13-14 | T5/T6 |

---

## T1 — Plumbing: 4th param `lucide_icons` (None path = byte-identical no-op)

**Files:** `crates/brust/src/jsx_compile.rs`, `crates/jsx-rust-compiler/src/lib.rs`,
`crates/jsx-rust-compiler/src/lower.rs`, `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs`.

**Test first** (`crates/brust/src/jsx_compile.rs` tests mod):
```rust
#[test]
fn compile_jsx_none_lucide_behaves_as_before() {
    // 4-arg compile_full with empty lucide map == legacy output, no warnings.
    let src = r#"export default function Page({ g }) { return <p>{g}</p>; }"#;
    let compiled = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
    assert!(compiled.template.contains("<p>"));
    assert!(compiled.warnings.is_empty());
}
```
Expected before impl: **fails to compile** (compile_full takes 3 args). After: passes; all
existing tests still green.

**Implementation:**
1. `LucideEnv` struct in lower.rs (mirror `InlineEnv`):
   ```rust
   #[derive(Debug)]
   pub(crate) struct LucideEnv {
       /// local tag name → parsed icon (cls + node elements).
       icons: HashMap<String, LucideIcon>,
       warnings: RefCell<Vec<String>>,
   }
   #[derive(Debug, Clone)]
   pub(crate) struct LucideIcon {
       cls: String,                                   // "lucide lucide-search"
       node: Vec<(String, Vec<(String, String)>)>,    // [(tag, [(attr,val)…])…], key pre-stripped
   }
   ```
2. Add `lucide_env: Option<Rc<LucideEnv>>` to `Scope` (lower.rs:70-79), default `None`.
   `lower()` (non-inline path) sets `lucide_env: None`.
3. `lower_with_sources` grows a 3rd param `lucide_icons: HashMap<String, String>` (localName →
   JSON). Parse each JSON value into `LucideIcon` (serde_json; on parse error skip that entry +
   push a warning). Build `LucideEnv`, store `Some(Rc::new(env))` in the route `Scope`. Return
   its accumulated warnings merged with inline warnings.
4. `compile_full` (lib.rs:88) grows a 4th param `lucide_icons: HashMap<String, String>`,
   forwards to `lower_with_sources`. `compile_with_path` (lib.rs:19) passes `HashMap::new()`.
5. `compile_jsx` napi (jsx_compile.rs:24) grows `lucide_icons: Option<HashMap<String,String>>`,
   forwards `.unwrap_or_default()`.
6. `jsx-rustc.rs` bin call site → pass `HashMap::new()`.
7. serde_json: confirm it's already a dep of the compiler crate; if not, add it.

**Verify:**
- `cargo test --workspace --locked` → green (new test + all existing, incl. the existing
  `compile_jsx_*` tests which must be updated to 4-arg).
- `cargo clippy --workspace --all-targets --locked -D warnings` → clean.

**BLOCKED fallback:** if serde_json parse of the nested `node` array is awkward as a typed
struct, parse to `serde_json::Value` and read fields defensively — the typed struct is a
nicety, not load-bearing.

---

## T2 — Rust static lucide emission (`build_lucide_svg`, static props)

**File:** `crates/jsx-rust-compiler/src/lower.rs` (+ a golden under
`crates/jsx-rust-compiler/tests/` matching the existing golden harness layout).

**Test first** — goldens (find the existing golden dir/pattern, e.g. emit goldens; add
fixtures):
- **AC1** `<Search/>` + lucide map `{Search:{cls:"lucide lucide-search",node:[["path",{d:"m21 21-4.34-4.34"}],["circle",{cx:"11",cy:"11",r:"8"}]]}}` →
  ```html
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-search"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>
  ```
  (exact attr order is the emitter's choice — assert via the golden snapshot; pin a stable
  order in `build_lucide_svg`.) Assert **no** `comp_` slot and components_json == `[]`.
- **AC2** `<Search size={16}/>` → `width="16" height="16"`.
- **AC5** aliased: map key `Icon` with `cls:"lucide lucide-circle"` → `<Icon/>` emits that class.
- **AC7** tag NOT in map (`<Layout/>`, no map entry) → unchanged SsrComponent (slot emitted).
- **AC8** same route compiled with empty lucide map → identical to pre-feature template.

**Implementation:**
1. In `lower_ssr_component` (lower.rs:1237), **after** the `in_map` guard (line 1249) and
   **before** `has_native`/attr loop (line 1259), insert:
   ```rust
   if let Some(lenv) = &scope.lucide_env
       && let Some(icon) = lenv.icons.get(component_name)
   {
       match build_lucide_svg(el, icon, scope) {
           Ok(Some(node)) => return Ok(node),     // static SVG Element
           Ok(None) => { /* soft-fallback (T3): warn + fall through to SSR path below */ }
           Err(e) => return Err(e),
       }
   }
   ```
   (T2 implements only the static success path; soft-fallback Ok(None) cases are T3.)
2. `build_lucide_svg(el, icon, scope) -> Result<Option<JsxNode>, LowerError>`:
   - Walk `el.opening.attrs`. Reject spread → return `Ok(None)` (T3 wires the warning).
   - Recognized props: `size`, `color`, `strokeWidth`, `className`, `absoluteStrokeWidth`,
     plus passthrough (`aria-*`, `role`, `data-*`, other valid attrs). Strip `isr`/`key`/`ref`.
   - Build `attrs: Vec<JsxAttr>` in a fixed order:
     `xmlns, width, height, viewBox, fill, stroke, stroke-width, stroke-linecap,
     stroke-linejoin, [aria-hidden], [passthrough…], class`.
   - Static defaults are literal `AttrValue::Static`. `size` static (StaticNum/StaticText) →
     `width`/`height` literal; dynamic Expr → T3. `color`→`stroke`, `strokeWidth`→`stroke-width`
     same.
   - `aria-hidden="true"` emitted unless any `aria-*`/`role` prop present.
   - `class`: T2 handles the no-className and static-className cases (concat literal).
   - children: `icon.node.iter()` → `JsxNode::Element { tag, attrs: static, children: [] }`.
   - For T2, if any recognized prop is dynamic OR className is dynamic OR absoluteStrokeWidth
     present → return `Ok(None)` temporarily (T3 fills these in). Keep T2 green on static cases.

**Verify:** `cargo test --workspace --locked` green; `cd runtime && bun run build`.

**BLOCKED fallback:** if matching the existing golden harness format is unclear, add the
assertions as plain `#[test]` unit tests calling `compile_full(...).template` and
`assert!(template.contains(...))` rather than snapshot goldens — coverage is what matters.

---

## T3 — Rust dynamic props + class merge + soft-fallback

**File:** `crates/jsx-rust-compiler/src/lower.rs`.

**Test first:**
- **AC3** `<Search color={data.c} strokeWidth={data.w}/>` →
  `stroke="{{ (data.c) | e }}" stroke-width="{{ (data.w) | e }}"`.
- **AC4a** `<Search className="w-4 h-4"/>` → `class="lucide lucide-search w-4 h-4"`.
- **AC4b** `<Search className={data.cls}/>` → `class="lucide lucide-search {{ (data.cls) | e }}"`.
- **AC6** `<Search {...props}/>` → soft-fallback: a `components_json` SSR entry exists AND
  `compiled.warnings` non-empty.

**Implementation:**
1. Dynamic recognized props: lower the attr value via `lower_expr`; non-static result →
   `AttrValue::Expr(expr)` (emit_attr already emits `{{ (expr) | e }}`).
2. `size` dynamic → set BOTH `width` and `height` to `AttrValue::Expr(expr.clone())`.
3. className dynamic → `class` value = `AttrValue::Expr(Expr::Concat(vec![
   Expr::StaticText("lucide lucide-<kebab> ".into()), <className expr>]))`. Verify emit:
   `class="{{ ("lucide lucide-search " ~ data.cls) | e }}"` is acceptable (reviewer F6 says
   yes). If a literal-prefix + interp form reads cleaner, that's an emit-time choice — the
   golden pins whichever; both are correct HTML.
4. `absoluteStrokeWidth`: if present AND both `strokeWidth`+`size` static → compute
   `strokeWidth*24/size` as the `stroke-width` literal. Else → `Ok(None)` soft-fallback.
5. Soft-fallback (`Ok(None)` from build_lucide_svg): in the caller, push a warning to
   `lenv.warnings` (e.g. `format!("lucide <{component_name}/> not statically inlined (spread or
   dynamic absoluteStrokeWidth); falling back to React SSR")`) and fall through to the existing
   SSR-component emission. The warnings must reach `Compiled.warnings` (merge `lucide_env`
   warnings in `lower_with_sources`, same as inline warnings).

**Verify:** `cargo test --workspace --locked` green; clippy clean; `cd runtime && bun run build`.

**BLOCKED fallback:** if `Expr::Concat` in a `class` attr emits an unexpected shape, fall back
to a dedicated `AttrValue` rendering: emit the static prefix as a literal then the dynamic part
as `{{ … | e }}` by special-casing `name=="class"` in `emit_attr` (mirrors the existing
`x-props`/`json_attr` special-case there). Prefer the Concat reuse if it works.

---

## T4 — TS extraction (`extractLucideIcons`)

**File:** `runtime/cli/native-routes-emit.ts` (+ tests in `native-routes-emit.test.ts`).

**Test first** (`native-routes-emit.test.ts`):
- **AC9** a fixture source `import { Search } from 'lucide-react'` →
  `extractLucideIcons(path)` returns `Map` with `"Search"` → JSON whose parsed `cls ===
  "lucide lucide-search"`, `node` is a non-empty array, and **no** `key` prop in any node attrs.
- **AC10** `import { ChevronRight } from 'lucide-react'` → key `"ChevronRight"`, cls
  `"lucide lucide-chevron-right"`.
- **AC11** `import { Search as Icon } from 'lucide-react'` → map key `"Icon"`, node sourced from
  `search.mjs`.
- **AC12** `import { NotARealIconXYZ } from 'lucide-react'` → omitted from map (no throw).

**Implementation:**
```ts
export async function extractLucideIcons(file: string): Promise<Record<string, string>> {
  const refs = scanImportRefs(file)
  const out: Record<string, string> = {}
  for (const [local, entry] of refs) {
    if (!entry.bare || entry.spec !== 'lucide-react') continue
    const pascal = entry.imported ?? local            // default import → local
    const kebab = toKebabCase(pascal)
    try {
      const mod = await import(`lucide-react/dist/esm/icons/${kebab}.mjs`)
      const iconNode = mod.__iconNode
      if (!Array.isArray(iconNode)) continue
      const node = iconNode.map(([tag, attrs]: [string, Record<string, string>]) => {
        const { key, ...rest } = attrs
        return [tag, Object.entries(rest)]
      })
      out[local] = JSON.stringify({ cls: `lucide lucide-${kebab}`, node })
    } catch { /* unresolvable → omit (graceful) */ }
  }
  return out
}
// toKebabCase: s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
```
- `node` shape must match the Rust `LucideIcon.node` deserialization
  (`Vec<(String, Vec<(String,String)>)>`): `[tag, [[attr,val],…]]`. Adjust whichever side to
  agree — pin it in T1's serde shape and here together.

**Verify:** `bun test runtime/cli/native-routes-emit.test.ts` green; `bun run ci` (biome) clean.

**BLOCKED fallback:** if `import('lucide-react/dist/esm/icons/<kebab>.mjs')` doesn't resolve
from the runtime cwd, try the package's `dynamicIconImports` map
(`(await import('lucide-react/dynamicIconImports')).default[kebab]()`) — same `__iconNode`.

---

## T5 — TS wiring (per-route extraction + 4th arg + type)

**File:** `runtime/cli/native-routes-emit.ts`.

**Implementation:**
1. Widen the local `compileJsx` type (line 479-485): add 4th param
   `lucideIcons?: Record<string, string>`.
2. In the per-route loop, after computing `routeSourcePath` (line 561), call
   `const lucideIcons = await extractLucideIcons(routeSourcePath)`.
   - For the nested-chain synthetic path (`chainNames.length > 1`), extract from each real
     chain source and merge (icons live in the leaf/layout component files, not the synthetic
     wrapper). Reuse the chain source paths already gathered.
3. Pass as 4th arg: `compileJsx!(routeSource, routeSourcePath, sources, lucideIcons)` (line 565).

**Verify (integration, AC13):**
- `cd runtime && bun run build` (napi fresh).
- `bun run runtime/cli/index.ts build example/pokedex/index.ts`.
- Inspect an icon-bearing template under the pokedex build output: assert it contains a literal
  `<svg class="lucide ` (or `class="lucide lucide-…"`) and that an icon-only page emits **no**
  `comp_N_html` slot for the icon and **no** `lucide-react` import in its `.factory.ts`.
- `bun test runtime/` → 472+ green (no regression).

**BLOCKED fallback:** if chain-path extraction is fiddly, ship flat-route extraction first
(the common case; HeroSearch/ThemeToggle/AddToTeamButton are flat) and note nested-layout icon
extraction as a follow-up — don't block the whole feature on the chain merge.

---

## T6 — pokedex migration + browser smoke + baselines

**Files:** `example/pokedex/components/*.tsx` (icon usages).

**Implementation:**
1. Remove the now-redundant `isr={{ key: 'LcIcon…' }}` props from lucide usages
   (`HeroSearch`, `ThemeToggle`, `AddToTeamButton`, `DexFilter`, any others). They are stripped
   by the compiler regardless, but removing keeps source honest.
2. Rebuild + run pokedex dev (`BRUST_PORT=39xxx bun run runtime/cli/index.ts dev
   example/pokedex/index.ts`).

**Verify (AC14, browser):**
- playwright MCP (`mcp__plugin_playwright_playwright__*` — the plain one launches its own
  chromium; the ecc one needs an absent bridge). Load the homepage; assert lucide icons are
  visible (the Search/Plus/theme icons render as `<svg class="lucide …">` in the DOM).
- If any dynamic-prop icon exists, confirm the substituted attr value is present.

**Full baselines (mirror ci.yml; [[release-mirror-ci-gates]]):**
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --locked -D warnings`
- `cargo test --workspace --locked`
- `cd runtime && bun run build`
- `bun run ci` (biome)
- `bun test runtime/`
- native integration separately (`native-island native-island-ssr native-inline
  native-source-mode cli-new cli-build integration`; kill ports between).

**BLOCKED fallback:** if playwright MCP is unavailable, fall back to `curl`-ing the dev server
and grepping the served HTML for `<svg class="lucide` — proves SSR output without a browser.
```
