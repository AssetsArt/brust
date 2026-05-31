# SSR-component ISR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an SSR component on a native route opt into ISR caching (`isr={{ key, tags?, revalidate? }}`) so its `comp_N_html` renders once per key and is served from the shared Rust cache on later same-key requests.

**Architecture:** Mirror the already-shipped island ISR plumbing across three layers. Compiler: `JsxNode::SsrComponent` + `ComponentMeta` grow `key_path/tags_path/revalidate`; a shared `parse_isr_object` helper (extracted from `lower_island`) parses the attribute for both islands and components; `components_to_json` emits the fields. Runtime: `resolveComponentContext` gains a `cache?` param and an ISR fast-path identical in logic to `resolveIslandContext`, storing `props=""`. Rust `island_cache.rs` + the `island_cache_*` NAPI are reused **unchanged** (shared keyspace).

**Tech Stack:** Rust (swc_core AST, `crates/jsx-rust-compiler`), TypeScript (Bun runtime, `runtime/`), the existing moka-backed `MokaStore` + NAPI bridge.

**Spec:** `docs/superpowers/specs/2026-05-31-ssr-component-isr-design.md`

**No addon rebuild needed anywhere:** the Rust runtime (`crates/brust`) is untouched, so `runtime/index.js` (the prebuilt `.node`) already exposes the `island_cache_*` functions the integration test uses. Compiler tests run `crates/jsx-rust-compiler` directly; TS tests construct manifests by hand. Only `cargo test -p jsx-rust-compiler` (Tasks 1–3) and `bun test` (Tasks 4–6) are required.

**Verification baselines (must stay green at the end):**
- `cargo test --workspace`
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -D warnings`
- `bun test runtime/` and `bun run ci` (biome — auto-fix with `bunx biome check --write <file>`)
- `bun test tests/native-island-ssr.test.ts` (run separately — port-race + mock.module leak)

---

## Spec coverage table

| Spec section | Task |
|---|---|
| §1 shared `parse_isr_object` extraction | Task 1 |
| §1 `JsxNode::SsrComponent` 3 fields + `lower_ssr_component` isr arm + `ComponentIsrUnsupported(String)` | Task 2 |
| §1 `ComponentMeta` fields + `collect_components` copy + `components_to_json` emit | Task 3 |
| §2 `NativeComponentEntry` fields + `resolveComponentContext` cache param + ISR fast-path | Task 4 |
| §2 wire `islandCache` into `routes.ts` | Task 5 |
| §4 integration: render-once + invalidate (real Rust cache) | Task 6 |
| Invariant 4 (throw → empty, no poison) | Task 4 |
| Invariant 5 (`props=""`) | Task 4, Task 6 |
| Invariant 7 (shared keyspace invalidation) | Task 6 |

---

## Task 1: Extract `parse_isr_object` shared helper (pure refactor)

Extract the `isr` object-literal parsing from `lower_island`'s `"isr"` arm into a free function so `lower_ssr_component` (Task 2) can reuse it. **No behavior change** — the island ISR tests are the regression guard.

**Files:**
- Modify: `crates/jsx-rust-compiler/src/lower.rs` (the `"isr"` arm at ~`:641`; add helper near `expr_to_path` at ~`:807`)

- [ ] **Step 1: Add the `parse_isr_object` helper**

Add this function immediately above `fn expr_to_path` (~`lower.rs:807`). The body is lifted verbatim from the current `"isr"` arm (`lower.rs:641–695`), with the `err` closure now a parameter and `key`/`tags`/`revalidate` collected into locals returned as a tuple. `key` is enforced mandatory here, so it returns `String` (not `Option`):

```rust
/// Parse an `isr={{ key, tags?, revalidate? }}` attribute object into
/// `(key_path, tags_path, revalidate)`. Shared by `lower_island` and
/// `lower_ssr_component`. `key` is MANDATORY (a missing key is an `err()`
/// return, never a `None`), hence the non-optional `String` first element.
/// `key`/`tags` accept the same path shape as `props={…}` (destructured ident
/// or one-deep member, via `expr_to_path`); `revalidate` is a non-negative
/// integer literal ≤ u32::MAX/1000 (a larger value would wrap when sent as
/// `revalidate * 1000` ms across NAPI). `err` produces the caller's error
/// variant so a bad isr blames the right element (island vs component).
fn parse_isr_object(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
    err: &dyn Fn() -> LowerError,
) -> Result<(String, Option<String>, Option<u32>), LowerError> {
    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else {
        return Err(err());
    };
    let JSXExpr::Expr(e) = &c.expr else {
        return Err(err());
    };
    let SwcExpr::Object(obj) = strip_paren(e.as_ref()) else {
        return Err(err());
    };
    let mut key_path: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut revalidate: Option<u32> = None;
    for prop in &obj.props {
        let PropOrSpread::Prop(p) = prop else {
            return Err(err());
        };
        let Prop::KeyValue(kv) = p.as_ref() else {
            return Err(err());
        };
        let pname = match &kv.key {
            PropName::Ident(i) => i.sym.to_string(),
            PropName::Str(s) => s.value.to_string_lossy().into_owned(),
            _ => return Err(err()),
        };
        match pname.as_str() {
            "key" => key_path = Some(expr_to_path(&kv.value, scope, err)?),
            "tags" => tags_path = Some(expr_to_path(&kv.value, scope, err)?),
            "revalidate" => {
                let SwcExpr::Lit(Lit::Num(n)) = strip_paren(&kv.value) else {
                    return Err(err());
                };
                const MAX_REVALIDATE_SECS: f64 = (u32::MAX / 1000) as f64;
                if n.value < 0.0 || n.value.fract() != 0.0 || n.value > MAX_REVALIDATE_SECS {
                    return Err(err());
                }
                revalidate = Some(n.value as u32);
            }
            _ => return Err(err()),
        }
    }
    // `key` is mandatory — a tags-/revalidate-only isr has nothing to key by.
    let key_path = key_path.ok_or_else(err)?;
    Ok((key_path, tags_path, revalidate))
}
```

- [ ] **Step 2: Replace the `lower_island` `"isr"` arm body to call the helper**

Replace the body of the `"isr" =>` arm (`lower.rs:641–696`, everything between `"isr" => {` and its closing `}`) with:

```rust
            "isr" => {
                let err = || LowerError::at(jsx_attr.span, ErrorKind::IslandIsrUnsupported);
                let (k, t, r) = parse_isr_object(jsx_attr, scope, &err)?;
                key_path = Some(k);
                tags_path = t;
                revalidate = r;
            }
