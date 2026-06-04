# Plan — Native `behavior` → auto-injected `x-data` (via `x-behavior`)

Spec: `docs/superpowers/specs/2026-06-04-native-behavior-auto-xdata-design.md`
Branch: `feat/native-behavior-auto-xdata` (base for impl = HEAD after this plan commits)

## Spec-coverage table

| Spec section | Task(s) |
|---|---|
| §1 `directiveName` helper + hashed `scanDirectiveComponents` | T1 |
| §3 Rust 5th param threading (`compile_full`/`lower_with_sources`/Scope/napi) | T2 |
| §4 inject on inline root (no-marker, case 3) | T3 |
| §4 `x-behavior` host (case 2), literal `x-data` (case 1), error cases, stray strip | T4 |
| §2 `emitNativeRoutes` builds `directiveNames` + 5th arg; `index.d.ts` | T5 |
| §6 migrate pokedex + dogfood `x-behavior` + integration | T6 |
| Build/verify (full ci.yml mirror) | T7 |

Sequence is strict; each task is its own commit. Rust changes (T2–T4) precede the TS
wiring (T5) so `cargo test` stays green at each step; T2 is a pure no-op-additive
thread so T3/T4 build on a green base.

---

## T1 — TS: `directiveName` helper + hashed names (`runtime/native/build.ts`)

**RED** — add to `runtime/native/build.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { directiveName, scanDirectiveComponents } from './build.ts'
import { resolve } from 'node:path'

describe('directiveName', () => {
  const root = '/proj'
  it('is camelCase basename + _ + 8 hex, matches the runtime chunk-name guard', () => {
    const n = directiveName('/proj/components/AddToTeamButton.tsx', root)
    expect(n).toMatch(/^addToTeamButton_[0-9a-f]{8}$/)
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/) // loadBehavior guard in runtime.ts
  })
  it('is deterministic for the same relative path', () => {
    expect(directiveName('/proj/a/B.tsx', root)).toBe(directiveName('/proj/a/B.tsx', root))
  })
  it('differs for different paths sharing a basename (collision avoided)', () => {
    expect(directiveName('/proj/x/Button.tsx', root)).not.toBe(
      directiveName('/proj/y/Button.tsx', root),
    )
  })
  it('hashes the cwd-relative path (stable across an absolute prefix move)', () => {
    // same relative layout under a different root → same name (dist-relocation safe)
    expect(directiveName('/ci/app/c/W.tsx', '/ci/app')).toBe(
      directiveName('/srv/app/c/W.tsx', '/srv/app'),
    )
  })
})
```

**GREEN** — in `runtime/native/build.ts`:

```ts
import { createHash } from 'node:crypto'
import { basename, extname, relative } from 'node:path'

/** Deterministic, app-unique directive name = camelCase(basename) + "_" + 8 hex of
 *  sha256(cwd-relative path). The SINGLE name contract: chunk filename, runtime
 *  registry key, and the compiler-emitted `x-data` all derive from this. */
export function directiveName(absPath: string, projectRoot: string): string {
  const base = basename(absPath, extname(absPath))
  const camel = base.length > 0 ? base[0]!.toLowerCase() + base.slice(1) : base
  const rel = relative(projectRoot, absPath).replaceAll('\\', '/')
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8)
  return `${camel}_${hash}`
}
```

Replace `registerName(filePath)` usage in `scanDirectiveComponents` with
`directiveName(filePath, process.cwd())`. Keep the existing "two files derive the same
name" throw (defense-in-depth; update its message to mention the hash). Delete the now-unused
`registerName` (or keep it only if another caller exists — `grep registerName` first; it has none in non-test code).

**VERIFY**: `bun test runtime/native/build.test.ts` → new tests pass; existing pass.
`bun run ci` (biome, from repo root) clean.

**BLOCKED fallback**: if any non-test caller of `registerName` surfaces, keep
`registerName` and have it delegate to `directiveName(path, process.cwd())`.

---

## T2 — Rust: thread `directive_names` (no behavior change yet)

