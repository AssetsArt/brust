# Implementation plan — `<BrustPage>` arbitrary `data-*` on `<html>`

Spec: `docs/superpowers/specs/2026-06-03-brustpage-html-data-attrs-design.md`

## Spec coverage table

| Spec section | Task |
|---|---|
| §1 IR field + all Document sites | Task A |
| §2 lowering (collect+validate data-*) | Task A |
| §3 emit on `<html>` | Task A |
| ErrorKind InvalidDataAttrName | Task A |
| Compiler golden + lower unit tests | Task A |
| §4 TS types + React mirror | Task B |
| Runtime render test | Task B |
| FRAMEWORK-GAPS update | Task B |

Task A is one implementer (Rust, all in jsx-rust-compiler). Task B is a second
implementer (TS) AFTER Task A lands + the napi addon is rebuilt.

---

## Task A — Rust compiler: IR + lower + emit + ErrorKind + tests

### A1. `crates/jsx-rust-compiler/src/ir.rs` — add field to `Document`
After the `head: Vec<HeadEntry>,` line in the `Document { … }` variant, add:
```rust
        /// `<html data-*>` — arbitrary data attributes in source order. Each
        /// value is a literal or loader member-path (escaped like lang/class).
        html_attrs: Vec<(String, HeadValue)>,
```

### A2. `crates/jsx-rust-compiler/src/lib.rs` — ErrorKind variant
In `enum ErrorKind` (near the other `BrustPage*` variants, ~line 614), add:
```rust
    #[error("`<BrustPage {0}=…>` is not a valid data-* attribute name (use lowercase letters, digits, hyphens, e.g. `data-mode`)")]
    InvalidDataAttrName(String),
```

### A3. `crates/jsx-rust-compiler/src/lower.rs` — `lower_brust_page`
1. Add the accumulator near the other `let mut …: Option<HeadValue>` decls (~line 744):
```rust
    let mut html_attrs: Vec<(String, crate::ir::HeadValue)> = Vec::new();
```
2. In the attr loop, AFTER the `if name == "head" { … continue; }` block (~line 768)
   and BEFORE the `let slot = match name.as_str() {` block (~line 772), insert:
```rust
        // `data-*` → arbitrary attribute on <html>. Same value grammar as the
        // scalar shell props (string literal or loader member-path).
        if name.starts_with("data-") {
            if !is_valid_data_attr_name(&name) {
                return Err(LowerError::at(jsx_attr.span, ErrorKind::InvalidDataAttrName(name)));
            }
            let value = parse_brust_page_head_value(jsx_attr, &name, scope)?;
            html_attrs.push((name, value));
            continue;
        }
```
3. Add the new field to the `JsxNode::Document { … }` constructor (~line 852):
```rust
        html_attrs,
```
4. Add two free functions near `lower_brust_page` (after it, before `parse_head_array`):
```rust
/// A `data-*` attribute name is valid iff it is `data-` followed by one or more
/// lowercase letters, digits, or hyphens. Uppercase is rejected (DOM lowercases
/// data attrs; a `data-Foo` literal wouldn't round-trip via `dataset`).
fn is_valid_data_attr_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("data-") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parse a `<BrustPage>` scalar/attr value into a `HeadValue`: a string literal
/// (`x="…"`) or a loader member-path (`x={data.y}`). Calls/arithmetic/spread/
/// non-path exprs are rejected as `BrustPageAttrMustBeStringLiteral`. Mirrors the
/// inline scalar-slot logic; used for `data-*` attrs.
fn parse_brust_page_head_value(
    jsx_attr: &swc_ecma_ast::JSXAttr,
    name: &str,
    scope: &Scope,
) -> Result<crate::ir::HeadValue, LowerError> {
    match &jsx_attr.value {
        Some(JSXAttrValue::Str(s)) => Ok(crate::ir::HeadValue::Literal(
            s.value.to_string_lossy().into_owned(),
        )),
        Some(JSXAttrValue::JSXExprContainer(c)) => {
            if let JSXExpr::Expr(e) = &c.expr {
                match lower_expr(e, scope) {
                    Ok(crate::ir::Expr::StaticText(s)) => Ok(crate::ir::HeadValue::Literal(s)),
                    Ok(ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. })) => {
                        Ok(crate::ir::HeadValue::Path(ex))
                    }
                    _ => Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
                    )),
                }
            } else {
                Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
                ))
            }
        }
        _ => Err(LowerError::at(
            jsx_attr.span,
            ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
        )),
    }
}
```
   (Confirm the `swc_ecma_ast::JSXAttr` path matches how the file refers to SWC
   types — if the file `use`s these unqualified, use the bare `JSXAttr`. Check
   the existing imports at the top of lower.rs and match them.)

   NOTE: leave the existing inline scalar-slot value parsing (~784-826) AS-IS —
   do not refactor it to use the helper (minimal diff; the existing block is
   covered by passing tests).

