# Native `x-for` SSR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, strict sequence, never parallel — Rust + runtime tasks conflict on file state). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a native `x-for` list render server-side (`{% for %}` seed, visible/navigable without JS), then have the client `x-for` runtime ADOPT those server-rendered keyed nodes and take over filtering/sorting reusing the DOM (no flash, no rebuild).

**Spec:** `docs/superpowers/specs/2026-06-04-native-xfor-ssr-design.md` (READ IT — full design + 3 resolved spec-review blockers).

**Base commit:** `b1fd8ed` (branch `feat/native-xfor-ssr`).

**Architecture (one name, two contexts):** the `x-for` source binds ONE name (e.g. `items`) that resolves: (a) server = a real loader array → compiler emits `{% for c in items %}…{% endfor %}`; (b) client = a behavior signal seeded to the same data → search calls `items.set(subset)`, the 0.1.28 keyed `x-for` reconciles. On first paint server list == client signal seed → adoption is a no-op reconcile (all reused).

**Tech Stack:** Rust (`crates/jsx-rust-compiler`, swc IR lowering + minijinja emit), TypeScript/Bun runtime (`runtime/native/runtime.ts`, happy-dom units), `brustjs/store` (`signal`/`computed`/`effect`), biome lint gate.

---

## Conventions (repo rules — READ before starting)

- **Rust gates** (mirror ci.yml): `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings` · `cargo build --workspace --locked` · `cargo test --workspace --locked`.
- **napi rebuild is MANDATORY after ANY Rust edit:** `cd runtime && bun run build` (rebuilds `runtime/*.node`). It's gitignored → never shows in `git status`; a stale `.node` silently serves OLD compiler output (memory: stale-napi-node-after-compiler-change). Every Rust task ends with this rebuild + a re-run of the dependent TS/integration check.
- **TS gates:** `bun run ci` (biome from repo ROOT — NOT `tsc`, it stack-overflows) · `bun run typecheck:treaty` (isolated tsc) · `bun test runtime/` (baseline **465 pass**).
- **Never `git add -A`** (sweeps untracked `tools/`). Stage explicit paths.
- **Directive runtime is react-free / dom-only** — never import react there.
- **Pokedex build/dev:** `bun run runtime/cli/index.ts build example/pokedex/index.ts` · `BRUST_PORT=39xxx bun run runtime/cli/index.ts dev example/pokedex/index.ts`.

---

## File Structure

```
crates/jsx-rust-compiler/src/lower.rs           # x-for detect + parse + Map-wrap transform              (edit)
crates/jsx-rust-compiler/src/xfor.rs            # NEW: x-for grammar parser + dotted-path→Expr helper    (new, or inline module in lower.rs)
crates/jsx-rust-compiler/tests/golden_emit_jinja.rs        # + xfor_ssr fixture in FIXTURES               (edit)
crates/jsx-rust-compiler/tests/fixtures/xfor_ssr.tsx       # native element w/ x-for + loader-array source (new)
crates/jsx-rust-compiler/tests/fixtures/xfor_ssr.expected.jinja                                            (new)
crates/jsx-rust-compiler/tests/fixtures/xfor_client_only.tsx   # x-for source NOT a loader path (regression)(new)
crates/jsx-rust-compiler/tests/fixtures/xfor_client_only.expected.jinja                                    (new)
runtime/native/runtime.ts                       # bindFor adopt rewrite + idempotency guard              (edit)
runtime/native/runtime.test.ts                  # adopt-identity + reactivity + reconcile + legacy units (edit)
example/pokedex/components/DexFilter.tsx        # re-arch: items prop + signal seeded + items.set        (rewrite)
example/pokedex/pages/BrowsePage.tsx            # <DexFilter native items={items} data={dexProps} />     (edit)
example/pokedex/lib/loaders.ts                  # browseLoader returns items array (+ keeps dexProps)    (edit)
example/pokedex/lib/types.ts                    # BrowseData + items: Card[]                             (edit, if typed)
```

---

## Spec → Task coverage

