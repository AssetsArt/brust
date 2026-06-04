# Native `.map()` + bare `x-for` → SSR adopt sugar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, strict sequence). Steps use checkbox (`- [ ]`).

**Goal:** A bare `x-for` flag on a `.map()` body element makes the compiler emit the native x-for SSR-adopt format (reconstructed `x-for` expr + `data-x-key` from React `key={t.id}` + auto-`x-bind-*`/`x-text` for map-binding attrs/text), reusing the just-merged native x-for SSR feature. Reactivity opt-in via a same-named behavior signal; a marked map with no backing signal stays static (runtime guard).

**Spec:** `docs/superpowers/specs/2026-06-04-map-xfor-sugar-design.md` (READ IT — 2 spec-review blockers resolved: key-capture via raw-AST pre-scan; bad-key as a unit test not a golden).

**Base commit:** `7a81c98` (branch `feat/native-xfor-ssr`, stacked on the native x-for SSR work).

**Tech Stack:** Rust (`crates/jsx-rust-compiler`, swc IR lowering), TS/Bun runtime (`runtime/native/runtime.ts`, happy-dom units), biome lint gate.

---

## Conventions (repo rules — READ first)
- **Rust gates:** `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings` · `cargo test --workspace --locked`.
- **napi rebuild MANDATORY after ANY Rust edit:** `cd runtime && bun run build` (stale `.node` silently serves old compiler output).
- **TS gates:** `bun run ci` (biome from ROOT, NOT tsc) · `bun run typecheck:treaty` · `bun test runtime/` (baseline **470**).
- Never `git add -A`. Stage explicit paths. Directive runtime is react-free.

---

## Load-bearing facts (verified, cite when implementing)
- `lower_call_as_map` (`lower.rs:2894`): `source = lower_expr(&member.obj, scope)` (`:2902`); `binding = arrow_binding(arrow)` (`:2916`); `body_expr = arrow_body_expr(arrow)` (raw `&SwcExpr`, `:2920`); `inner_scope.map_bindings.push(binding)` (`:2925`); `body = lower_map_body_expr(body_expr, &inner_scope)` (`:2928`); returns `JsxNode::Map { source, binding, body }`.
- `key` is dropped in `lower_attr` (`lower.rs:2345`) → MUST read it from the raw AST in Part A BEFORE `lower_map_body_expr`.
- Bare attr (no value) → `AttrValue::Empty` (`lower.rs:2399`); string attr → `AttrValue::Static`.
- `try_xfor_ssr` (`lower.rs:712`) matches only `("x-for", AttrValue::Static(_))` → a bare `x-for` (Empty) passes `lower_element` untouched (no double-processing).
- `lower_map_body_expr` (`lower.rs:2996`): `JSXElement` → `lower_element(el, scope, true)`; `Bin`(`&&`) / `Cond`(`?:`) → `JsxNode::Cond`; else `MapShapeNotSupported`.
- Reusable helpers: `transform_xfor_element` (`:784`, the INVERSE direction), `set_or_push_attr` (`:829`), `path_to_map_expr` (`crate::xfor`), `resolve_xfor_source` (added this branch), `emit_expr_path` (`emit_jinja.rs:274`), `strip_paren` (`:456`).
- `ErrorKind` (`lib.rs:516`) uses thiserror `#[error("…")]`. Add a new variant.
- Runtime `bindForAdopt` (`runtime/native/runtime.ts`): reads `read(instance, listPath)`; ALWAYS calls `installKeyedReconcile` whose effect wipes seeds when `arr=[]`. `resolveRaw` returns the SIGNAL OBJECT for a registered signal (truthy), `undefined` only when the path is truly absent.

---

## File Structure
```
crates/jsx-rust-compiler/src/lib.rs                         # + ErrorKind::MapXForFlag* variants        (edit)
crates/jsx-rust-compiler/src/lower.rs                       # pre-scan + post-transform + wire into map (edit)
crates/jsx-rust-compiler/tests/golden_emit_jinja.rs         # + map_xfor_sugar, map_no_xfor fixtures     (edit)
crates/jsx-rust-compiler/fixtures/map_xfor_sugar.{tsx,expected.jinja}                                    (new)
crates/jsx-rust-compiler/fixtures/map_no_xfor.{tsx,expected.jinja}                                       (new)
runtime/native/runtime.ts                                   # static-fallback guard in bindForAdopt      (edit)
runtime/native/runtime.test.ts                              # no-signal-static + with-signal-adopt units (edit)
```

