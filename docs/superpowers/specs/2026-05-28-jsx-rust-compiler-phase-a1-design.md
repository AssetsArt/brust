# Spec — JSX→Rust compiler (Phase A1 MVP)

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent commit:** `b65d026` (workspace refactor)
**Status:** design, not implemented
**Skill chain:** Path A → Phase A1 (per handoff `/tmp/brust-handoff-2026-05-28-workspace-refactor-and-path-A-spikes.md`)

---

## 1. Goal

Land a working **JSX→Rust compiler** as a new workspace crate at `crates/jsx-rust-compiler/`. The compiler accepts a constrained subset of TypeScript JSX and emits Rust source that, when compiled, renders byte-equivalent HTML to React's `renderToStaticMarkup` for the same input.

This is **Phase A1 of Path A** — chosen because Spike B (hand-written Rust template) measured 3.6× RPS / 11× lower p99 vs the current React render path. Phase A1 proves the perf ceiling is reachable from machine-generated Rust, not just hand-written templates.

This pipeline run ships scaffolding + parser + emitter + tests for a tiny dialect. Loader integration (A2), islands bridge (A3), conditionals/fragments/custom components (A4) are explicit non-goals here.

## 2. Non-goals (explicit deferrals)

| Feature | Why deferred | Phase |
|---|---|---|
| Custom JSX components (`<Layout/>`, `<Counter/>`) | Needs component resolution / cross-file linking | A4 |
| Conditional rendering (`{cond ? <A/> : <B/>}`) | Needs control-flow lowering in emitter | A4 |
| Fragments (`<>…</>`) | Trivial but unused by Phase A1 fixtures; defer to keep grammar small | A4 |
| Template literals (`` `...${x}...` ``) | Needs a mini-expression-evaluator beyond ident+member | A4 |
| Nullish coalescing / arithmetic / function calls in `{expr}` | Same — expression-evaluator scope | A4 |
| TypeScript type-checking | We trust the upstream `tsc` in `bun run build`; emitter is type-erased | never |
| Loader/`data` prop wiring | Needs napi bridge to feed loader JSON into Rust render | A2 |
| Islands marker emission | Needs island registry + client-bundle handshake | A3 |
| Hot reload / dev-mode JS fallback | Needs the runtime to know when to use JS vs Rust path | A5+ |
| Source maps / pretty error messages | A5+ — current errors point at byte offset in input | A5+ |
| `async function` components, `Suspense`, hooks | These are React semantics; Rust render path is sync, single-shot | never |
| HelloWorld.tsx end-to-end | Depends on custom components + template literals | A4 |

The handoff line "Compile HelloWorld.tsx + Layout.tsx end-to-end" was optimistic; both files exercise features deferred to A4. Phase A1 ships **fresh fixtures inside the dialect**, not the existing example app's pages.

## 3. High-level architecture

```
crates/jsx-rust-compiler/
├── Cargo.toml             # workspace member, package = "jsx-rust-compiler"
├── src/
│   ├── lib.rs             # pub use compile, CompileError, EmitOptions
│   ├── lexer.rs           # token stream from .tsx source
│   ├── parser.rs          # tokens → AST (Component + JSX tree)
│   ├── ast.rs             # AST types
│   ├── emit.rs            # AST → Rust source string
│   ├── escape.rs          # html_escape, attr_escape — also used by runtime
│   └── bin/
│       └── jsx-rustc.rs   # CLI: read file, print emitted Rust to stdout
├── runtime/
│   └── src/lib.rs         # tiny module the EMITTED code depends on (re-exports escape fns)
├── fixtures/              # input .tsx + golden emitted .rs + golden expected .html
│   ├── static_hello.tsx
│   ├── static_hello.expected.rs
│   ├── static_hello.expected.html
│   ├── props_hello.tsx
│   ├── props_hello.expected.rs
│   ├── props_hello.expected.html
│   ├── list_nav.tsx
│   ├── list_nav.expected.rs
│   └── list_nav.expected.html
└── tests/
    ├── golden_emit.rs     # for each fixture: assert compile(input) == expected.rs
    └── golden_html.rs     # for each fixture: include emitted .rs, run render(), assert == expected.html
```