Pure additive thread so every existing test stays green.

**RED** — add to `crates/brust/src/jsx_compile.rs` tests (or `lib.rs` tests):

```rust
#[test]
fn compile_full_directive_names_unmatched_is_noop() {
    // A populated directive map whose ident is NOT inlined → output unchanged.
    let src = r#"export default function Page({ g }) { return <p>{g}</p>; }"#;
    let mut dn = HashMap::new();
    dn.insert("Nope".to_string(), "nope_deadbeef".to_string());
    let with = compile_full(src, "<t>", HashMap::new(), HashMap::new(), dn).unwrap();
    let without = compile_full(src, "<t>", HashMap::new(), HashMap::new(), HashMap::new()).unwrap();
    assert_eq!(with.template, without.template);
}
```

**GREEN**:
1. `lib.rs` `compile_full`: add 5th param `directive_names: HashMap<String, String>`; pass
   to `lower_with_sources(&parsed, component_sources, lucide_icons, directive_names)`.
   Update `compile_with_path` (line 20) to pass `HashMap::new()`.
2. `lower.rs`:
   - `Scope` (line ~106): add field `directive_names: Option<Rc<HashMap<String, String>>>`.
   - Update ALL THREE `Scope { … }` literals: `lower` (line 138 → `directive_names: None`),
     `lower_with_sources` (line 230 → `Some(dn.clone())`), `lower_component_inline`
     (line 330 → thread a new `directive_names` param like `lucide`).
   - `lower_with_sources` signature: add `directive_names: HashMap<String,String>`; wrap
     `let dn = Rc::new(directive_names);` and put `Some(dn.clone())` on the route scope.
   - `lower_component_inline` signature: add `directive_names: Option<Rc<HashMap<String,String>>>`
     param; set it on its scope. Update the call site (line ~2084) to pass
     `scope.directive_names.clone()`.
3. `crates/brust/src/jsx_compile.rs` `compile_jsx`: add 5th arg
   `directive_names: Option<HashMap<String, String>>` and pass `.unwrap_or_default()`.
4. Update EVERY existing `compile_full(...)` / `lower_with_sources(...)` call in crate tests
   to pass the extra `HashMap::new()` arg (grep `compile_full(` and `lower_with_sources(`).

**VERIFY**: `cargo test --workspace --locked` green (all existing + the new no-op test).

**BLOCKED fallback**: if threading `directive_names` through `lower_component_inline`'s
signature churns too many call sites, store it ONLY on `Scope` and read `scope.directive_names`
at the injection site (T3) — `lower_component_inline` already receives the parent via the
scope it builds; pass it the same way `lucide` is passed (one param, mirrored).

---

## T3 — Rust: inject `x-data` on inline behavior-component root (no marker)

**RED** — `lower.rs` tests:

```rust
#[test]
fn inline_behavior_component_root_gets_xdata() {
    let route = r#"export default function Page({ data }) {
  return <div><Btn native data={data}/></div>;
}"#;
    // Btn has export const behavior (tolerated/ignored) + a single root <button>.
    let btn = r#"export const behavior = () => ({});
export default function Btn({ data }) { return <button x-text="label">x</button>; }"#;
    let mut sources = HashMap::new();
    sources.insert("Btn".to_string(), btn.to_string());
    let mut dn = HashMap::new();
    dn.insert("Btn".to_string(), "btn_abc12345".to_string());
    let c = compile_full(route, "<t>", sources, HashMap::new(), dn).unwrap();
    assert!(c.template.contains(r#"<button x-data="btn_abc12345""#));
    // exactly one x-data
    assert_eq!(c.template.matches("x-data=").count(), 1);
}
```

**GREEN** — in `lower_ssr_component`, native-inline branch, AFTER `splice_children_slots`
(line ~2133) and BEFORE `Ok(Some(root_node))` (line ~2146):