---

## Spec → Task coverage
| Spec section | Task |
|---|---|
| §1 Part A pre-scan (key capture, bad-key/missing-key/non-array errors, conditional-body error) | Task 1 |
| §1 Part B post-transform (reconstruct x-for, data-x-key, inverse x-bind/x-text) | Task 1 |
| §2 runtime static-fallback guard | Task 2 |
| Tests: goldens (sugar + no-xfor regression) | Task 1 |
| Tests: compiler unit errors (bad-key/missing-key/non-array/conditional) | Task 1 |
| Tests: runtime no-signal-static + with-signal-adopt | Task 2 |
| §3 example dogfood (OPTIONAL) | Task 3 (optional) |

---

## Task 1 — Rust: `.map()` bare-`x-for` sugar (pre-scan + transform) + goldens + error units

**Files:** edit `lib.rs`, `lower.rs`, `golden_emit_jinja.rs`; create 4 fixture files.

- [ ] **Step 1: Add error variants** to `ErrorKind` (`lib.rs:516`, with the other `#[error]` variants):
```rust
    #[error("`.map()` with a bare `x-for` flag requires `key={{item.path}}` — a single member path on the map item; use the explicit `x-for=\"… by …\"` for other keys")]
    MapXForKeyRequired,
    #[error("`.map()` bare `x-for` flag requires a single JSX element body (no conditional/fragment); use the explicit `x-for` form")]
    MapXForBodyNotElement,
    #[error("`.map()` bare `x-for` flag requires the map source to be a loader array path")]
    MapXForSourceNotArray,
```

- [ ] **Step 2: Write the failing golden fixtures FIRST.**

`fixtures/map_xfor_sugar.tsx` (source `items` is a destructured loader array prop):
```tsx
export default function Grid({ items }: { items: { id: number; label: string; href: string }[] }) {
  return (
    <ul>
      {items.map((t) => (
        <a x-for key={t.id} href={t.href} className="tile">
          {t.label}
        </a>
      ))}
    </ul>
  )
}
```

`fixtures/map_no_xfor.tsx` (same `.map()` WITHOUT the flag → static regression):
```tsx
export default function Grid2({ items }: { items: { id: number; label: string; href: string }[] }) {
  return (
    <ul>
      {items.map((t) => (
        <a href={t.href} className="tile">
          {t.label}
        </a>
      ))}
    </ul>
  )
}
```

Add `"map_xfor_sugar"` and `"map_no_xfor"` to `FIXTURES` in `golden_emit_jinja.rs`. Create placeholder `.expected.jinja` (empty) and run the golden once to CAPTURE real output.

`map_no_xfor.expected.jinja` = the CURRENT static output (capture it, freeze — regression baseline). Expected shape:
```jinja
<ul>{% for t in items %}<a href="{{ (t.href) | e }}" class="tile">{{ (t.label) | e }}</a>{% endfor %}</ul>
```

`map_xfor_sugar.expected.jinja` — capture AFTER Step 4 from REAL emit (do not hand-guess attr order). TARGET shape (eyeball: reconstructed `x-for`, `data-x-key`, added `x-bind-href`, real `href`, `x-text`, value child):
```jinja
<ul>{% for t in items %}<a x-for="t in items by t.id" href="{{ (t.href) | e }}" class="tile" x-bind-href="t.href" data-x-key="{{ (t.id) | e }}" x-text="t.label">{{ (t.label) | e }}</a>{% endfor %}</ul>
```
> NOTE the attr order is whatever the emitter actually produces after the transform appends `x-bind-*`/`data-x-key`/`x-text` — capture it, don't guess. Confirm `map_no_xfor` is byte-identical to today BEFORE writing any sugar code (run the golden, it must pass for `map_no_xfor` and fail for `map_xfor_sugar`).

- [ ] **Step 3: Part A — raw-AST pre-scan helper** in `lower.rs`.

```rust
/// Pre-scan a `.map()` body for the bare `x-for` sugar flag + its `key`. Runs on
/// the RAW arrow body BEFORE `lower_map_body_expr` (because `lower_attr` drops
/// `key`). Returns Some(key_path) when a bare `x-for` + a valid `key={item.path}`
/// are present; None when there's no flag (normal static map); Err for an opt-in
/// that's malformed (the flag is an explicit author intent — surface mistakes).
fn scan_map_xfor_sugar(
    body_expr: &SwcExpr,
    binding: &str,
    inner_scope: &Scope,
) -> Result<Option<String>, LowerError> {
    let stripped = strip_paren(body_expr);
    let SwcExpr::JSXElement(el) = stripped else {
        // Not a single element: only an error IF a bare x-for hides in a branch.
        if raw_has_bare_xfor(stripped) {
            return Err(LowerError::at(stripped.span(), ErrorKind::MapXForBodyNotElement));
        }
        return Ok(None);
    };
    // find bare `x-for` (JSXAttr name x-for, value None) + `key`
    let mut has_flag = false;
    let mut key_expr: Option<&SwcExpr> = None;
    for a in &el.opening.attrs {
        let JSXAttrOrSpread::JSXAttr(attr) = a else { continue };
        let JSXAttrName::Ident(name) = &attr.name else { continue };
        match name.sym.as_ref() {
            "x-for" if attr.value.is_none() => has_flag = true,
            "key" => {
                if let Some(JSXAttrValue::JSXExprContainer(c)) = &attr.value
                    && let JSXExpr::Expr(e) = &c.expr
                {
                    key_expr = Some(e);
                }
            }
            _ => {}
        }
    }
    if !has_flag {
        return Ok(None);
    }
    // key must lower (in the map scope) to a member/binding rooted at `binding`
    let key = key_expr.ok_or_else(|| LowerError::at(el.span, ErrorKind::MapXForKeyRequired))?;
    let key_path = match lower_expr(key, inner_scope) {
        Ok(Expr::MapMember { root, path }) if root == binding => {
            let mut s = root;
            for seg in path { s.push('.'); s.push_str(&seg); }
            s
        }
        Ok(Expr::MapBinding(root)) if root == binding => root,
        _ => return Err(LowerError::at(el.span, ErrorKind::MapXForKeyRequired)),
    };
    Ok(Some(key_path))
}