```

(The island `ssr`-required check at `lower.rs:724` stays exactly as-is — it is island-specific.)

- [ ] **Step 3: Run the compiler test suite — verify zero regressions**

Run: `cargo test -p jsx-rust-compiler`
Expected: PASS, same test count as before. The island ISR tests (`lowers_isr_key_tags_revalidate`, `isr_without_ssr_is_rejected`, `isr_dynamic_revalidate_is_rejected`, `isr_key_only_is_allowed`, `isr_fractional_revalidate_is_rejected`, `isr_negative_revalidate_is_rejected`, `isr_oversized_revalidate_is_rejected`, `isr_without_key_is_rejected`, `isr_empty_object_is_rejected`) all still pass — they are the load-bearing guard that the refactor preserved behavior.

- [ ] **Step 4: fmt + clippy**

Run: `cargo fmt --all && cargo clippy -p jsx-rust-compiler --all-targets --locked -D warnings`
Expected: no diff from fmt, no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/jsx-rust-compiler/src/lower.rs
git commit -m "refactor(compiler): extract parse_isr_object shared by island + component lowering

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: SSR-component `isr` — IR fields, error variant, lower arm

Add the three ISR fields to `JsxNode::SsrComponent`, a `ComponentIsrUnsupported(String)` error, and an `"isr"` arm to `lower_ssr_component` that consumes the attribute (does NOT turn it into a prop).

**Files:**
- Modify: `crates/jsx-rust-compiler/src/ir.rs:76` (`JsxNode::SsrComponent`)
- Modify: `crates/jsx-rust-compiler/src/lower.rs:403` (`lower_ssr_component`) + its test module
- Modify: `crates/jsx-rust-compiler/src/lib.rs:355` (`ErrorKind`)

- [ ] **Step 1: Write the failing lower tests**

Add to the `#[cfg(test)] mod tests` block in `crates/jsx-rust-compiler/src/lower.rs` (next to the other `lower_ssr_component_*` tests, ~`:2505`):