**Workspace integration**: add `crates/jsx-rust-compiler` as a workspace member. The brust cdylib in `crates/brust/` does NOT take a dependency on it — A1 is standalone tooling. Wiring happens in A2.

**No external parser dep.** Hand-rolled lexer + recursive-descent parser. Rationale:
- Phase A1 dialect is intentionally tiny (see §4).
- The prior session burned ~3 hours on `swc_core` 13 + `serde::__private` removal in serde 1.0.220+; the cleaner long-term option (swc_core ≥ 15) is unverified and reintroduces a 100+ MB dep tree for marginal A1 benefit.
- The dialect IS the design. Writing the grammar by hand forces precision about what's in and out.
- We can swap in swc at the A4 boundary when supporting unconstrained TS expressions becomes load-bearing.

## 4. JSX dialect (precise grammar)

EBNF-ish — `*` = zero-or-more, `?` = optional, lowercase = lexed tokens, UPPER = grammar rules.

```
TOP             := IMPORT* DEFAULT_EXPORT
IMPORT          := /* not supported in A1; error on any import */
DEFAULT_EXPORT  := "export" "default" "function" ident PROP_PATTERN BLOCK_RETURN
PROP_PATTERN    := "(" ")"                                  // zero-prop component
                 | "(" "{" prop_list "}" PROP_TYPE? ")"     // destructured
                 | "(" ident PROP_TYPE? ")"                 // named-binding component
PROP_TYPE       := ":" ident                                // ignored, type-erased
prop_list       := PROP_BINDING ( "," PROP_BINDING )* ","?
PROP_BINDING    := ident PROP_DEFAULT?                      // { name } | { name = "x" }
PROP_DEFAULT    := "=" LITERAL
BLOCK_RETURN    := "{" "return" "(" JSX_ELEMENT ")" ";"? "}"
                 | "{" "return" JSX_ELEMENT ";"? "}"

JSX_ELEMENT     := "<" lowercase_tag ATTR* ">" JSX_CHILD* "</" lowercase_tag ">"
                 | "<" lowercase_tag ATTR* "/>"
ATTR            := ident                                    // boolean: disabled
                 | ident "=" string_literal                  // class="x"
                 | ident "=" "{" EXPR "}"                    // href={item.href}
JSX_CHILD       := JSX_TEXT                                  // plain text up to "<" or "{"
                 | "{" EXPR "}"                              // text-position expression
                 | JSX_ELEMENT                               // nested HTML
                 | "{" MAP_EXPR "}"                          // .map iteration (text position only)

EXPR            := ident                                    // props.title? no — just ident
                 | ident "." ident ( "." ident )*           // member access: data.title, params.slug
                 | string_literal                            // {"x"}
                 | number_literal                            // {42}

MAP_EXPR        := IDENT_OR_MEMBER "." "map" "(" "(" ident ")" "=>" JSX_ELEMENT ")"
                 | IDENT_OR_MEMBER "." "map" "(" "(" ident "," ident ")" "=>" JSX_ELEMENT ")"
IDENT_OR_MEMBER := ident ( "." ident )*
```

### 4.1 Attribute renames

The lexer/parser preserves attribute names verbatim; the **emitter** applies these renames so emitted HTML matches React's output:

| JSX attribute | Emitted HTML attribute |
|---|---|
| `className` | `class` |
| `htmlFor` | `for` |
| `charSet` | `charset` |
| `tabIndex` | `tabindex` |
| `crossOrigin` | `crossorigin` |
| `readOnly` | `readonly` |
| `maxLength` | `maxlength` |
| `colSpan` | `colspan` |
| `rowSpan` | `rowspan` |
| `srcSet` | `srcset` |

Any other attribute is emitted as-is. The emitter rejects attribute names containing uppercase letters that are NOT in this table — caller has to lowercase them in source or add to the table. This is intentional: silent unknown-rename is a footgun.