/// Shallow check: does a non-element body branch carry a bare `x-for`? (so a flag
/// in a conditional map body errors instead of leaking a dead attr).
fn raw_has_bare_xfor(expr: &SwcExpr) -> bool {
    fn el_has(el: &swc_ecma_ast::JSXElement) -> bool {
        el.opening.attrs.iter().any(|a| matches!(a,
            JSXAttrOrSpread::JSXAttr(attr)
              if matches!(&attr.name, JSXAttrName::Ident(n) if n.sym.as_ref() == "x-for")
                 && attr.value.is_none()))
    }
    match strip_paren(expr) {
        SwcExpr::JSXElement(el) => el_has(el),
        SwcExpr::Bin(b) => raw_has_bare_xfor(b.right.as_ref()),
        SwcExpr::Cond(c) => raw_has_bare_xfor(c.cons.as_ref()) || raw_has_bare_xfor(c.alt.as_ref()),
        _ => false,
    }
}
```
> Adapt the swc AST type paths (`JSXAttrOrSpread`/`JSXAttrName`/`JSXAttrValue`/`JSXExpr`) to the file's existing imports — they're already used in `lower_attr`. Confirm `el.span`/`.span()` access.

- [ ] **Step 4: Part B — wire into `lower_call_as_map` + the post-lowering transform.**

In `lower_call_as_map`, AFTER `let body = lower_map_body_expr(...)?;` and BEFORE the `Ok(JsxNode::Map …)`:
```rust
    // Native `.map()` bare-`x-for` sugar: when the body element carries a bare
    // `x-for` flag, decorate it into the SSR-adopt format (reconstruct the x-for
    // expr, data-x-key from `key`, x-bind-*/x-text for map-binding attrs/text).
    let body = match scan_map_xfor_sugar(body_expr, &binding, &inner_scope)? {
        Some(key_path) => {
            // SSR adopt only over a real array source (opt-in → error, not fallback).
            if !matches!(&source, Expr::Field(_) | Expr::MemberAccess { .. }) {
                return Err(LowerError::at(call.span, ErrorKind::MapXForSourceNotArray));
            }
            apply_map_xfor_sugar(body, &binding, &source, &key_path)
        }
        None => body,
    };
    Ok(JsxNode::Map { source, binding, body: Box::new(body) })