```rust
    #[test]
    fn lower_ssr_component_parses_isr() {
        let src = r#"export default function Page({ data }) {
  return <Layout title={data.title}
    isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                component,
                key_path,
                tags_path,
                revalidate,
                props,
                ..
            } => {
                assert_eq!(component, "Layout");
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(tags_path.as_deref(), Some("data.cacheTags"));
                assert_eq!(*revalidate, Some(60));
                // `isr` is CONSUMED — it must NOT leak as a factory prop. Only
                // `title` survives as a prop.
                let names: Vec<&str> = props
                    .iter()
                    .map(|p| match p {
                        SsrProp::Attr(a) => a.name.as_str(),
                        SsrProp::Spread(_) => panic!("unexpected spread"),
                    })
                    .collect();
                assert_eq!(names, vec!["title"]);
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_ssr_component_isr_key_only_allowed() {
        // No `ssr` prerequisite for components (unlike islands).
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: data.cacheKey }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                key_path,
                tags_path,
                revalidate,
                ..
            } => {
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(*tags_path, None);
                assert_eq!(*revalidate, None);
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_ssr_component_isr_without_key_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ tags: data.cacheTags }} />;
}"#;
        let err = compile_full(src, "<test>").unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComponentIsrUnsupported(_)),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_ssr_component_isr_dynamic_revalidate_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: data.cacheKey, revalidate: data.ttl }} />;
}"#;
        let err = compile_full(src, "<test>").unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComponentIsrUnsupported(_)),
            "got {:?}",
            err.kind
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p jsx-rust-compiler lower_ssr_component_isr 2>&1 | head -30`
Expected: compile error — `JsxNode::SsrComponent` has no field `key_path`, and `ErrorKind::ComponentIsrUnsupported` does not exist.

- [ ] **Step 3: Add the three fields to `JsxNode::SsrComponent`**

In `crates/jsx-rust-compiler/src/ir.rs`, the `SsrComponent` variant (~`:76`) — after the `children` field (`:85`), add:

```rust
        /// Lowered children (may contain Islands, elements, etc.).
        children: Vec<JsxNode>,
        /// Optional ISR cache key path (dotted loader-data path). `None` = no ISR.
        key_path: Option<String>,
        /// Optional ISR cache tags path (resolves to `string[]`).
        tags_path: Option<String>,
        /// Optional ISR revalidation interval in seconds (TTL).
        revalidate: Option<u32>,
```

- [ ] **Step 4: Add the `ComponentIsrUnsupported(String)` error variant**

In `crates/jsx-rust-compiler/src/lib.rs`, in `ErrorKind` (~`:427`, right after `SsrComponentInMapNotSupported`):

```rust
    #[error(
        "`isr` on `<{0}/>` must be `{{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}`"
    )]
    ComponentIsrUnsupported(String),
```

- [ ] **Step 5: Add the `isr` arm + field construction in `lower_ssr_component`**

In `crates/jsx-rust-compiler/src/lower.rs`, `lower_ssr_component` (~`:403`):

(a) Declare the locals just above the `for attr in &el.opening.attrs {` loop (~`:417`, next to `let mut props`):

```rust
    let mut props: Vec<SsrProp> = Vec::new();
    let mut key_path: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut revalidate: Option<u32> = None;
```

(b) Add an `"isr"` arm to the `match name.as_str()` block (~`:439`), alongside `"key" => continue` (`:440`):

```rust
        match name.as_str() {
            "key" => continue,
            "isr" => {
                let err = || {
                    LowerError::at(
                        jsx_attr.span,
                        ErrorKind::ComponentIsrUnsupported(component.clone()),
                    )
                };
                let (k, t, r) = parse_isr_object(jsx_attr, scope, &err)?;
                key_path = Some(k);
                tags_path = t;
                revalidate = r;
                continue;
            }
            "ref" => {
```

(c) Set the fields in the returned IR node (~`:485`):

```rust
    Ok(JsxNode::SsrComponent {
        component,
        instance: 0,
        props,
        children,
        key_path,
        tags_path,
        revalidate,
    })
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cargo test -p jsx-rust-compiler`
Expected: PASS — the 4 new `lower_ssr_component_isr*` tests pass, and all prior tests (incl. the island ISR + `lower_ssr_component_*` + `number_ssr_components`/`collect_components` tests) still pass. The `..` in every existing `SsrComponent` destructure absorbs the new fields, so nothing else breaks.

- [ ] **Step 7: fmt + clippy**

Run: `cargo fmt --all && cargo clippy -p jsx-rust-compiler --all-targets --locked -D warnings`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add crates/jsx-rust-compiler/src/ir.rs crates/jsx-rust-compiler/src/lower.rs crates/jsx-rust-compiler/src/lib.rs
git commit -m "feat(compiler): parse isr={{…}} on SSR components into IR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `ComponentMeta` ISR fields + manifest JSON emission

Thread the IR fields into `ComponentMeta` and emit them in `components.json` so the runtime manifest carries `keyPath`/`tagsPath`/`revalidate`.

**Files:**
- Modify: `crates/jsx-rust-compiler/src/lib.rs` — `ComponentMeta` (`:32`), `collect_components` (`:226`), `components_to_json` (`:293`), test module (~`:653`)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/jsx-rust-compiler/src/lib.rs` (near `islands_to_json_with_isr_fields`, ~`:653`):

```rust
    #[test]
    fn components_to_json_with_isr_fields() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: Some("data.cacheKey".to_string()),
            tags_path: Some("data.cacheTags".to_string()),
            revalidate: Some(60),
        }];
        let json = components_to_json(&components);
        assert!(json.contains("\"keyPath\":\"data.cacheKey\""), "{json}");
        assert!(json.contains("\"tagsPath\":\"data.cacheTags\""), "{json}");
        assert!(json.contains("\"revalidate\":60"), "{json}");
    }

    #[test]
    fn components_to_json_without_isr_omits_fields() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: None,
            tags_path: None,
            revalidate: None,
        }];
        let json = components_to_json(&components);
        assert!(!json.contains("keyPath"), "{json}");
        assert!(!json.contains("tagsPath"), "{json}");
        assert!(!json.contains("revalidate"), "{json}");
    }

    #[test]
    fn collect_components_copies_isr_from_ir() {
        let src = r#"export default function Page({ data }) {
  return <Layout title={data.title} isr={{ key: data.cacheKey, revalidate: 30 }} />;
}"#;
        let c = compile_full(src, "<test>").unwrap();
        assert_eq!(c.components.len(), 1);
        assert_eq!(c.components[0].key_path.as_deref(), Some("data.cacheKey"));
        assert_eq!(c.components[0].tags_path, None);
        assert_eq!(c.components[0].revalidate, Some(30));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p jsx-rust-compiler components_to_json_with_isr 2>&1 | head -20`
Expected: compile error — `ComponentMeta` has no field `key_path`.

- [ ] **Step 3: Add the fields to `ComponentMeta`**

In `crates/jsx-rust-compiler/src/lib.rs`, `ComponentMeta` (`:32`) — after `uses_island` (`:46`):

```rust
    /// True if any `<Island>` node appears in this component's factory tree.
    pub uses_island: bool,
    /// Optional ISR cache key path (dotted loader-data path). `None` = no ISR.
    pub key_path: Option<String>,
    /// Optional ISR cache tags path (resolves to `string[]`).
    pub tags_path: Option<String>,
    /// Optional ISR revalidation interval in seconds (TTL).
    pub revalidate: Option<u32>,