```rust
// Auto-inject x-data for a registered behavior component (host = root for now; T4
// adds x-behavior / literal-x-data / errors). `component` is the tag ident.
if let Some(dn) = &scope.directive_names
    && let Some(unique) = dn.get(&component)
{
    inject_directive_xdata(&mut root_node, unique, &component, span)?;
}
```

Add the helper (T3 version handles only case 3 = root Element; T4 extends it):

```rust
/// Add `x-data="<unique>"` to the behavior component's host element. T3: host = the
/// root node, which must be a `JsxNode::Element`.
fn inject_directive_xdata(
    root: &mut JsxNode,
    unique: &str,
    component: &str,
    span: Span,
) -> Result<(), LowerError> {
    match root {
        JsxNode::Element { attrs, .. } => {
            attrs.push(JsxAttr {
                name: "x-data".to_string(),
                value: AttrValue::Static(unique.to_string()),
            });
            Ok(())
        }
        other => Err(LowerError::at(
            span,
            ErrorKind::BehaviorHostNotElement(component.to_string(), node_kind_name(other)),
        )),
    }
}

/// Human-readable IR node kind for the error message.
fn node_kind_name(n: &JsxNode) -> &'static str {
    match n {
        JsxNode::Element { .. } => "element",
        JsxNode::Fragment { .. } => "fragment",
        JsxNode::Map { .. } => "list (.map / x-for)",
        JsxNode::Cond { .. } => "conditional",
        JsxNode::Document { .. } => "BrustPage document",
        JsxNode::ChildrenSlot => "children slot",
        JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::RawHtml(_) => "text/expression",
        JsxNode::SsrComponent { .. } => "component",
        JsxNode::Island { .. } => "island",
        JsxNode::Empty => "empty",
    }
}
```

Add `ErrorKind::BehaviorHostNotElement(String, &'static str)` (component, kind) with a
`CompileError` message: *"native component `<{0}>` has `export const behavior` but its
root is {1}, not a single element to host its mount; tag the host with a bare
`x-behavior` or wrap it in one root element."* Mirror an existing two-field `ErrorKind`
variant for the Display/`from_lower` wiring.

**VERIFY**: `cargo test --workspace --locked` green incl. the new test.

**BLOCKED fallback**: if `span` isn't in scope at line 2133, reuse the element span
captured earlier in `lower_ssr_component` (`el.opening.span`).

---

## T4 — Rust: `x-behavior` host, literal `x-data` skip, error cases, stray strip

**RED** — `lower.rs` tests (one per case):

```rust
// helper to build a route inlining `Btn` with the given Btn body + directive map.
fn compile_btn(btn_body: &str) -> Result<jsx_rust_compiler::Compiled, /*Err*/_> {
    let route = r#"export default function Page({ data }) { return <div><Btn native data={data}/></div>; }"#;
    let btn = format!("export const behavior = () => ({{}});\nexport default function Btn({{data}}) {{ return {btn_body}; }}");
    let mut sources = HashMap::new(); sources.insert("Btn".into(), btn);
    let mut dn = HashMap::new(); dn.insert("Btn".into(), "btn_abc12345".into());
    compile_full(route, "<t>", sources, HashMap::new(), dn)
}

#[test] fn x_behavior_marks_non_root_host() {
    // root <div> bare; inner <button x-behavior> becomes the host
    let c = compile_btn(r#"<div className="wrap"><button x-behavior x-text="l">x</button></div>"#).unwrap();
    assert!(c.template.contains(r#"<button x-data="btn_abc12345""#));
    assert!(!c.template.contains("x-behavior"));      // stripped, never leaks
    assert!(!c.template.contains(r#"<div x-data"#));   // root stays bare
    assert_eq!(c.template.matches("x-data=").count(), 1);
}
#[test] fn literal_x_data_wins_no_injection() {
    let c = compile_btn(r#"<div x-data="mine" x-text="l">x</div>"#).unwrap();
    assert!(c.template.contains(r#"x-data="mine""#));
    assert!(!c.template.contains("btn_abc12345"));
    assert_eq!(c.template.matches("x-data=").count(), 1);
}
#[test] fn valued_x_behavior_is_error() {
    assert!(compile_btn(r#"<div x-behavior="oops">x</div>"#).is_err());
}
#[test] fn two_x_behavior_is_error() {
    assert!(compile_btn(r#"<div><a x-behavior>1</a><b x-behavior>2</b></div>"#).is_err());
}
#[test] fn non_element_root_is_error() {
    // fragment root → BehaviorHostNotElement
    assert!(compile_btn(r#"<><span>a</span><span>b</span></>"#).is_err());
}
```