| Spec section | Task |
|---|---|
| §1 compiler: x-for → `{% for %}` + retained client attrs | Task 2 (uses Task 1 parser) |
| §1 NEW x-for source parser (B2) | Task 1 |
| §1 detection / backward-compat (Field=SSR; else passthrough, NEVER error) | Task 2 |
| §1 key attr — `data-x-key` single / `data-x-key-N` composite (B1, no NUL in markup) | Task 2 |
| §1 x-bind-* SSR emits REAL attr (progressive enhancement) | Task 2 |
| §2 runtime bindFor keyed-init adopt REWRITE (B4) | Task 3 |
| §3 DexFilter re-arch — items prop + seeded signal + items.set (B3) | Task 4 |
| Tests: compiler golden | Task 2 |
| Tests: runtime adopt identity / reactivity / reconcile / legacy | Task 3 |
| Tests: integration / browser smoke (curl SSR + img identity) | Phase 6 (orchestrator verify) |

---

## Task 1 — Rust: x-for grammar parser + dotted-path→Expr helper (pure, unit-tested)

**Why first:** Task 2 needs both helpers; isolating them as pure functions makes them unit-testable without the whole lowering pipeline. Mirrors runtime `parseFor` (`runtime/native/runtime.ts:140`).

**Files:**
- Create: `crates/jsx-rust-compiler/src/xfor.rs` (new module; add `mod xfor;` to `lib.rs`).
- Edit: `crates/jsx-rust-compiler/src/lib.rs` (declare module).

- [ ] **Step 1: Write failing unit tests** (in `xfor.rs` `#[cfg(test)] mod tests`).

Cover the grammar (mirror runtime `ITEM_RE`/`PATH_RE`):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_simple() {
        let p = parse_for("c in items by c.id").unwrap();
        assert_eq!(p.item_name, "c");
        assert_eq!(p.index_name, None);
        assert_eq!(p.source_name, "items");
        assert_eq!(p.key_paths, vec!["c.id".to_string()]);
    }
    #[test]
    fn parses_index_and_composite_key() {
        let p = parse_for("(c, i) in items by c.a, c.b").unwrap();
        assert_eq!(p.item_name, "c");
        assert_eq!(p.index_name.as_deref(), Some("i"));
        assert_eq!(p.key_paths, vec!["c.a".to_string(), "c.b".to_string()]);
    }
    #[test]
    fn no_by_clause_is_ok() {
        let p = parse_for("c in items").unwrap();
        assert!(p.key_paths.is_empty());
    }
    #[test]
    fn rejects_malformed() {
        assert!(parse_for("garbage").is_none());
        assert!(parse_for("c in a+b by c.id").is_none()); // source not a path
    }
    // dotted-path → Expr under a map binding
    #[test]
    fn path_to_expr_member() {
        let e = path_to_map_expr("c.detailHref", "c").unwrap();
        assert!(matches!(e, crate::ir::Expr::MapMember { root, path }
            if root == "c" && path == vec!["detailHref".to_string()]));
    }
    #[test]
    fn path_to_expr_bare_binding() {
        let e = path_to_map_expr("c", "c").unwrap();
        assert!(matches!(e, crate::ir::Expr::MapBinding(r) if r == "c"));
    }
    #[test]
    fn path_to_expr_rejects_foreign_root() {
        // root must be the item binding — anything else bails (caller falls back to passthrough)
        assert!(path_to_map_expr("other.x", "c").is_none());
    }
}
```

- [ ] **Step 2: Implement** `parse_for` + `path_to_map_expr`.

```rust
//! x-for grammar parser (compile-time mirror of the runtime `parseFor`,
//! runtime/native/runtime.ts). Used to decide SSR-vs-client x-for and to build
//! the `{% for %}` seed. Dotted paths only (matches runtime PATH_RE `[\w.]+`).

use crate::ir::Expr;

#[derive(Debug, Clone)]
pub struct ForExpr {
    pub item_name: String,
    pub index_name: Option<String>,
    pub source_name: String,
    pub key_paths: Vec<String>,
}