```

- [ ] **Step 4: Copy the fields in `collect_components`**

In `collect_components` (`:218`), the `SsrComponent` arm currently destructures `{ component, instance, .. }` (`:220`) and pushes a `ComponentMeta`. Change the destructure and the push (`:220–233`):

```rust
        JsxNode::SsrComponent {
            component,
            instance,
            key_path,
            tags_path,
            revalidate,
            ..
        } => {
            // Don't recurse — nested SSR components render inside parent factory.
            out.push(ComponentMeta {
                component: component.clone(),
                instance: *instance,
                factory_expr: String::new(),
                referenced_components: Vec::new(),
                uses_island: false,
                key_path: key_path.clone(),
                tags_path: tags_path.clone(),
                revalidate: *revalidate,
            });
        }
```

- [ ] **Step 5: Emit the fields in `components_to_json`**

In `components_to_json` (`:293`), inside the per-entry loop, after the `usesIsland` append and before the closing `out.push('}')` (`:317–319`), add the conditional appends (mirroring `islands_to_json`, `:270–283`):

```rust
        out.push_str("],\"usesIsland\":");
        out.push_str(if c.uses_island { "true" } else { "false" });
        if let Some(kp) = &c.key_path {
            out.push_str(",\"keyPath\":\"");
            out.push_str(&json_escape(kp));
            out.push('"');
        }
        if let Some(tp) = &c.tags_path {
            out.push_str(",\"tagsPath\":\"");
            out.push_str(&json_escape(tp));
            out.push('"');
        }
        if let Some(r) = c.revalidate {
            out.push_str(",\"revalidate\":");
            out.push_str(&r.to_string());
        }
        out.push('}');
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p jsx-rust-compiler`
Expected: PASS — the 3 new tests pass; all prior tests (incl. any existing `components_to_json` golden) still pass.

- [ ] **Step 7: fmt + clippy + full workspace test**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets --locked -D warnings && cargo test --workspace`
Expected: clean clippy, all workspace tests pass (the compiler is consumed by `crates/brust` build-time — a `cargo test --workspace` confirms the field additions didn't break any downstream consumer).

- [ ] **Step 8: Commit**

```bash
git add crates/jsx-rust-compiler/src/lib.rs
git commit -m "feat(compiler): emit isr fields in components.json manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `resolveComponentContext` ISR fast-path + `NativeComponentEntry` fields

Add the ISR fields to the runtime manifest type and the cache get/set logic around the factory render. Logic mirrors `resolveIslandContext` (`native-render.ts:124`).

**Files:**
- Modify: `runtime/islands/native-render.ts` — `NativeComponentEntry` (`:217`), `resolveComponentContext` (`:254`)
- Modify: `runtime/islands/native-render.test.ts` — extend the `describe('resolveComponentContext')` block (`:394`)

- [ ] **Step 1: Write the failing unit tests**

Add these tests INSIDE the `describe('resolveComponentContext')` block in `runtime/islands/native-render.test.ts` (after the existing `degrades to empty string on factory throw` test, ~`:467`). They reuse the module-level `fakeCache()` helper (`:242`) and write a counting factory into a tmpdir:

```ts
  test('ISR miss renders once and writes cache (props is "")', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-'))
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(isrDir, 'IsrPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}
export const factories: Array<(ctx: any) => any> = [
  (ctx: any) => h('p', null, ctx.label),
]`,
    )
    writeFileSync(
      path.join(isrDir, 'IsrPage.components.json'),
      JSON.stringify([
        {
          component: 'Layout',
          instance: 0,
          sourcePath: '/x',
          keyPath: 'cacheKey',
          tagsPath: 'cacheTags',
          revalidate: 60,
        },
      ]),
    )
    const manifest = loadComponentManifest('IsrPage', isrDir)!
    const { cache, calls, store } = fakeCache()
    const data = { label: 'hi', cacheKey: 'layout:1', cacheTags: ['layout'] }
    const out = await resolveComponentContext(manifest, data, 'IsrPage', isrDir, cache)
    expect(calls.get).toBe(1)
    expect(calls.set).toBe(1)
    expect(out.comp_0_html).toContain('hi')
    // Invariant 5: components store props="" (no separate hydration attr).
    expect(store.get('layout:1')!.props).toBe('')
  })

  test('ISR hit skips the factory and serves cached html', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-hit-'))
    // Factory throws if ever called — proves a hit never invokes it.
    writeFileSync(
      path.join(isrDir, 'HitPage.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [
  () => { throw new Error('factory must not run on a hit') },
]`,
    )
    writeFileSync(
      path.join(isrDir, 'HitPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('HitPage', isrDir)!
    const { cache } = fakeCache()
    // Pre-seed the cache for the key.
    cache.set('layout:9', [], undefined, '<p>cached</p>', '')
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 'layout:9' },
      'HitPage',
      isrDir,
      cache,
    )
    expect(out.comp_0_html).toBe('<p>cached</p>')
  })

  test('ISR non-string key → uncached render, no cache write', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-badkey-'))
    const reactPath = require.resolve('react')
    writeFileSync(
      path.join(isrDir, 'BadKeyPage.factory.ts'),
      `import { createElement as h } from ${JSON.stringify(reactPath)}
export const factories: Array<(ctx: any) => any> = [(ctx: any) => h('p', null, 'x')]`,
    )
    writeFileSync(
      path.join(isrDir, 'BadKeyPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('BadKeyPage', isrDir)!
    const { cache, calls } = fakeCache()
    // cacheKey resolves to a number → non-string → uncached.
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 123 },
      'BadKeyPage',
      isrDir,
      cache,
    )
    expect(calls.set).toBe(0)
    expect(out.comp_0_html).toContain('x')
  })

  test('ISR factory throw after a miss → empty string, cache NOT poisoned', async () => {
    const isrDir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-throw-'))
    writeFileSync(
      path.join(isrDir, 'ThrowPage.factory.ts'),
      `export const factories: Array<(ctx: any) => any> = [() => { throw new Error('boom') }]`,
    )
    writeFileSync(
      path.join(isrDir, 'ThrowPage.components.json'),
      JSON.stringify([{ component: 'Layout', instance: 0, sourcePath: '/x', keyPath: 'cacheKey' }]),
    )
    const manifest = loadComponentManifest('ThrowPage', isrDir)!
    const { cache, calls } = fakeCache()
    const out = await resolveComponentContext(
      manifest,
      { cacheKey: 'layout:throw' },
      'ThrowPage',
      isrDir,
      cache,
    )
    expect(out.comp_0_html).toBe('')
    expect(calls.set).toBe(0) // throwing render must not write the cache
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/detoro/code/brust && bun test runtime/islands/native-render.test.ts 2>&1 | tail -20`
Expected: FAIL — `resolveComponentContext` ignores the 5th `cache` arg (no get/set calls), so `calls.get`/`calls.set` assertions fail and the hit test renders instead of serving cached.

- [ ] **Step 3: Add the ISR fields to `NativeComponentEntry`**

In `runtime/islands/native-render.ts`, `NativeComponentEntry` (`:217`):

```ts
export interface NativeComponentEntry {
  component: string
  instance: number
  sourcePath: string
  /** Dotted path into loader data yielding the ISR cache key (string). */
  keyPath?: string
  /** Dotted path into loader data yielding the ISR cache tags (string[]). */
  tagsPath?: string
  /** Revalidate window in SECONDS; converted to ttlMs on cache.set. */
  revalidate?: number
}
```

- [ ] **Step 4: Add the `cache` param + ISR fast-path to `resolveComponentContext`**

In `runtime/islands/native-render.ts`, change the signature (`:254`) to append `cache?: IslandCache`, and replace the `for` loop body (`:278–293`) with the ISR-aware version:

```ts
export async function resolveComponentContext(
  manifest: NativeComponentEntry[],
  data: unknown,
  templateName: string,
  jinjaDir?: string,
  cache?: IslandCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!manifest.length) return out

  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const factoryPath = path.resolve(dir, `${templateName}.factory.ts`)

  let factoryMod = factoryCache.get(factoryPath)
  if (factoryMod === undefined) {
    try {
      factoryMod = (await import(factoryPath)) as {
        factories: Array<(ctx: unknown) => unknown>
      }
    } catch {
      factoryMod = null
    }
    factoryCache.set(factoryPath, factoryMod)
  }

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i]!

    // ISR fast-path: resolve a string cache key out of loader data. A hit
    // serves the FROZEN html and skips the factory. A non-string-but-defined
    // key is a manifest bug — warn and fall through to an uncached render.
    let key: string | undefined
    if (cache && entry.keyPath) {
      const k = pathInto(data, entry.keyPath)
      if (typeof k === 'string') {
        key = k
        const hit = cache.get(key)
        if (hit) {
          out[`comp_${entry.instance}_html`] = hit.html
          continue
        }
      } else if (k !== undefined) {
        console.warn(
          `[brust] SSR component "${entry.component}" ISR keyPath "${entry.keyPath}" resolved to a non-string value; rendering uncached`,
        )
      }
    }

    try {
      if (!factoryMod?.factories?.[i]) {
        throw new Error(`factory[${i}] not found in ${factoryPath}`)
      }
      const node = factoryMod.factories[i]!(data)
      const html = renderToString(node as React.ReactNode)
      out[`comp_${entry.instance}_html`] = html
      // Write-through: SUCCESS path only (a throwing render must not poison the
      // cache). props is "" — components have no separate hydration props attr.
      if (cache && key) {
        let tags: string[] = []
        if (entry.tagsPath !== undefined) {
          const tagsValue = pathInto(data, entry.tagsPath)
          if (Array.isArray(tagsValue) && tagsValue.every((t) => typeof t === 'string')) {
            tags = tagsValue
          } else if (tagsValue !== undefined) {
            console.warn(
              `[brust] SSR component "${entry.component}" ISR tagsPath "${entry.tagsPath}" must resolve to a string[]; using no tags`,
            )
          }
        }
        const ttlMs = entry.revalidate !== undefined ? entry.revalidate * 1000 : undefined
        cache.set(key, tags, ttlMs, html, '')
      }
    } catch (e) {
      console.error(
        `[brust] SSR component "${entry.component}" renderToString failed; degrading to empty:`,
        e,
      )
      out[`comp_${entry.instance}_html`] = ''
    }
  }
  return out
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/detoro/code/brust && bun test runtime/islands/native-render.test.ts`
Expected: PASS — the 4 new ISR tests pass and all existing `resolveComponentContext` + `resolveIslandContext` tests still pass (the new param is optional, so the existing 3-arg calls are unaffected).

- [ ] **Step 6: Biome check**

Run: `cd /Users/detoro/code/brust && bunx biome check --write runtime/islands/native-render.ts runtime/islands/native-render.test.ts && bun run ci`
Expected: biome clean.

- [ ] **Step 7: Commit**

```bash
git add runtime/islands/native-render.ts runtime/islands/native-render.test.ts
git commit -m "feat(runtime): ISR cache get/set in resolveComponentContext

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire `islandCache` into the route's component-context call