Plus a no-behavior stray test (component NOT in directive_names) — assert `x-behavior`
is stripped and a warning recorded:

```rust
#[test] fn stray_x_behavior_in_non_behavior_component_warns_and_strips() {
    let route = r#"export default function Page({ data }) { return <div><Plain native/></div>; }"#;
    let plain = r#"export default function Plain() { return <p x-behavior>hi</p>; }"#;
    let mut sources = HashMap::new(); sources.insert("Plain".into(), plain.to_string());
    // Plain NOT in directive_names (no behavior)
    let c = compile_full(route, "<t>", sources, HashMap::new(), HashMap::new()).unwrap();
    assert!(!c.template.contains("x-behavior"));
    assert!(c.warnings.iter().any(|w| w.contains("x-behavior")));
}
```

**GREEN** — extend `inject_directive_xdata` to the full host-resolution algorithm
(operate on the root subtree, NOT descending into nested mount boundaries):

1. **Scan** the subtree (root + descendants, stopping at any element already carrying
   `x-data`, and at nested SsrComponent boundaries) collecting: whether any element has
   literal `x-data`; the list of elements carrying `x-behavior` (and whether each is bare
   `AttrValue::Empty` vs valued).
2. **Case 1** literal `x-data` present anywhere → return Ok (no injection).
3. **Case 2** exactly one bare `x-behavior` → remove that attr from that element, push
   `x-data` on it. A valued `x-behavior` OR >1 `x-behavior` → `Err(ErrorKind::XBehaviorMisuse(...))`.
4. **Case 3** no marker → require root is `Element` (else `BehaviorHostNotElement`); push `x-data`.

For the **stray** case (component not in `directive_names`): in the `else` of the T3
injection guard, call `strip_stray_x_behavior(&mut root_node, &component, env)` which
walks the subtree, removes any `x-behavior` attr, and pushes one warning per component
(via `env.warnings`). `env` (the `InlineEnv`) is in scope in the native-inline branch.

Add a recursive attr-mutation walker (or reuse the splice pattern from
`splice_children_slots`). Add `ErrorKind::XBehaviorMisuse(String)` with a clear message.

**DEFENSIVE EMIT** — `emit_jinja.rs` element loop (line 57): skip any attr named
`x-behavior` so a stray that escapes the strip can never reach HTML:

```rust
for a in attrs {
    if a.name == "x-behavior" { continue; } // compile-time-only marker
    emit_attr(a, out);
}
```

**VERIFY**: `cargo test --workspace --locked` green incl. all T4 cases. Existing golden
fixtures unchanged (no directive_names there). `cargo clippy --workspace --all-targets
--locked -- -D warnings` clean. `cargo fmt --all --check` clean.
**Then** `cd runtime && bun run build` to refresh the `.node` (stale-binary trap).

**BLOCKED fallback**: if "don't descend into nested mount boundary" is fiddly, the
pokedex components are flat (root + a few children, no nested behavior component) — scope
the scan to root + direct/indirect children and treat a nested `x-data` element as an
opaque stop. Note the simplification in the commit.

---

## T5 — TS: `emitNativeRoutes` builds `directiveNames` + 5th arg

**RED** — extend `runtime/cli/native-routes-emit.test.ts` (or the closest native-emit
test): a route inlining a behavior component emits `x-data="<name>_<8hex>"` on the
component root in the compiled jinja. (If a direct unit harness is awkward, rely on the
T6 integration test and make T5 a wiring-only change verified by `bun run ci` + the
pokedex smoke in T6 — state which.)