fn is_path(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}
fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// Parse `(item[, index]) in source [by k0, k1, …]`. Returns None on malformed
/// input (caller falls back to opaque passthrough — NEVER hard-errors).
pub fn parse_for(raw: &str) -> Option<ForExpr> {
    let trimmed = raw.trim();
    let (head, key_part) = match trimmed.find(" by ") {
        Some(i) => (&trimmed[..i], Some(trimmed[i + 4..].trim())),
        None => (trimmed, None),
    };
    let in_idx = head.find(" in ")?;
    let item_raw = head[..in_idx].trim();
    let source_name = head[in_idx + 4..].trim().to_string();
    if !is_path(&source_name) {
        return None;
    }
    // item: `(c, i)` or `c`
    let (item_name, index_name) = if let Some(inner) = item_raw.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        let mut parts = inner.split(',').map(str::trim);
        let item = parts.next()?.to_string();
        let idx = parts.next().map(str::to_string);
        if !is_ident(&item) || idx.as_deref().is_some_and(|s| !is_ident(s)) {
            return None;
        }
        (item, idx)
    } else {
        if !is_ident(item_raw) {
            return None;
        }
        (item_raw.to_string(), None)
    };
    let key_paths = match key_part {
        None => Vec::new(),
        Some(k) => {
            let paths: Vec<String> = k.split(',').map(|s| s.trim().to_string()).collect();
            if paths.is_empty() || paths.iter().any(|p| !is_path(p)) {
                return None;
            }
            paths
        }
    };
    Some(ForExpr { item_name, index_name, source_name, key_paths })
}