### A4. `crates/jsx-rust-compiler/src/emit_jinja.rs`
1. `Document` arm (~line 84): add `html_attrs,` to the destructure pattern.
2. After the `if let Some(c) = html_class { emit_head_attr(out, "class", c); }`
   block (~line 99) and BEFORE `out.push_str("><head>");`, add:
```rust
            for (name, hv) in html_attrs {
                emit_head_attr(out, name, hv);
            }
```
3. Two test constructors need the new field (else compile error):
   - `document_with` helper (~line 866): add `html_attrs: vec![],`
   - `document_description_path_emits_interpolated_content` (~line 911): add `html_attrs: vec![],`

### A5. Golden tests — `crates/jsx-rust-compiler/src/lib.rs` (test module)
Add (use `compile(src).unwrap()`; byte-exact). NOTE: the full document emit is
long — to keep assertions robust, assert the `<html …>` open tag via
`.starts_with(...)` AND that the body is intact, OR assert the full string. Use
`assert!(out.starts_with("<html lang=\"en\" data-mode=\"dark\">"), "{out}")` for
the html-open-tag checks (the rest of the shell is covered by existing tests):
```rust
    #[test]
    fn brustpage_html_data_attr_literal() {
        let src = r#"export default function P() {
  return <BrustPage data-mode="dark"><div>x</div></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(out.starts_with("<html lang=\"en\" data-mode=\"dark\">"), "{out}");
        assert!(out.ends_with("<body><div>x</div></body></html>"), "{out}");
    }

    #[test]
    fn brustpage_html_data_attr_dynamic() {
        let src = r#"export default function P({ mode }) {
  return <BrustPage data-theme={mode}><div>x</div></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(out.starts_with("<html lang=\"en\" data-theme=\"{{ (mode) | e }}\">"), "{out}");
    }

    #[test]
    fn brustpage_html_data_attrs_multiple_order() {
        let src = r#"export default function P() {
  return <BrustPage data-mode="dark" data-density="cozy"><div/></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(out.starts_with("<html lang=\"en\" data-mode=\"dark\" data-density=\"cozy\">"), "{out}");
    }

    #[test]
    fn brustpage_html_data_attr_after_class() {
        let src = r#"export default function P() {
  return <BrustPage className="dark" data-mode="dark"><div/></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(out.starts_with("<html lang=\"en\" class=\"dark\" data-mode=\"dark\">"), "{out}");
    }

    #[test]
    fn brustpage_html_data_attr_call_rejected() {
        let src = r#"export default function P() {
  return <BrustPage data-x={fn()}><div/></BrustPage>;
}"#;
        assert!(matches!(
            compile_with_path(src, "<t>").unwrap_err().kind,
            ErrorKind::BrustPageAttrMustBeStringLiteral(_)
        ));
    }

    #[test]
    fn brustpage_invalid_data_attr_name_rejected() {
        let src = r#"export default function P() {
  return <BrustPage data-Mode="x"><div/></BrustPage>;
}"#;
        assert!(matches!(
            compile_with_path(src, "<t>").unwrap_err().kind,
            ErrorKind::InvalidDataAttrName(_)
        ));
    }
```
   (Check whether the test module accesses `kind` via `compile_with_path(...).
   unwrap_err().kind` — confirm `CompileError` exposes `.kind`; existing
   error-path tests in lib.rs/lower.rs show the pattern. If `compile` doesn't
   surface `.kind`, use the same accessor the neighbouring reject tests use.)