`resolveComponentContext` now accepts a cache, but `routes.ts` doesn't pass it. Wire the existing `islandCache` singleton through.

**Files:**
- Modify: `runtime/routes.ts:626`

- [ ] **Step 1: Pass `islandCache` into the call**

In `runtime/routes.ts`, the native branch (~`:626`) currently reads:

```ts
              ? resolveComponentContext(compManifest, rt, flat.nativeTemplate)
```

Change it to pass `jinjaDir` (default `undefined`) and the existing `islandCache` singleton (defined at `:30`, already passed to `resolveIslandContext` at `:623`):

```ts
              ? resolveComponentContext(compManifest, rt, flat.nativeTemplate, undefined, islandCache)
```

- [ ] **Step 2: Typecheck + biome**

Run: `cd /Users/detoro/code/brust && bunx biome check --write runtime/routes.ts && bun run ci`
Expected: clean. (`IslandCache` is already imported at `routes.ts:19`; no new import.)

- [ ] **Step 3: Run the runtime suite**

Run: `cd /Users/detoro/code/brust && bun test runtime/`
Expected: PASS — no regression. (This wiring is covered end-to-end by Task 6.)

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(runtime): wire islandCache into resolveComponentContext call

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Integration test — render-once + invalidation against the REAL Rust cache