/// Parse a dotted path string (`c.detailHref`) into an Expr rooted at the map
/// binding `item`. Returns None if the path's root is NOT the binding (caller
/// then bails out of SSR — conservative: SSR only when all dynamic paths root at
/// the item).
pub fn path_to_map_expr(path: &str, item: &str) -> Option<Expr> {
    if !is_path(path) {
        return None;
    }
    let mut parts = path.split('.');
    let root = parts.next()?;
    if root != item {
        return None;
    }
    let rest: Vec<String> = parts.map(str::to_string).collect();
    if rest.is_empty() {
        Some(Expr::MapBinding(root.to_string()))
    } else {
        Some(Expr::MapMember { root: root.to_string(), path: rest })
    }
}
```

- [ ] **Step 3:** Add `mod xfor;` to `crates/jsx-rust-compiler/src/lib.rs` (with the other `mod` declarations).

- [ ] **Step 4: Gate** — `cargo test --workspace --locked` (new xfor tests green), `cargo fmt --all`, `cargo clippy --workspace --all-targets --locked -D warnings`. **No napi rebuild needed yet** (pure helper, not wired into emit).

**Commit:** `feat(compiler): x-for grammar parser + dotted-path→Expr helper`

---

## Task 2 — Rust: detect x-for at element-lowering, build SSR `{% for %}` Map (+ golden)

**Why:** This is the compiler change. When lowering a native element carrying `x-for` whose source resolves to a **loader prop (`Field`)**, wrap it in `JsxNode::Map` and transform the body so SSR renders per-item values + `data-x-key` + REAL bound attrs, while RETAINING the `x-*` Static attrs for client adopt. Source NOT a `Field` → unchanged passthrough (regression, NEVER error).

**Load-bearing facts (verified):**
- `JsxNode::Map { source: Expr, binding: String, body: Box<JsxNode> }` emits `{% for {binding} in {emit_expr_path(source)} %}{body}{% endfor %}` (`emit_jinja.rs:41`).
- `emit_attr` already emits `Expr::MapMember` in attr position as `{{ (c.x) | e }}` and an `Expr` text child as `{{ (c.x) | e }}` (proven by the `list_nav` golden). So NO emit change is needed — only IR construction.
- Element lowering produces `JsxNode::Element { tag, attrs: Vec<JsxAttr>, children }`; x-* attrs arrive as `AttrValue::Static(string)` (NOT parsed) — `lower_attr` (`lower.rs:2181`).
- Source resolution: `lower_expr` on the source ident → `Field` (destructured loader prop) vs `UnresolvedIdent`/`MapBinding` (`lower.rs:2982`).

**Files:**
- Edit: `crates/jsx-rust-compiler/src/lower.rs` (the element-lowering site that builds `JsxNode::Element` from a native element — find where attrs are assembled and the Element returned).
- Edit: `crates/jsx-rust-compiler/tests/golden_emit_jinja.rs` (add fixtures to `FIXTURES`).
- Create the 4 fixture files.

- [ ] **Step 1: Write failing golden fixtures FIRST.**

`tests/fixtures/xfor_ssr.tsx` (source resolves to a loader-array prop `items`):
```tsx
export default function Grid({ items }: { items: { id: number; num: string; detailHref: string }[] }) {
  return (
    <div>
      <a x-for="c in items by c.id" x-bind-href="c.detailHref">
        <span x-text="c.num" />
      </a>
    </div>
  )
}
```

`tests/fixtures/xfor_ssr.expected.jinja` — EXACT expected output (single line; mirror `list_nav` compaction). The `<a>` retains `x-for`/`x-bind-href`, gains real `href` + `data-x-key`; the `<span>` retains `x-text` + gains the interp child:
```jinja
<div>{% for c in items %}<a x-for="c in items by c.id" x-bind-href="c.detailHref" href="{{ (c.detailHref) | e }}" data-x-key="{{ (c.id) | e }}"><span x-text="c.num">{{ (c.num) | e }}</span></a>{% endfor %}</div>
```
> NOTE: attribute ORDER in the expected file must match the emitter's actual output. Generate the file by running the compiler once and EYEBALLING it against this shape (retained x-* present, real attr present, `data-x-key` present, interp child present), then freeze it. Do NOT hand-guess the order — capture the real emit.

`tests/fixtures/xfor_client_only.tsx` (source `filtered` is NOT a destructured prop → passthrough, regression):
```tsx
export default function Grid2({ data }: { data?: string }) {
  return (
    <section x-data="f" x-props={data}>
      <a x-for="c in filtered by c.id" x-bind-href="c.detailHref">
        <span x-text="c.num" />
      </a>
    </section>
  )
}
```
`tests/fixtures/xfor_client_only.expected.jinja` — UNCHANGED passthrough (today's behavior: x-for stays an opaque Static attr, NO `{% for %}`, NO `data-x-key`, NO real href):
```jinja
<section x-data="f" x-props="{{ (data) | e }}"><a x-for="c in filtered by c.id" x-bind-href="c.detailHref"><span x-text="c.num"></span></a></section>
```
> Verify the client-only expected against the CURRENT compiler output BEFORE writing any lowering code (it's the regression baseline — must stay byte-identical). Capture real output.

Add both fixture names to `FIXTURES` in `golden_emit_jinja.rs`.

- [ ] **Step 2: Run the golden test — confirm `xfor_client_only` PASSES (baseline) and `xfor_ssr` FAILS** (no transform yet). This proves the regression fixture is correct before you change lowering.

- [ ] **Step 3: Implement the transform in `lower.rs`.**

At the element-lowering site, AFTER the element's `attrs`/`children` are lowered into `JsxNode::Element`, add a post-step:

```rust
// Native x-for SSR seed: if this element carries an `x-for` whose source resolves
// to a loader array (Field), desugar into a `{% for %}` Map with per-item render +
// data-x-key + real bound attrs, RETAINING the x-* attrs for client adopt. Any
// resolution failure (source not a Field, foreign path root, malformed) falls back
// to the element AS-IS (today's opaque passthrough — NEVER error).
if let Some(map_node) = try_xfor_ssr(&element, scope) {
    return Ok(map_node);
}
Ok(element)
```

`try_xfor_ssr` (new fn in `lower.rs`, uses `crate::xfor`):
```rust
fn try_xfor_ssr(el: &JsxNode, scope: &Scope) -> Option<JsxNode> {
    let JsxNode::Element { tag, attrs, children } = el else { return None };
    // 1. find x-for Static attr
    let xfor_raw = attrs.iter().find_map(|a| match (&a.name[..], &a.value) {
        ("x-for", AttrValue::Static(s)) => Some(s.clone()),
        _ => None,
    })?;
    let f = crate::xfor::parse_for(&xfor_raw)?;
    // 2. SSR only when the source resolves to a destructured loader prop (Field).
    //    Anything else (UnresolvedIdent / MapBinding / named) → passthrough.
    if !scope.destructured.contains(&f.source_name) {
        return None;
    }
    let source = Expr::Field(f.source_name.clone());
    // 3. transform the element subtree under a map binding for f.item_name.
    //    Returns None if any x-bind/x-text/key path roots at a foreign ident
    //    (conservative: SSR requires all dynamic paths root at the item binding).
    let body = transform_xfor_body(el, &f)?;
    Some(JsxNode::Map { source, binding: f.item_name, body: Box::new(body) })
}
```

`transform_xfor_body` — recursively rewrite the Element subtree (root + descendants):
- For the ROOT element: append `data-x-key` attr(s) from `f.key_paths` (single → `data-x-key` = Expr; composite → `data-x-key-0..N`), each value = `path_to_map_expr(keypath, item)?` wrapped `AttrValue::Expr`.
- For EVERY element in the subtree:
  - keep ALL existing attrs verbatim (the `x-*` Static attrs included);
  - for each `x-bind-<attr>` Static attr with dotted-path value V: push a real `<attr>` attr with `AttrValue::Expr(path_to_map_expr(V, item)?)`;
  - for each `x-text` Static attr with dotted-path value V: append a child `JsxNode::Expr(path_to_map_expr(V, item)?)` (element must be non-void; the DexFilter targets — `span`/`div` — are non-void; `img` uses x-bind-* not x-text);
  - recurse into element children.
- Any `path_to_map_expr` returning None → propagate None (whole transform bails → passthrough). This keeps SSR conservative + backward-compatible.

> IMPLEMENTER NOTE: `x-bind-<attr>` → real attr name is the suffix after `x-bind-`. e.g. `x-bind-href` → `href`, `x-bind-src` → `src`, `x-bind-alt` → `alt`. Skip `x-bind-class`/`x-bind-style`/`x-bind-disabled` for SSR real-attr emission ONLY if they're not plain path values — but per spec the targets are href/src/alt (plain paths); emit a real attr for any `x-bind-<attr>` whose value `path_to_map_expr` accepts, else bail.

- [ ] **Step 4: Regenerate `xfor_ssr.expected.jinja` from REAL output** (capture the emitter's actual attr order), eyeball it matches the spec shape, freeze. Confirm `xfor_client_only` still byte-identical.

- [ ] **Step 5: Rust gates** — `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -D warnings`, `cargo test --workspace --locked` (goldens green).

- [ ] **Step 6: REBUILD NAPI** — `cd runtime && bun run build`. Then `bun test runtime/` (baseline 465 still green — no runtime change yet, just proving the addon rebuilt clean).

**BLOCKED fallback:** if the element-lowering site can't cleanly post-process (e.g. the Element is consumed/moved before a hook point), the pivot is to detect x-for EARLIER — right after `attrs` are lowered but before `JsxNode::Element` is constructed — and branch into `try_xfor_ssr` there, passing the assembled `tag/attrs/children`. Do NOT thread `&mut` through the whole lowering; clone the scope (mirrors `lower_call_as_map`'s scope-clone at `lower.rs:2780`).

**Commit:** `feat(compiler): native x-for SSR seed — {% for %} + data-x-key + real bound attrs`

---

## Task 3 — Runtime: `bindFor` adopt rewrite + idempotency guard (units)

**Why:** The server now emits N seed nodes carrying `data-x-key` + the `x-*` attrs. The runtime must ADOPT them (reuse identity, wire reactivity) instead of destroy-then-clone, and must NOT double-mount when `bindTree`'s parent loop visits every seed.

**Load-bearing facts (verified):**
- `bindTree` (`runtime/native/runtime.ts:125`) routes any element with `x-for` to `bindFor` and returns; the PARENT's `bindTree` snapshots `Array.from(el.children)` then visits each — so with N seeds each carrying `x-for`, `bindFor` would be invoked N times. **This is the multi-invoke trap the spec didn't address.**
- Current `bindFor` keyed branch (`:179-301`): inserts a comment anchor, `template = tplEl.cloneNode(true)`, **`tplEl.remove()`** (`:204`), then a reconcile `effect`. Key = `keyPaths.map(p => String(resolveRaw(probe, p))).join('\x00')` (`:265`).

- [ ] **Step 1: Write failing units** in `runtime/native/runtime.test.ts` (mirror existing `describe` + `setupDom` + fresh-import pattern):

```ts
describe('x-for SSR adopt', () => {
  test('adopts SSR data-x-key nodes — reuses node identity, no reclone', async () => {
    // parent with two pre-rendered seed <a data-x-key> nodes + x-for on each
    const win = setupDom(`<div x-data="adoptList" x-props='{"items":[{"id":1,"label":"a"},{"id":2,"label":"b"}]}'>
      <div id="grid">
        <a x-for="c in items by c.id" data-x-key="1"><span x-text="c.label">a</span></a>
        <a x-for="c in items by c.id" data-x-key="2"><span x-text="c.label">b</span></a>
      </div>
    </div>`)
    const before = Array.from(win.document.querySelectorAll('#grid > a')) as HTMLElement[]
    // register behavior whose `items` is a signal seeded from props.items
    // … start(win.document) …
    const after = Array.from(win.document.querySelectorAll('#grid > a')) as HTMLElement[]
    expect(after.length).toBe(2)
    expect(after[0]).toBe(before[0]) // SAME node object — adopted, not recreated
    expect(after[1]).toBe(before[1])
  })

  test('wires reactivity onto adopted node (changing item updates x-text)', async () => {
    // after adopt, items.set([{id:1,label:"A"}, …]) → adopted span textContent === "A"
  })

  test('later filter reconciles — removed key gone, kept key REUSED (identity)', async () => {
    // items.set([{id:2,label:"b"}]) → only the id=2 node remains, identity unchanged
  })

  test('no data-x-key seeds → clone-fresh legacy path unchanged (regression)', async () => {
    // single <a x-for> template, no data-x-key → today's behavior (clone per item)
  })

  test('idempotency: N seed nodes each carrying x-for → bindFor mounts ONCE', async () => {
    // assert the list isn't double-rendered (count stays N, no duplicate disposers)
  })
})
```

- [ ] **Step 2: Implement the adopt rewrite + guard** in `runtime/native/runtime.ts`.

Module-level guard:
```ts
// One x-for mount per (parent, listPath): the SSR seed renders N sibling nodes
// each carrying x-for, and bindTree's parent loop visits every one — without this
// guard, bindFor would mount the list N times.
const forMountGuard = new WeakMap<Node, Set<string>>()
```

In `bindFor`, FIRST (after `parseFor`, after resolving `parent`):
```ts
const mounted = forMountGuard.get(parent) ?? new Set<string>()
if (mounted.has(listPath)) return // already mounted by the first seed sibling
mounted.add(listPath)
forMountGuard.set(parent, mounted)
```

Then branch the keyed path on presence of SSR seeds. Detect seeds by scanning `parent` for `[data-x-key]` (single) or `[data-x-key-0]` (composite) children BEFORE the destroy-then-clone:
```ts
// keyed branch only:
const seeds = collectSeeds(parent, keyPaths) // HTMLElement[] in document order
if (seeds.length > 0) {
  // ---- ADOPT path (SSR-seeded) ----
  // 1. template for future creates: stripped clone of first seed (drop data-x-key*, x-for)
  const template = seeds[0].cloneNode(true) as HTMLElement
  template.removeAttribute('x-for')
  stripKeyAttrs(template)
  // 2. anchor AFTER the last seed (so future inserts land in order)
  const anchor = parent.ownerDocument!.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, seeds[seeds.length - 1].nextSibling)
  // 3. read the client list (signal seeded to the same data — same order)
  const list = read(instance, listPath)
  const arr = Array.isArray(list) ? list : []
  // 4. adopt each seed: ForEntry keyed by its data-x-key, itemSig seeded from the
  //    matching client item (by key), bind reactivity WITHOUT re-entering bindFor.
  let map = new Map<string, ForEntry>()
  for (const node of seeds) {
    const key = seedKey(node, keyPaths) // read data-x-key OR join data-x-key-* with '\x00'
    const idx = arr.findIndex((it) => itemKey(it, itemName, indexName, keyPaths) === key)
    const item = idx >= 0 ? arr[idx] : undefined
    const itemSig = signal(item)
    const idxSig = indexName ? signal(idx >= 0 ? idx : 0) : undefined
    const childScope: Instance = Object.create(instance)
    childScope[itemName] = itemSig
    if (indexName && idxSig) childScope[indexName] = idxSig
    const entryDisposers: Array<() => void> = []
    node.removeAttribute('x-for')          // prevent bindTree re-entry into bindFor
    bindAdoptedNode(node, childScope, entryDisposers) // bindAttrs(node)+recurse children
    map.set(key, { node, itemSig, idxSig, disposers: entryDisposers })
  }
  // 5. the reconcile effect (same 0.1.28 keyed logic) — first run finds every key
  //    already in `map` → all reused (no clone, no flash). Reuse the EXISTING keyed
  //    reconcile body, parameterized to start from the pre-populated `map`/`template`/`anchor`.
  installKeyedReconcile({ instance, listPath, itemName, indexName, keyPaths, parent, anchor, template, map, disposers })
  return
}
// ---- no seeds: existing destroy-then-clone keyed path (unchanged) ----
```

Helpers to add: `collectSeeds`, `stripKeyAttrs`, `seedKey` (single `data-x-key` OR join `data-x-key-*` in order with `'\x00'` — NUL only in JS, matching `:265`), `itemKey` (compute the client item's key the SAME way the reconcile does — `keyPaths.map(p => String(resolveRaw(probe, p))).join('\x00')`), `bindAdoptedNode` (= `bindAttrs(node, scope, disposers)` then recurse `node.children` via `bindTree`, NOT routing the node itself back through `x-for`).

> **REFACTOR FIRST (TDD refactor step):** extract the current keyed reconcile `effect` body into `installKeyedReconcile(opts)` taking an initial `map` (empty for the legacy path, pre-populated for adopt), `template`, `anchor`. Run `bun test runtime/` GREEN (465) after the pure refactor BEFORE adding adopt — proves the extraction is behavior-preserving.

Key-match invariant: `seedKey(node)` (from markup) MUST equal `itemKey(clientItem)` (from the signal data) for the same logical row. Both join with `'\x00'`; the SSR `{% for %}` order == the signal seed order (spec invariant) so even a positional fallback is correct.

- [ ] **Step 3: Gate** — `bun run ci` (biome), `bun test runtime/` (NEW adopt units green + baseline 465 still green), `bun run typecheck:treaty` (0). **No napi rebuild** (no Rust touched this task).

**BLOCKED fallback:** if extracting `installKeyedReconcile` proves too entangled with the closure-captured `template`/`anchor`, the pivot is to keep the reconcile inline and instead make the ADOPT path pre-seed the existing keyed branch: skip `tplEl.remove()`, pre-populate `map` from seeds, derive `template`/`anchor` from seeds, then fall through to the UNCHANGED effect. Document which path you took.

**Commit:** `feat(runtime): x-for adopts SSR data-x-key seeds (reuse identity) + mount guard`

---

## Task 4 — Example: DexFilter re-arch (items prop + seeded signal) + loader + curl proof

**Why:** The current showcase can't SSR (`filtered` is a behavior computed, `data` a JSON string). Re-arch per spec §3 so `/pokedex` paints 151 cards server-side.

**Files:**
- Rewrite: `example/pokedex/components/DexFilter.tsx`
- Edit: `example/pokedex/pages/BrowsePage.tsx`
- Edit: `example/pokedex/lib/loaders.ts`
- Edit: `example/pokedex/lib/types.ts` (if `BrowseData` is typed)

- [ ] **Step 1: Re-arch `DexFilter.tsx`.**
  - `default` signature destructures a REAL array prop: `DexFilter({ items, data }: { items?: Card[]; data?: string })`.
  - x-for binds the loader array: `x-for="c in items by c.id"` (was `c in filtered`).
  - `behavior` exposes `items` as a **signal seeded from props.items**, drops the `filtered` computed; search/sort call `items.set(subset)`:
    ```ts
    export const behavior = ({ props }) => {
      const all = ((props as { items?: Card[] })?.items ?? []) as Card[]
      const items = signal(all)            // seeded to SAME data as the SSR {% for %}
      const q = signal('')
      const sortAz = signal(false)
      const apply = () => {
        const needle = q().trim().toLowerCase()
        let out = needle ? all.filter((c) => c.name.includes(needle)) : all.slice()
        if (sortAz()) out = out.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        items.set(out)
      }
      const onInput = (e: Event) => { q.set((e.target as HTMLInputElement).value); apply() }
      const setDex = () => { sortAz.set(false); apply() }
      const setAz = () => { sortAz.set(true); apply() }
      const countLabel = computed(() => `${items().length} / ${all.length}`)
      return { items, q, sortAz, onInput, setDex, setAz, countLabel }
    }
    ```
  - Children keep `x-text="c.displayName"` / `x-bind-src="c.artwork"` / `x-bind-alt="c.displayName"` / `x-bind-href="c.detailHref"` (SSR renders values + real attrs; client re-binds on adopt).

- [ ] **Step 2: Loader + page wiring.**
  - `browseLoader` (`lib/loaders.ts`): return the `items` array (the member-path source for SSR) ALONGSIDE `dexProps` (the client x-props JSON, unchanged):
    ```ts
    return { ...chrome(req, 'Pokédex · Browse', 'Pokédex'), items, dexProps: JSON.stringify({ items }) }
    ```
  - `BrowseData` type (`lib/types.ts`): add `items: Card[]` (and import/define `Card`).
  - `BrowsePage.tsx`: `<DexFilter native items={items} data={dexProps} />` (pass BOTH; `items` = the SSR member-path array, `data` = the client JSON).

- [ ] **Step 3: Build + curl proof.**
  - `bun run runtime/cli/index.ts build example/pokedex/index.ts` (must succeed; native = compiled jinja).
  - `BRUST_PORT=39187 bun run runtime/cli/index.ts dev example/pokedex/index.ts &` then `curl -s localhost:39187/pokedex` → assert the response HTML contains **151** `<a … data-x-key="…"` cards with real `href="/pokemon/…"` + `<img … src="…">` + the number/name text (JS-disabled view). Capture the count + a sample card (NOT prose). Kill the port after.

- [ ] **Step 4: Gate** — `bun run ci` (biome) clean for the example files.

**BLOCKED fallback:** if `items={browseItems}` does NOT flow into the jinja `{% for c in items %}` context (native prop → jinja context wiring is the unverified seam), STOP and surface to the orchestrator — this is the spec's load-bearing assumption ("items = loader array member-path → SSR `{% for c in items %}`"). Do NOT silently fake it with a JSON re-parse. The orchestrator runs `debug-mantra` step 1 (repro the empty `{% for %}` at the command line) + advisor before pivoting.

**Commit:** `feat(example): DexFilter SSR-seeded x-for — items prop + seeded signal; /pokedex paints 151 cards server-side`

---

## Phase 6 — Scrutinize + verify (orchestrator; DO NOT RELEASE)

Re-run ALL baselines myself (not subagent-reported): `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings` · `cargo test --workspace --locked` · `cd runtime && bun run build` (napi) · `bun run ci` · `bun run typecheck:treaty` · `bun test runtime/` (465 + new) · native integration (`native-island native-island-ssr cli-build integration`, ports killed). Then trace the x-for SSR path end-to-end on the real diffs (`lower.rs`, `emit_jinja.rs` emit, `runtime.ts` bindFor), and the two browser proofs:
1. **No-JS:** `curl /pokedex` HTML has 151 `data-x-key` cards w/ real href/src/text (acceptance #4).
2. **Adopt:** browser (chrome-devtools MCP) — a surviving card's `<img>` element identity is unchanged from the SSR'd node THROUGH a filter keystroke (acceptance #5).

**Acceptance criteria** (spec §Acceptance): 1 cargo green + goldens + napi rebuilt · 2 biome + typecheck:treaty + runtime 465 · 3 native integration green · 4 curl SSR card list captured · 5 img-identity-through-keystroke · 6 backward compat (client-only x-for unchanged, `xfor_client_only` golden byte-identical).

**NO RELEASE this round** — stop after verify. User decides release later (next would be 0.1.30-alpha via the `release` skill).

---

## Known risks (carry into impl)

- **Native prop → jinja `{% for %}` context wiring** (Task 4) — the one unverified seam; `items={browseItems}` must land as the `items` context key the `{% for c in items %}` iterates. BLOCKED-fallback + advisor if it doesn't.
- **Attr emit order** (Task 2) — freeze goldens from REAL emit output, never hand-guess.
- **Multi-invoke guard** (Task 3) — the spec gap; guard keyed `(parent, listPath)`. A second different x-for with the same listPath in one parent would collide (documented; not a real case).
- **napi staleness** — rebuild after EVERY Rust task; re-run the dependent TS check to prove the addon picked up the change.