### A6 — Verify Task A
```
cargo fmt --all
cargo test -p jsx-rust-compiler brustpage_ 2>&1 | tail -15        # 6 new pass
cargo test -p jsx-rust-compiler 2>&1 | tail -8                     # no regression
cargo clippy --workspace --all-targets --locked -- -D warnings 2>&1 | tail -5
```
THEN rebuild the napi addon (Rust changed — stale `.node` otherwise):
```
cd runtime && bun run build:debug 2>&1 | tail -3
```

**BLOCKED fallback:** if the SWC type path for `JSXAttr` in the helper signature
doesn't resolve, match the imports the file already uses (the params `c`/`e`/`s`
in the existing inline block prove the in-scope type names). Do not change the
inline block.

---

## Task B — TS types + React mirror + runtime render test

(Run only AFTER Task A landed and `runtime/*.node` rebuilt.)

### B1. `runtime/islands/brust-page.tsx`
- In `BrustPageProps` (after `children?: ReactNode`), add:
```ts
  /** Arbitrary `data-*` on `<html>` (e.g. `data-mode="dark"`). String literal
   *  or loader member-path on the native path. */
  [dataAttr: `data-${string}`]: string | undefined
```
- In `BrustPage(...)`, capture `...rest`, derive data attrs, spread onto `<html>`:
```ts
export function BrustPage({
  lang = 'en', className, bodyClassName, title, description, head, children, ...rest
}: BrustPageProps): ReactNode {
  const dataAttrs = Object.fromEntries(
    Object.entries(rest).filter(([k]) => k.startsWith('data-')),
  )
  return createElement(
    'html',
    { lang, className, ...dataAttrs },
    /* …existing head createElement… */,
    createElement('body', { className: bodyClassName }, children),
  )
}
```
  (Keep the existing head/body `createElement` calls verbatim; only the `<html>`
  props object gains `...dataAttrs` and the signature gains `...rest`.)

### B2. Runtime render test
Add a native fixture page that uses `<BrustPage>` with a data-* attr + a route +
an assertion. Check first whether a BrustPage-using native fixture already
exists under `tests/fixtures/app/` (grep `BrustPage`); if so, extend it, else add
`tests/fixtures/app/pages/NativeDataAttr.tsx`:
```tsx
import { BrustPage } from 'brustjs'
export default function NativeDataAttr({ mode }: { mode: string }) {
  return (
    <BrustPage title="data-attr" data-mode="dark" data-rev={mode}>
      <div className="x">ok</div>
    </BrustPage>
  )
}
```
Wire into `tests/fixtures/app/routes.tsx` (import + native route):
```tsx
  {
    path: '/_test/data-attr',
    Component: NativeDataAttr,
    native: true,
    loader: async () => ({ mode: 'r42' }),
  },
```
Append to `tests/jinja-route.test.ts`:
```ts
test('GET /_test/data-attr — BrustPage data-* lands on <html>', async () => {
  const res = await fetch(`${BASE_URL}/_test/data-attr`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<html lang="en" data-mode="dark" data-rev="r42">')
})
```

### B3 — Verify Task B
```
lsof -ti:3801 | xargs kill -9 2>/dev/null; bun test tests/jinja-route.test.ts 2>&1 | tail -20
bun run ci 2>&1 | tail -5
```
Expected: the new data-attr test passes + existing ones still green; biome clean.

### B4. `example/pokedex/FRAMEWORK-GAPS.md`
- The dark-mode entry ("`<BrustPage>` ตั้งได้แค่ html class … `data-*` ตามใจไม่ได้
  (ยังเปิด)"): note `data-*` on `<html>` is now ✅ supported (literal +
  member-path, escaped; lowercase-only names); FULL dark-mode toggle (cookie +
  toggle control) still deferred.
- Drop `data-*` from any open-items summary line.

---

## Final gate (orchestrator, Phase 6)
```
bun run ci
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd runtime && bun run build:debug && cd ..
bun test runtime/
bun test tests/jinja-route.test.ts
bun test tests/native-island.test.ts
bun test tests/native-island-ssr.test.ts
bun test tests/integration.test.ts
```
Plus smoke: compile a `<BrustPage data-mode="dark" data-x={d.y}>` fixture via
`target/debug/jsx-rustc` and eyeball the `<html …>` open tag (literal verbatim,
dynamic `{{ (d.y) | e }}`).