**GREEN** — in `runtime/cli/native-routes-emit.ts`:
1. Update the typed local `compileJsx` signature (line ~480-485) and `index.d.ts` line 10
   to add `directiveNames?: Record<string, string> | undefined | null` as the 5th param.
2. At the call site (line ~578), before calling, build:

```ts
const { directiveName } = await import('../native/build.ts')
const BEHAVIOR_RE = /export\s+const\s+behavior\b/
const directiveNames: Record<string, string> = {}
for (const [ident, src] of Object.entries(sources)) {
  if (!BEHAVIOR_RE.test(src)) continue
  const ref = mergedImports.get(ident)
  if (ref && !ref.bare && typeof ref.spec === 'string') {
    directiveNames[ident] = directiveName(ref.spec, process.cwd())
  }
}
compiled = compileJsx!(routeSource, routeSourcePath, sources, lucideIcons, directiveNames)
```

   (Confirm the exact shapes of `sources` and `mergedImports` at this scope from the
   surrounding code; `mergedImports` is a `Map<ident, {spec, bare}>` per the spec review.
   `BEHAVIOR_RE` mirrors `build.ts`.)

**VERIFY**: `bun run ci` clean; `bun test runtime/` green (no regressions).

**BLOCKED fallback**: if `sources` is keyed differently than `mergedImports`, derive the
behavior set by intersecting on ident; if a behavior component's `spec` path is absent in
`mergedImports` at this scope, fall back to resolving it the same way
`gatherComponentSources` does and log which path was used.

---

## T6 — Migrate pokedex examples + dogfood `x-behavior` + integration

1. Drop `x-data="…"` from `example/pokedex/components/AddToTeamButton.tsx`,
   `HeroSearch.tsx`, `DexFilter.tsx` (keep `x-props={…}` on the same root element).
2. Dogfood the escape hatch: pick ONE component (or a dedicated fixture under the native
   integration test) where the host is NOT the root, and tag it with a bare `x-behavior`.
   If none is natural in pokedex, add a compiler fixture
   (`crates/jsx-rust-compiler/fixtures/`) + golden `.expected.jinja` exercising the
   `x-behavior` path (matches the existing fixture-golden convention) instead of forcing
   it into pokedex.
3. Build pokedex: `bun run runtime/cli/index.ts build example/pokedex/index.ts`.
4. Integration: in the relevant `tests/` native suite, assert the served HTML carries
   `x-data="<name>_<8hex>"` on the un-annotated component root and the chunk
   `/_brust/islands/<name>_<8hex>.directive.js` is 200. Mirror the existing
   native-island integration assertions. Run native suites SEPARATELY (port-race flake):
   `native-inline native-island native-island-ssr native-source-mode cli-build`.

**VERIFY**: pokedex builds; integration suites green; browser/curl smoke shows the
generated `x-data` and a 200 chunk.

**BLOCKED fallback**: if a pokedex component turns out to mount on a non-root element,
that one needs a bare `x-behavior` rather than full removal — handle per component, don't
blanket-remove.

---

## T7 — Full verification (Phase 6 gate)

Run, in order, capturing real output (no trusting subagent counts):
1. `cargo fmt --all --check`
2. `cargo clippy --workspace --all-targets --locked -- -D warnings`
3. `cargo test --workspace --locked` (expect jsx-compiler count up by the new tests; brust 144)
4. `cd runtime && bun run build` (refresh `.node`)
5. `bun run ci` (biome, repo root)
6. `bun test runtime/` (expect ~477 + new build.test cases)
7. native integration suites separately
8. pokedex `brust build` + dev curl smoke for `x-data="…_<hash>"` + 200 chunk

## Out of scope (carried from spec)

- Route-root auto-injection (inline `<Comp native/>` only).
- `x-props` auto-injection (author still passes loader data).
- Persisting `uniqueName` in `islands.json` (cwd-relative determinism assumed).
- Runtime mount/dispose model unchanged (the `effect`-in-`behavior` follow-up is separate).