```

`apply_map_xfor_sugar` (decorates the lowered body element):
```rust
/// Decorate a `.map()` body element with the x-for adopt directives. INVERSE of
/// `transform_xfor_element`: reads map-binding `Expr` attrs and adds `x-bind-*`,
/// reads a single map-binding `Expr` text child and adds `x-text`, reconstructs
/// the `x-for` string, adds `data-x-key`.
fn apply_map_xfor_sugar(body: JsxNode, binding: &str, source: &Expr, key_path: &str) -> JsxNode {
    let JsxNode::Element { tag, attrs, children } = body else { return body };
    let mut new_attrs: Vec<JsxAttr> = Vec::with_capacity(attrs.len() + 3);
    // 1. reconstruct x-for; replace the bare Empty flag.
    let xfor = format!("{binding} in {} by {key_path}", emit_expr_path(source));
    // 2. for each map-binding Expr attr, queue an x-bind-<name>; keep originals.
    let mut binds: Vec<JsxAttr> = Vec::new();
    for a in attrs {
        if a.name == "x-for" {
            new_attrs.push(JsxAttr { name: "x-for".into(), value: AttrValue::Static(xfor.clone()) });
            continue;
        }
        if let AttrValue::Expr(e) = &a.value
            && expr_roots_at(e, binding)
        {
            binds.push(JsxAttr {
                name: format!("x-bind-{}", a.name),
                value: AttrValue::Static(path_from_map_expr(e)),
            });
        }
        new_attrs.push(a);
    }
    for b in binds { set_or_push_attr(&mut new_attrs, b.name, b.value); }
    // 3. data-x-key
    if let Some(kexpr) = crate::xfor::path_to_map_expr(key_path, binding) {
        set_or_push_attr(&mut new_attrs, "data-x-key".into(), AttrValue::Expr(kexpr));
    }
    // 4. single map-binding Expr text child → x-text (keep the value child).
    if let [JsxNode::Expr(e)] = children.as_slice()
        && expr_roots_at(e, binding)
    {
        set_or_push_attr(&mut new_attrs, "x-text".into(), AttrValue::Static(path_from_map_expr(e)));
    }
    JsxNode::Element { tag, attrs: new_attrs, children }
}

/// True when an Expr is a MapBinding/MapMember rooted at `binding`.
fn expr_roots_at(e: &Expr, binding: &str) -> bool {
    matches!(e, Expr::MapBinding(r) | Expr::MapMember { root: r, .. } if r == binding)
}
/// `MapMember{t,[href]}` → "t.href"; `MapBinding(t)` → "t".
fn path_from_map_expr(e: &Expr) -> String {
    match e {
        Expr::MapMember { root, path } => {
            let mut s = root.clone();
            for seg in path { s.push('.'); s.push_str(seg); }
            s
        }
        Expr::MapBinding(r) => r.clone(),
        _ => String::new(),
    }
}
```
> The `apply_map_xfor_sugar` only touches the ROOT body element's direct attrs/children (matches the spec's "single element body"; nested descendants with map-binding attrs would need recursion — out of v1 scope, the typical map item is one element with direct attrs + a text child). If a realistic dogfood needs nested descendants, note it and extend recursively (mirroring `transform_xfor_element`'s recursion) — but only if Task 3 hits it.

- [ ] **Step 5: Capture & freeze `map_xfor_sugar.expected.jinja`** from real emit; confirm `map_no_xfor` byte-identical.

- [ ] **Step 6: Compiler UNIT tests** (`lower.rs` `#[cfg(test)]`, `compile_full(...).unwrap_err()` pattern — find an existing `unwrap_err` test ~`:4164`/`:5014` and mirror it). Assert the error KIND for:
  - bare `x-for` + ``key={`${t.a}-${t.b}`}`` (template string) → `MapXForKeyRequired`
  - bare `x-for` with NO `key` → `MapXForKeyRequired`
  - bare `x-for` over a non-array source (e.g. `filtered` behavior-name, not destructured) → `MapXForSourceNotArray`
  - bare `x-for` on a conditional map body (`{items.map((t) => t.ok && <a x-for key={t.id}/>)}`) → `MapXForBodyNotElement`

- [ ] **Step 7: Gates** — `cargo test --workspace --locked` (goldens + units green) · `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings`.

- [ ] **Step 8: REBUILD NAPI** — `cd runtime && bun run build`; then `bun test runtime/` (baseline 470 still green — no runtime change yet).