Prove the full runtime path against the real moka-backed cache via the `island_cache_*` NAPI (already built into `runtime/index.js`). In-process — no HTTP server, no port-race flake. Mirrors `runtime/islands/isr-cache.integration.test.ts`.

**Files:**
- Create: `runtime/islands/__fixtures__/CountingComp.tsx`
- Create: `runtime/islands/comp-isr-cache.integration.test.ts`

- [ ] **Step 1: Create the counting component fixture**

Create `runtime/islands/__fixtures__/CountingComp.tsx` — bumps the SHARED `renderCounter` (reused from the island fixture) on every render so the test can assert how many times the factory actually rendered:

```tsx
// Test fixture: an SSR component that bumps the shared renderCounter on every
// server render, so the component-ISR integration test can prove a cache HIT
// skipped the factory render. Reuses the island fixture's render-counter
// singleton (Bun module cache → same object across imports).
import { createElement } from 'react'
import { renderCounter } from './render-counter.ts'

export default ({ n }: { n: number }) => {
  renderCounter.count++
  return createElement('span', null, String(n))
}
```

- [ ] **Step 2: Write the integration test**

Create `runtime/islands/comp-isr-cache.integration.test.ts`. It writes a factory + components.json into a tmpdir (the factory imports `CountingComp` and `react` by absolute path — the established constraint for tmpdir factories, see `native-render.test.ts:409`), then drives `resolveComponentContext` against the real Rust cache:

```ts
// Component-ISR cache integration — exercises resolveComponentContext against
// the REAL Rust-backed NAPI cache (not a fake), proving:
//   1. two requests with the same key render the factory ONCE (second is a hit),
//   2. tag invalidation forces a re-render,
//   3. distinct keys cache independently.
//
// In-process (no HTTP server → no port-race flake; cf. memory
// native-island-integration-flake). Requires the built ./index.js addon; the
// four island_cache_* NAPI fns must exist (shared keyspace with islands).
import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as native from '../index.js'
import {
  type IslandCache,
  type NativeComponentEntry,
  loadComponentManifest,
  resolveComponentContext,
} from './native-render.ts'
import { renderCounter } from './__fixtures__/render-counter.ts'

const COUNTING_PATH = path.resolve(import.meta.dir, '__fixtures__/CountingComp.tsx')

// Real adapter, identical shape to the one routes.ts wires into the request path.
const cache: IslandCache = {
  get(key) {
    return (native as any).islandCacheGet?.(key) ?? null
  },
  set(key, tags, ttlMs, html, props) {
    ;(native as any).islandCacheSet?.(key, tags, ttlMs, html, props)
  },
}

let dir: string
let manifest: NativeComponentEntry[]

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-int-'))
  const reactPath = require.resolve('react')
  writeFileSync(
    path.join(dir, 'IsrComp.factory.ts'),
    `import { createElement as h } from ${JSON.stringify(reactPath)}