### 4.2 Void elements

These tags are emitted self-closing (`<br/>`) per HTML5 + React behavior, regardless of whether the JSX used `<br/>` or `<br></br>`:

```
area, base, br, col, embed, hr, img, input, keygen,
link, meta, param, source, track, wbr
```

If a void element has children in source, compile fails with `VoidElementHasChildren`.

### 4.3 HTML escaping

- **JSX text**: `<`, `>`, `&`, `"`, `'` → `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#x27;` at compile time (we know it's static).
- **`{expr}` in text position**: emitted as `html_escape(&value)` at runtime — runtime fn escapes the same five chars.
- **String-literal attribute value**: escape `&`, `"`, `<`, `>` (React's set) at compile time, write raw.
- **`{expr}` attribute value**: emitted as `attr_escape(&value)` at runtime.
- **Number-literal attribute / text**: written as `value.to_string()` — no escape needed.

Two escape functions, both in `runtime/src/lib.rs`, both also used at compile time by the emitter to escape static strings (the emitter calls the same Rust fns at build time via inline `const fn` impl OR a duplicated compile-time impl — see §6).

### 4.4 Exactly what's NOT in the dialect (error cases)

These produce compile-time errors with the byte offset of the offending token:

- `import` statement → `ImportNotSupportedInA1`
- Custom component (uppercase tag, e.g. `<Layout>`) → `CustomComponentNotSupported`
- Fragment (`<>…</>`) → `FragmentNotSupported`
- Conditional in JSX (`{cond ? a : b}`) → `ConditionalNotSupported`
- Template literal (`` `...` ``) → `TemplateLiteralNotSupported`
- Function call in expression (`{foo()}`) → `CallExpressionNotSupported`
- Arithmetic / logical ops in expression (`{a + b}`, `{a ?? b}`) → `ComplexExpressionNotSupported`
- Spread attribute (`{...props}`) → `SpreadAttributeNotSupported`
- `key=` attribute is **silently dropped** — it's a React-internal hint with no HTML meaning. (React's `renderToStaticMarkup` does the same.)
- `ref=` attribute → `RefAttributeNotSupported` (compile error, not silent drop, because it might be load-bearing for behavior).
- `onClick=` and other `on*` handlers → `EventHandlerNotSupported` (server-rendered handlers are nonsense; islands handle these in A3).
- Anything `<Suspense>` → handled by `CustomComponentNotSupported`.

## 5. CLI surface

```
jsx-rustc <input.tsx>           # emit Rust source to stdout
jsx-rustc <input.tsx> -o <out>  # write to <out> instead
jsx-rustc <input.tsx> --check   # parse only, print "OK" or error, exit 0/1
```

Errors: written to stderr in the format `<path>:<line>:<col>: error: <message>` (1-indexed line/col). Exit 0 on success, non-zero on parse/emit errors. No `--json`, no `--source-map` in A1.

## 6. Emit target — string-builder Rust, no maud

Each compiled fixture produces a Rust module of this shape:

```rust
// === GENERATED by jsx-rust-compiler; do not edit. ===
use jsx_rust_runtime::{html_escape, attr_escape};

pub struct Props {
    pub title: String,
    pub items: Vec<NavItem>,  // type inferred as String when expr is ident; for .map iteration, the element type is named `<ident>Item` Pascal-cased
}

pub fn render(props: &Props, out: &mut String) {
    out.push_str("<div class=\"foo\"><h1>");
    html_escape(&props.title, out);
    out.push_str("</h1></div>");
}
```

### 6.1 Why string-builder, not maud

- We want **byte-equivalence** to React's `renderToStaticMarkup`. maud's output (attribute ordering, void-element self-closing form) is not guaranteed to match. String-builder lets us emit exactly the bytes React emits.
- maud is a procedural macro; failures surface as confusing rustc errors. With string-builder, the emitter's output is plain Rust we can read and golden-test.
- No external dep — `jsx_rust_runtime` is in this same workspace.

### 6.2 Props struct generation

For Phase A1, all referenced `props.<name>` paths produce one field of type:

| Use site | Inferred Rust type |
|---|---|
| `{props.x}` in JSX text or attribute | `pub x: String` |
| `{props.xs.map((item) => ...)}` | `pub xs: Vec<XsItem>` and a separate `pub struct XsItem { ... }` whose fields are inferred from `item.<name>` use sites inside the map body |
| `{props.flag}` in a bare attribute position (`disabled={props.flag}`) | NOT supported in A1 — boolean expression attrs → error `BooleanExprAttrNotSupported` |

If two paths conflict (e.g. `props.x` used as both String and as `.map` source) the compiler errors `PropTypeConflict`.

Member-access on a non-`props` ident → in A1 the only allowed non-`props` ident is the `.map` callback parameter (`(item) => …`). Any other ident in expression position → `UnresolvedIdent`.

### 6.3 Static text optimization

Adjacent static-text fragments are concatenated at compile time and emitted as a single `out.push_str("...")` call. The reserved capacity hint is the sum of static byte lengths (dynamic fields contribute 0). This is verified by the golden-emit fixture, NOT by runtime perf — A1 doesn't claim a perf number.

## 7. Compile-time interface (Rust lib)

```rust
// crates/jsx-rust-compiler/src/lib.rs
pub fn compile(source: &str) -> Result<String, CompileError>;

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("{path}:{line}:{col}: {kind}")]
    At { path: String, line: u32, col: u32, kind: ErrorKind },
}

#[derive(Debug)]
pub enum ErrorKind {
    UnexpectedToken(String),
    ImportNotSupportedInA1,
    CustomComponentNotSupported(String),
    FragmentNotSupported,
    ConditionalNotSupported,
    TemplateLiteralNotSupported,
    CallExpressionNotSupported,
    ComplexExpressionNotSupported,
    SpreadAttributeNotSupported,
    RefAttributeNotSupported,
    EventHandlerNotSupported(String),
    VoidElementHasChildren(String),
    BooleanExprAttrNotSupported,
    UnresolvedIdent(String),
    PropTypeConflict(String),
    UnknownAttributeRename(String),
}
```

The `path` field defaults to `"<stdin>"` when called from the library; the CLI sets it to the input file path.

The lib only consumes `&str`. File I/O happens in `bin/jsx-rustc.rs`.

## 8. Runtime crate

`crates/jsx-rust-compiler/runtime/Cargo.toml` — separate sub-crate named `jsx_rust_runtime`. Two pub fns:

```rust
pub fn html_escape(s: &str, out: &mut String);
pub fn attr_escape(s: &str, out: &mut String);
```

Both append-to-buffer style for zero-alloc. Implementations are byte-loop with branchless escape table. Test in this crate: byte-equivalence against React's escape rules for a fuzz set.

## 9. Tests

### 9.1 Unit tests (per file, `#[cfg(test)]`)

- `lexer.rs`: each token kind produced from a known input string
- `parser.rs`: representative AST for each grammar production + each error case from §4.4
- `emit.rs`: per-AST-node emit snippet
- `escape.rs`: known input → known escaped bytes (React parity for the 5 chars)

### 9.2 Integration test — golden emit (`tests/golden_emit.rs`)

For each fixture in `fixtures/*.tsx`:
1. Read input.
2. Call `compile()`.
3. Compare result to `<name>.expected.rs`. Use `pretty_assertions` for diff.

To update goldens: env var `UPDATE_GOLDEN=1` rewrites them. CI never sets this.

### 9.3 Integration test — byte-equivalent HTML (`tests/golden_html.rs`)

Each `<name>.expected.rs` is a real Rust file. The test file `tests/golden_html.rs` includes them via `include!()` (or `mod static_hello; mod props_hello; mod list_nav;` with the goldens placed in `tests/golden_html_modules/`), calls each module's `render()` with the test-defined `Props`, and asserts the output bytes equal `<name>.expected.html`.

The `.expected.html` files are captured ONCE from React's `renderToStaticMarkup`. The capture script (`scripts/capture-react-baselines.ts`) runs under Bun:

```ts
import { renderToStaticMarkup } from 'react-dom/server'
import StaticHello from '../crates/jsx-rust-compiler/fixtures/static_hello.tsx'
console.log(renderToStaticMarkup(StaticHello()))
```

Run once per fixture, redirect to `<name>.expected.html`. Commit the output. The Rust test compares bytes. If the fixture or React behavior changes, re-run capture. Commit message should note the recapture.

**Important**: the capture script is NOT run by CI — its output is committed. CI runs only the Rust test that compares emitted output to the committed golden.

### 9.4 Workspace tests

After A1 lands:
- `cargo test --workspace --lib` covers `jsx_rust_compiler::*`, `jsx_rust_runtime::*`, plus existing `brust::*`
- `cargo test -p jsx-rust-compiler` covers integration tests `tests/golden_*.rs`
- `bun test runtime/` is unchanged (still 189 passing — A1 doesn't touch the napi crate)
- `bun test tests/integration.test.ts` is unchanged (A1 doesn't wire into the server path)

Failing assertion: pipeline fails at Phase 6 if any of these regresses.

## 10. Fixtures (input + expected emit + expected HTML)

### 10.1 `static_hello.tsx`

```tsx
export default function StaticHello() {
  return (
    <div>
      <h1>Hello from compiled Rust</h1>
      <p>This page is statically generated.</p>
    </div>
  )
}
```

Expected emit:
```rust
use jsx_rust_runtime::{html_escape, attr_escape};

pub struct Props {}

pub fn render(_props: &Props, out: &mut String) {
    out.reserve(85);
    out.push_str("<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>");
}
```

Expected HTML (captured from React):
```
<div><h1>Hello from compiled Rust</h1><p>This page is statically generated.</p></div>
```

### 10.2 `props_hello.tsx`

```tsx
export default function PropsHello({ title, body }) {
  return (
    <article>
      <h1>{title}</h1>
      <p>{body}</p>
    </article>
  )
}
```

Expected emit:
```rust
use jsx_rust_runtime::{html_escape, attr_escape};

pub struct Props {
    pub title: String,
    pub body: String,
}

pub fn render(props: &Props, out: &mut String) {
    out.reserve(25);
    out.push_str("<article><h1>");
    html_escape(&props.title, out);
    out.push_str("</h1><p>");
    html_escape(&props.body, out);
    out.push_str("</p></article>");
}
```

Expected HTML (React with `{title: "Hi", body: "Body <hi> & co"}`):
```
<article><h1>Hi</h1><p>Body &lt;hi&gt; &amp; co</p></article>
```

The HTML test passes those exact props and compares.

### 10.3 `list_nav.tsx`

```tsx
export default function ListNav({ items }) {
  return (
    <nav>
      <ul>
        {items.map((item) => (
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

Expected emit:
```rust
use jsx_rust_runtime::{html_escape, attr_escape};

pub struct ItemsItem {
    pub href: String,
    pub label: String,
}

pub struct Props {
    pub items: Vec<ItemsItem>,
}

pub fn render(props: &Props, out: &mut String) {
    out.reserve(28);
    out.push_str("<nav><ul>");
    for item in &props.items {
        out.push_str("<li><a href=\"");
        attr_escape(&item.href, out);
        out.push_str("\">");
        html_escape(&item.label, out);
        out.push_str("</a></li>");
    }
    out.push_str("</ul></nav>");
}
```

Expected HTML (React with two items):
```
<nav><ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul></nav>
```

## 11. Acceptance criteria

1. `cargo build --workspace` succeeds on macOS-arm64 (developer machine). Linux not required for A1.
2. `cargo test -p jsx-rust-compiler` passes: unit tests in `src/*` + `tests/golden_emit.rs` + `tests/golden_html.rs`.
3. `cargo test --workspace --lib` passes (107 brust tests + new jsx-rust-compiler unit tests + jsx_rust_runtime tests).
4. `cargo test --workspace --lib --release` passes (catches debug-only-assert bugs — see lesson #6 from prior session).
5. `cargo run -p jsx-rust-compiler --bin jsx-rustc -- crates/jsx-rust-compiler/fixtures/static_hello.tsx` prints the same bytes as `fixtures/static_hello.expected.rs` (minus the leading comment line).
6. Each `.expected.html` file matches React's `renderToStaticMarkup` output for the same input — verified by running `scripts/capture-react-baselines.ts` once during plan execution, confirming the bytes, then committing.
7. `bun run build` + `bun test runtime/` still green — A1 doesn't touch the napi build.
8. The CLI rejects each error case in §4.4 with the correct error kind. One unit test per error case.

## 12. Known limitations (shipped state)

- Dialect is tiny. Real JSX needs A4 (custom components, conditionals, fragments, template literals).
- Type inference is positional and dumb: ident-in-text-position → `String`, ident-in-`.map`-source → `Vec<XsItem>`. Real type inference comes from upstream TS.
- No source maps. Errors point at offsets in the input file, not at the original `.tsx` line in dev tooling.
- No incremental compilation cache. Recompiles every file every time. Fine because A1 runs offline as a build step.
- Capture script for `.expected.html` is manual / committed. CI doesn't re-capture against React.
- No napi wiring. A1 is standalone tooling; A2 brings it into the request path.

## 13. Open questions — resolved at plan time

1. **Q**: Use maud, raw string-builder, or a `Display` impl?
   **A**: Raw string-builder. Byte-equivalence with React requires control of exact bytes; maud's attribute-ordering and void-element form is not guaranteed to match. (§6.1)
2. **Q**: What does the emitted Props look like — owned `String` or `&'a str`?
   **A**: Owned `String` for A1. A2's loader bridge will land JSON-deserialized data into Props; owned strings are the simpler interface across napi.
3. **Q**: Where do fixtures live — `crates/jsx-rust-compiler/fixtures/` or `tests/fixtures/`?
   **A**: `crates/jsx-rust-compiler/fixtures/`. They're load-bearing for the goldens, not throwaway test inputs.
4. **Q**: Does the runtime crate get its own workspace member or live inside `jsx-rust-compiler/runtime/`?
   **A**: Inside, as a Cargo *sub-package* (separate `Cargo.toml`, listed as a workspace member). Two crates total: `jsx-rust-compiler` and `jsx-rust-runtime`. Future emitted code in the brust render path depends only on `jsx_rust_runtime`, not the compiler.
5. **Q**: Should the parser produce friendly multi-line errors?
   **A**: No. One-line `path:line:col: kind` is enough for A1. A5+ adds carets + snippets.

## 14. Out-of-band lessons applied from prior sessions

- **Distribution shape, not just median** (writev post-mortem). A1 makes no perf claim, so this is dormant. Phase A2+ benchmarks must apply it.
- **BLOCKED fallback per risky task** (Sub-project M T7). Plan-time concern: the byte-equivalent HTML test (golden_html.rs) needs the emitted `.rs` to compile cleanly the first time. If `include!()` doesn't work for files outside `src/`, fall back to `mod static_hello; #[path = "...expected.rs"] …` per the included pattern in the std library docs.
- **Falsify before pivoting** (debug-mantra). If the golden HTML test fails for a fixture, the disproof step is "diff the bytes" before claiming "React emits something weird here" — the diff usually shows it's our emit that's off.

## 15. Out of scope, not deferred — never doing this in the compiler

- Rendering React state / hooks. Components with `useState` are clients; the server emits an island marker (Phase A3) and the React bundle hydrates.
- TypeScript-level safety. The compiler does NO type checking. `bun run build`'s `tsc` is the typing authority; we treat input as already-typed.
- Stylesheet / Tailwind. CSS resolution stays in the existing pipeline.

---

End of spec. Reviewer next.