**BLOCKED fallback:** if `scan_map_xfor_sugar` can't `lower_expr` the key in `inner_scope` cleanly (e.g. the key expr shape isn't handled), the pivot is to parse the key as a dotted path string directly from the JSX member expression (mirror `crate::xfor::path_to_map_expr`'s string form) — extract `obj.prop` idents from the `SwcExpr::Member` without full lowering. Do NOT silently accept a non-member key.

**Commit:** `feat(compiler): .map() + bare x-for → SSR adopt sugar (reconstruct x-for + data-x-key + x-bind/x-text)`

---

## Task 2 — Runtime: static-fallback guard in `bindForAdopt`

**Files:** edit `runtime/native/runtime.ts`, `runtime/native/runtime.test.ts`.

- [ ] **Step 1: Write failing units** in `runtime.test.ts` (`describe('x-for SSR adopt')` neighborhood):
  - **no-signal static fallback:** parent with SSR `data-x-key` seeds + an instance/behavior that exposes NO `items` → after mount, the seed nodes are STILL present (identity unchanged) AND their text/attrs are NOT cleared (assert `textContent` of a seed's `x-text` child is the SSR value, not `''`).
  - **with-signal adopt (regression):** behavior exposes `items = signal([...])` → adopt + reconcile as today (covered, but assert the sugar-shaped markup `x-for="t in items by t.id"` adopts).

- [ ] **Step 2: Add the guard** in `bindForAdopt` (before deriving `template`/adopting seeds):
```ts
  // Static fallback: a sugar-marked (or hand-written) x-for whose list has NO
  // backing signal on the instance must NOT reconcile — installKeyedReconcile would
  // wipe the SSR seeds on its first (empty-list) tick. resolveRaw returns the signal
  // OBJECT for a registered signal (truthy); undefined only when truly absent.
  if (resolveRaw(instance, listPath) == null) {
    return // leave the SSR seed nodes exactly as rendered (fully static)
  }
```
Place it at the TOP of `bindForAdopt` (right after destructuring `expr`), before any `template`/`anchor`/seed work.

- [ ] **Step 3: Gates** — `bun run ci` (biome) · `bun test runtime/` (new units + baseline 470) · `bun run typecheck:treaty` (0). No napi rebuild (no Rust).

**BLOCKED fallback:** if `resolveRaw == null` is too coarse (a behavior legitimately exposes `items` as a plain array, not a signal — `resolveRaw` returns the array, truthy, fine; an EMPTY array `[]` is also truthy → proceeds → reconcile shows empty, which is correct). The only true-absent case is no property at all. If a test shows a plain-array case mis-handled, narrow to `=== undefined`.

**Commit:** `feat(runtime): bindForAdopt static fallback when x-for list has no backing signal`

---

## Task 3 (OPTIONAL) — Example dogfood

If a pokedex page has a genuinely-static `.map()` list of one element + a text/href (e.g. a footer link list, a type-tile grid) that would read cleanly with the flag, convert ONE to `<el x-for key={t.id} …>` to dogfood both modes (static now; reactive if a behavior is later added). Build + curl that the page still SSRs identically (the flag with no behavior = static fallback, same visible output). SKIP if no clean target — the feature is proven by Task 1/2 tests. Do NOT invent a contrived example.

**Commit (if done):** `feat(example): dogfood .map() x-for sugar on <page>`

---

## Phase 6 — Scrutinize + verify (orchestrator; NO release)
Re-run ALL baselines myself: cargo fmt/clippy(-D warnings)/test + goldens + error units · napi rebuild · biome · typecheck:treaty · `bun test runtime/` (470 + new) · native integration (`native-island{,-ssr} native-inline native-source-mode cli-build integration`, ports killed). Trace the sugar path on the real diff (`lower_call_as_map` → scan → transform → emit; `bindForAdopt` guard). If Task 3 wired: curl the page (static fallback) + browser (reactive if behavior added). **NO RELEASE.**

**Acceptance:** spec §Acceptance 1-5 (cargo green + sugar golden + no-xfor byte-identical + error units; biome+treaty+runtime 470; sugar emits reconstructed `{% for %}`+x-for+data-x-key+x-bind/x-text; static-fallback no-wipe; backward compat).

## Known risks
- **swc AST attr access in the pre-scan** — `JSXAttr.value.is_none()` for the bare flag; adapt type paths to existing imports.
- **Attr order in the golden** — freeze from REAL emit (transform appends), never guess.
- **Root-element-only transform** — v1 decorates the body root's direct attrs/text; nested descendants out of scope (note if Task 3 needs them).
- **napi staleness** — rebuild after the Rust task; re-run runtime check.