import CountingComp from ${JSON.stringify(COUNTING_PATH)}
export const factories: Array<(ctx: any) => any> = [
  (ctx: any) => h(CountingComp, { n: ctx.counter.n }),
]`,
  )
  writeFileSync(
    path.join(dir, 'IsrComp.components.json'),
    JSON.stringify([
      {
        component: 'CountingComp',
        instance: 0,
        sourcePath: COUNTING_PATH,
        keyPath: 'cacheKey',
        tagsPath: 'cacheTags',
      },
    ]),
  )
  manifest = loadComponentManifest('IsrComp', dir)!
})

beforeEach(() => {
  ;(native as any).islandCacheClear()
  renderCounter.count = 0
})

test('two requests with the same key render the factory once (real Rust cache hit)', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'layout:7', cacheTags: ['layout'] }

  const first = await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(1)
  expect(first.comp_0_html).toBe('<span>7</span>')

  // Same key, MUTATED live data — must serve the frozen html, not re-render.
  const second = await resolveComponentContext(
    manifest,
    { ...data, counter: { n: 999 } },
    'IsrComp',
    dir,
    cache,
  )
  expect(renderCounter.count).toBe(1) // no second render → cache hit
  expect(second.comp_0_html).toBe('<span>7</span>') // frozen, not <span>999</span>
})

test('tag invalidation forces a re-render on the next request', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'layout:7', cacheTags: ['layout'] }

  await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(1)

  ;(native as any).islandCacheInvalidate(undefined, ['layout'])

  await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(2) // invalidated → re-rendered
})

test('distinct keys cache independently', async () => {
  const mk = (n: number) => ({ counter: { n }, cacheKey: `layout:${n}`, cacheTags: ['layout'] })

  await resolveComponentContext(manifest, mk(1), 'IsrComp', dir, cache)
  await resolveComponentContext(manifest, mk(2), 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(2) // two distinct keys → two renders

  await resolveComponentContext(manifest, mk(1), 'IsrComp', dir, cache) // hit
  await resolveComponentContext(manifest, mk(2), 'IsrComp', dir, cache) // hit
  expect(renderCounter.count).toBe(2) // both served from cache
})
```

- [ ] **Step 2b: Sanity-check the addon exposes the cache NAPI**

Run: `cd /Users/detoro/code/brust && node -e "const n=require('./runtime/index.js'); console.log(typeof n.islandCacheGet, typeof n.islandCacheClear)"`
Expected: `function function`. If `undefined`, the addon predates the island ISR work — rebuild with `cd runtime && bun run build` (~40s) before proceeding. (Per baselines the island ISR integration test already passes, so this should print `function function`.)

- [ ] **Step 3: Run the integration test (separately)**

Run: `cd /Users/detoro/code/brust && bun test runtime/islands/comp-isr-cache.integration.test.ts`
Expected: PASS — all 3 tests. `renderCounter.count` proves render-once and re-render-on-invalidate against the REAL cache.

- [ ] **Step 4: Biome check**

Run: `cd /Users/detoro/code/brust && bunx biome check --write runtime/islands/comp-isr-cache.integration.test.ts runtime/islands/__fixtures__/CountingComp.tsx && bun run ci`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add runtime/islands/comp-isr-cache.integration.test.ts runtime/islands/__fixtures__/CountingComp.tsx
git commit -m "test(runtime): component-ISR integration — render-once + invalidate vs real Rust cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (Phase 6 owner re-runs these — do NOT trust per-task green)

```bash
cd /Users/detoro/code/brust
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -D warnings
cargo test --workspace
bun run ci
bun test runtime/
bun test tests/native-island-ssr.test.ts          # run separately
bun test tests/integration.test.ts                 # run separately
```

All must be green. The island ISR tests passing after Task 1 is the load-bearing proof the shared-helper refactor introduced no regression.

---

## BLOCKED fallbacks

- **Task 1 — island ISR tests fail after the refactor.** The extraction changed behavior. Most likely cause: the mandatory-`key` check moved (it must stay — `key_path.ok_or_else(err)?` replaces the old `if key_path.is_none()`), or an early-return path differs. Diff the helper against the original arm line-by-line; the only intended change is `err` becoming a parameter and `key` returning `String`. Do NOT proceed to Task 2 until the island tests are green.
- **Task 2 — an existing `SsrComponent` destructure fails to compile.** The spec's audit says all use `..`; if one doesn't, add the three fields to that arm (it's the Island-variant confusion — the failing site is the real exhaustive one). Fix the destructure, don't revert the IR change.
- **Task 4 — a hit test still renders.** The `continue` after the cache-hit `out[...]=hit.html` is missing or the `key` guard on write-through is wrong. Confirm the hit branch `continue`s before the `try`.
- **Task 6 — `islandCacheGet` is `undefined`.** The prebuilt addon lacks the NAPI (predates island ISR). Rebuild: `cd runtime && bun run build`. If it still fails, the island ISR work isn't actually on this branch — STOP and escalate (the whole feature assumes it is).
- **Task 6 — factory import fails in the tmpdir** (`factory[0] not found`). The factory's `react` or `CountingComp` import isn't absolute. Confirm both imports use `JSON.stringify(absolutePath)` — a bare `'react'` won't resolve from a tmpdir outside the project tree.
