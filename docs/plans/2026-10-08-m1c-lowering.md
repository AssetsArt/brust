# M1c — Lowering: template (minijinja), server job (`.server.ts`), client chunk (`.client.js`), dual-evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a complete `ComponentIR` (M1b-2) emit the three artifacts the design names — `<name>.jinja` rendered by Rust, `<name>.server.ts` (the precompute job), `<name>.client.js` (the react-free directive chunk that `packages/runtime-dom` mounts) — and prove with a dual-evaluation harness that the server first paint and the client's initial values agree (spec §6.3).

**Architecture:** `crates/brust-compiler/src/lower/` consumes only the IR (spec §9 rule — no `bun_ast`). **Amendment to spec §4.4:** the client backend prints JavaScript text from the IR (`RawExpr::to_js_in(JsCtx::Client)` from M1b-2 plus the captured source of opaque arrows); it does not build a `bun_ast` module, because `lower/` may not see Bun types. A new small crate `crates/brust-jinja` holds the minijinja filter set and the attribute-name table so the later server spec and this plan's test harness register exactly the same environment. The dual-evaluation harness is a Rust test that renders the jinja with minijinja and runs the server job + client chunk under `bun` in a subprocess.

**Tech Stack:** Rust, `minijinja = "2"` (in `brust-jinja` and as a dev-dependency of the compiler tests), `serde_json`, Bun 1.4.x for the harness subprocess, `packages/runtime-dom` (M1d) for the chunk's imports.

**Spec:** §4.4, §5, §6 (6.1–6.4), §7 (7.1–7.4), §11 (dual-evaluation, react-freedom, job purity), M1d `packages/runtime-dom/README.md` (the directive contract — the source of truth for every attribute this plan prints).

## Global Constraints

- `lower/` compiles with no `bun_*` import (enforced by the `--no-default-features` check from M1a §9 rule; add `lower` to that job's scope).
- Autoescape stays `None`; **every** dynamic text/attribute output is printed with `| e` (0.1.x XSS lesson, spec §6.1). The only `| safe` is the SSR island slot `{{ _ssr_<id> | safe }}`.
- Attribute values that carry JSON (`x-props`) use the `json_attr` filter, never `tojson`.
- Directive attribute names and value grammar exactly as `packages/runtime-dom/README.md` (M1d): `x-data`, `x-props`, `x-props-bind="member[:binding]"`, `x-text`, `x-show`, `x-if`, `x-bind-<attr>`, `x-on-<event>="member[:binding]"`, `x-model`, `x-for="item[, index] in source by keyFn"`, `x-ref`.
- The client chunk imports only `brust/runtime-dom` (specifier configurable for tests) and the component's `client_imports`; a test greps the output for `react`.
- Generated members are named exactly as M1b-2 numbered them (`_sN` slots, `_hN` handlers, `_pN` links, `_cN` client computeds for state-dependent painted values, `_kN` key functions, `_lN` list sources).
- Dual-evaluation equality is on **strings as painted**: numbers print the way JS `String(n)` prints them; the jinja side must match (register a `js_str` filter that formats floats like JS; integers print without `.0`).
- Commit trailer per the implementer's harness.

## Review Focus

1. **A `Slot` that is state-dependent and has siblings** (`<p>Total: {total}</p>`) must get a wrapper element for `x-text` (a `<span>`), while a lone slot child puts `x-text` on the parent — otherwise the runtime would overwrite "Total: ". Task 4 pins both shapes.
2. **`If` whose branch is not a single element** (`{open && <>a<b/></>}` or a text branch) must be wrapped in `<brust-if style="display:contents">` so `x-if` has one host — Task 4 pins it.
3. **Attribute escaping of quotes and `</`** in static strings and in `x-props` JSON (`item.name = 'a"b</script>'`) must produce valid HTML that re-parses to the same value — Task 1 pins the escaper, Task 7's harness renders it.
4. **A boolean attribute from a Server expression** (`disabled={!ok}`) must render presence/absence (`{% if %}disabled{% endif %}`), never `disabled="false"` — Task 3 pins it.
5. **A native child inlined twice in the same parent** (two `<Counter/>` instances) must get distinct `x-data` instances but the same chunk name, and two distinct link members `_p1`, `_p2` — Task 4 pins it.

---

## File structure

```
crates/brust-jinja/
├─ Cargo.toml                 depends on minijinja 2, serde_json
└─ src/lib.rs                 register(env): filters e (html escape), json_attr, js_str, str_slice, includes, starts_with, ends_with, join, keys, entries; attr_name(react: &str) -> &str table; escape_attr/escape_text
crates/brust-compiler/src/lower/
├─ mod.rs                     pub fn lower(ir, &LowerCtx) -> Artifacts { jinja: String, server_ts: Option<String>, client_js: Option<String> }
├─ server_expr.rs             to_jinja(&ServerExpr) -> String        (Task 2; sits next to RawExpr::to_js from M1b-2 — "one file, side by side": move to_js here or re-export)
├─ template.rs                Node -> jinja + directives                (Tasks 3–4)
├─ server.rs                  precompute job module                     (Task 5)
├─ client.rs                  directive chunk                           (Task 6)
└─ names.rs                   member numbering helpers (_cN, _kN, _lN)
crates/brust-compiler/tests/
├─ lower_template.rs lower_server.rs lower_client.rs dual_eval.rs
├─ harness/eval.ts            bun script: load server.ts + client.js, print JSON of seeds/initial member values
tests/fixtures/<case>/expected.jinja | expected.server.ts | expected.client.js
crates/brust-compiler-cli/src/main.rs   --emit template|server|client|all [--out <dir>] [--runtime-import <spec>]
```

Frozen interfaces:

```rust
// lower/mod.rs
pub struct LowerCtx<'a> { pub resolve: &'a dyn Fn(&str) -> Option<&'a ComponentIR> /* child id -> IR, from the ModuleCache */, pub runtime_import: &'a str /* default "brust/runtime-dom" */ }
pub struct Artifacts { pub jinja: String, pub server_ts: Option<String>, pub client_js: Option<String>, pub members: Vec<String> /* every member the chunk exports, for tests */ }
pub fn lower(ir: &ComponentIR, ctx: &LowerCtx) -> Result<Artifacts, Diagnostic>
// lower/server_expr.rs
pub fn to_jinja(e: &ServerExpr, ctx: JinjaCtx) -> String   // JinjaCtx { in_loop: Option<(item, index)>, props_prefix: Option<&str> }
// brust-jinja
pub fn register(env: &mut minijinja::Environment<'_>)
pub fn attr_name(react_name: &str) -> String
pub fn escape_text(s: &str) -> String; pub fn escape_attr(s: &str) -> String
```

---

### Task 1: `brust-jinja` crate — filters, attribute table, escapers

**Files:** `crates/brust-jinja/{Cargo.toml,src/lib.rs}`, workspace member; tests inline.

- Filters (names are the contract): `e` (escape `& < > " '` → entities), `json_attr` (serde_json compact + escape `& < > " '` so the value is safe inside a single- or double-quoted attribute; `</` is covered by `<` escaping), `js_str` (format a number like JS `String()`: integers without fraction, `NaN`, `Infinity`, shortest round-trip for floats via `ryu`? use `format!("{}", f)` and strip trailing `.0`), `str_slice(start, end?)` (JS `slice` semantics incl. negatives), `includes(x)` (string or list), `starts_with`, `ends_with`, `join(sep)`, `keys`, `entries` (list of `[k, v]`).
- `attr_name`: `className→class`, `htmlFor→for`, `tabIndex→tabindex`, `readOnly→readonly`, `maxLength→maxlength`, `autoComplete→autocomplete`, `autoFocus→autofocus`, `spellCheck→spellcheck`, `srcSet→srcset`, `crossOrigin→crossorigin`, `httpEquiv→http-equiv`, `acceptCharset→accept-charset`, `contentEditable→contenteditable`, `dateTime→datetime`, `encType→enctype`, `noValidate→novalidate`, `formAction→formaction`; `data-*`/`aria-*` unchanged; everything else lowercased.
- Boolean attributes list (shared with Task 3): `disabled checked selected readonly required hidden open multiple autofocus autoplay controls loop muted defer async novalidate`.
- Style objects: `style_obj_to_css(&[(String, ServerExpr-or-literal)])` for literal style objects: camelCase → kebab, numbers get `px` for the React unitless-exception list (`zIndex opacity flex flexGrow flexShrink fontWeight lineHeight order zoom`), others as-is.

Tests: escaping table (incl. `a"b</script>`), `json_attr` round trip through an HTML attribute (parse back with a 5-line attribute unquote), `js_str(1.0) == "1"`, `js_str(0.1+0.2) == "0.30000000000000004"`, attr_name table, style conversion.

Commit `feat(brust-jinja): minijinja filter set, attribute table, escapers`.

---

### Task 2: `to_jinja` — the server half of the dual printer

**Files:** `lower/server_expr.rs`; test `tests/dual_printer.rs` (table shared with `to_js`)

Rules, per `RawKind` the §6.2 table accepts:
- `Lit`: strings as `"…"` with jinja escaping, numbers via the JS-compatible literal, `true/false`, `null`→`none`, `undefined`→`none`.
- `Ident{Prop}` → the name (props are top-level context); `State` → the seed variable name; `LoopBinding` → the loop variable; `Local` (Server-placed derived) → `_dN` set earlier (Task 3 emits `{% set _dN = … %}` for Server derived values in declaration order).
- `Member` → `a.b`; `optional` → `(a.b if a else none)`; `Index{Lit}` → `a["k"]` / `a[0]`.
- `Unary`: `not x`, `-x`.
- `Binary`: `==`/`===` → `==`; `!=`/`!==` → `!=`; comparisons; `And`→`and`, `Or`→`or`, `Nullish` → `(a if a is not none else b)`; `Add` → `~` when either side is a string literal/template, else `+`; `Sub/Mul/Div/Rem` → `- * / %`.
- `Cond` → `(yes if test else no)`.
- `Template` → `"head" ~ (e) ~ "tail"` with each part `| js_str` when it is numeric? Unknown types → `~ (e | string)`; keep it simple: `~ e ~`.
- `Call` methods: `toUpperCase→upper`, `toLowerCase→lower`, `trim→trim`, `slice→str_slice(a,b)`, `startsWith→starts_with(x)`, `endsWith→ends_with(x)`, `includes→includes(x)`, `join→join(sep)`, `length` member → `| length`; `Object.keys(x)` → `x | keys`, `Object.entries(x)` → `x | entries`; `Array.from({length:N}).map(...)` is a `For` node, not an expression.
- Every painted output is wrapped by the **template** backend with `| e` (not here).

Table test: ≥ 25 rows of `(source expression, expected jinja, expected js)` asserting both printers; the same rows feed Task 7's harness to assert equal evaluation on sample data.

Commit `feat(lower): to_jinja printer side by side with to_js`.

---

### Task 3: Template backend — static structure

**Files:** `lower/template.rs`, `lower/mod.rs`, `lower/names.rs`; test `tests/lower_template.rs`; goldens `expected.jinja` for static-text, jsx-shapes, keyed-list (static parts)

Output shape (all on one line per element is fine; add `\n` after block tags for readability):
- Preamble: `{# brust v2 · <id> · do not edit #}` then Server derived values `{% set _dN = … %}` and state seeds `{% set <state> = … %}` (Server init → expression; Precomputed init → `_sK`).
- `Element`: `<tag attrs>children</tag>`; void elements (`img input br hr meta link area base col embed source track wbr`) without closing tag. `Static` attrs: `name="escaped"`; `Dynamic` with `Server` expr: boolean attr → `{% if (expr) %}name{% endif %}`, `style` object literal → CSS via Task 1, else `name="{{ (expr) | e }}"`; `Dynamic` with `Precomputed` → `name="{{ _sN | e }}"` (per-item → `_sN[loop.index0]`); `Event`/`Ref`/`Spread` are handled by Task 4 (Spread → `Diagnostic` already; print nothing).
- `Text` → escaped text; `Slot(Server)` → `{{ (expr) | e }}`; `Slot(Precomputed)` → `{{ _sN | e }}`.
- `If{cond: Server}` → `{% if (cond) %}…{% else %}…{% endif %}`; `If{cond: Precomputed}` → `{% if _sN %}`.
- `For{source, item, index, key, body}` → `{% for item in (source) %}…{% endfor %}` (index → `loop.index0` substituted for the index binding in the body's expressions via `JinjaCtx.in_loop`).
- `Fragment` → children concatenated; root fragment → wrapped `<brust-host style="display:contents">` (M1b-1 already warned).
- `Component` nodes: Task 4.

Tests assert exact jinja strings for the three goldens and the boolean-attribute rule (Review Focus 4).

Commit `feat(lower): template backend — static structure`.

---

### Task 4: Template backend — directives, host, children, islands

**Files:** `lower/template.rs` (extend); tests `tests/lower_template.rs` (extend); goldens for theme-toggle, product-card, parent-counter, keyed-list (full), controlled-input, react-child, fragment-root

Rules:
- **Host**: the root element (or the `brust-host` wrapper) gets `x-data="<id>"` when tier is `Native` or the component has child links; `x-props='{{ {"item": item, …} | json_attr }}'` when `client_props` is non-empty (minijinja dict literal of the prop names); `x-props-bind="_pN[:item]"` when this component is inlined as a linked child (passed in by the parent's inlining call).
- **State-dependent painted values** (`Precomputed{state_dependent:true}` or `Server` whose deps include state — the IR carries deps? If M1b-2 did not store deps on the node, recompute with `deps_of` here (allowed: pure IR)): a `Slot` → `x-text="_cN"` on the parent when it is the parent's only child, else wrap `<span x-text="_cN">{{ … }}</span>`; a `Dynamic` attr → also `x-bind-<attr>="_cN"`; `If` → `x-if="_cN"` on the single element of the then-branch (wrap non-single branches in `<brust-if style="display:contents">`); the `else` branch of a state-dependent `If` is a second element with `x-if="_cN_not"` (a client computed negation); `For` whose source is state-dependent → `x-for="item in _lN by _kN"` on the row element (wrap non-single bodies in `<brust-row style="display:contents">`); when the server renders zero rows emit `<!--x-for-->` before the row template rendered once with `hidden` as the M1d README requires. Each `_cN`/`_lN`/`_kN` is recorded in `Artifacts.members` for the client backend (shared numbering in `names.rs`).
- **Events**: `x-on-<event>="_hN"` or `="_hN:item"` (item_scoped) / `="name"` for `useCallback` handlers. **Refs**: `x-ref="name"`. **Controlled input pair** (`value={q}` + `onChange` setter of the same state, detected by M1b-1 as `Attr::Model`? If M1b-1 did not add it, detect here: `Dynamic{value, State q}` + `Event{change, handler whose body is setQ(e.target.value)}`) → `x-model="q"` replacing both.
- **Native/static child**: inline the child's lowered template (call `lower` recursively through `ctx.resolve(child_id)` with a `ChildInline { props: the parent's prop expressions, link: Option<(member, item_scoped)> }`): the child's template is printed with its prop identifiers substituted by the parent's expressions (`JinjaCtx.props_prefix` or a substitution map), its own seeds/derived `set`s renamed with a per-instance suffix (`_i1`) to avoid collisions (Review Focus 5), and its host attrs: `x-data="<childId>"`, `x-props` from the child's `client_props` evaluated with the parent's expressions, `x-props-bind="_pN"` when linked.
- **React child**: `{{ _ssr_<childId> | safe }}`; client-only island → `<brust-island data-brust-island="<childId>" data-props='{{ … | json_attr }}'></brust-island>`.

Commit `feat(lower): template backend — directives, host attributes, child inlining and islands`.

---

### Task 5: Server backend (`.server.ts`)

**Files:** `lower/server.rs`; test `tests/lower_server.rs`; goldens `expected.server.ts` for product-card, keyed-list (per-item), parent-counter (none expected → file absent)

Shape (spec §6.4):

```ts
// generated by brust v2 — precompute job for productCard_1a2b3c4d; pure function of its inputs
import { fmt } from './money'
export const inputs = ["item.price"] as const
export function precompute({ item }: any) {
  const qty = 1
  return { _s1: fmt(item.price), _s2: fmt(item.price * qty), _s3: items.map((i) => fmt(i.price)) }
}
```

- Imports: only those referenced by precomputed slots or seeds (resolve specifiers relative to the component's own location — keep them verbatim).
- Destructure only the prop roots the job reads; state seeds in declaration order; derived values that slots depend on are emitted as `const` lines before the return in dependency order (Server-placed derived values are re-printed with `to_js` — same expression, two printers).
- Per-item slots: `_sN: <source>.map((item, index) => <expr js>)`.
- Job purity lint (`tests/lower_server.rs`): the printed module must not contain any browser global or `req`/`request`/`cookies`/`headers` identifier (regex over the output on every fixture that has a job).

Commit `feat(lower): server backend — precompute job module`.

---

### Task 6: Client backend (`.client.js`)

**Files:** `lower/client.rs`; test `tests/lower_client.rs`; goldens `expected.client.js` for theme-toggle, product-card, parent-counter (parent and child), keyed-list, controlled-input

Shape (spec §7.1), printed from the IR:

```js
// generated by brust v2 — client chunk for productCard_1a2b3c4d
import { signal, computed, defineBehavior } from "brust/runtime-dom"
import { fmt } from "./money"
export default defineBehavior("productCard_1a2b3c4d", ({ el, props, effect, onCleanup, ref }) => {
  const qty = signal(1)
  const total = computed(() => fmt(props().item.price * qty()))   // state-dependent precomputed → _c1 alias below
  const _c1 = total
  const _h1 = () => qty.set(qty() + 1)
  return { qty, total, _c1, _h1 }
})
```

- State → `signal(<init js, client ctx>)`; derived (any that something client-side reads) → `computed`; state-dependent painted values → `_cN = computed(() => <js client ctx>)` (or an alias when it is exactly a derived name); handlers → `const _hN = <arrow js>` with setter calls rewritten (`setQty(x)` → `qty.set(x)`), state reads `qty` → `qty()`, props `item` → `props().item` (that is what `to_js_in(JsCtx::Client)` does — if an `Opaque` block body contains setter/state names, apply the same rewrite textually on identifier boundaries and note it as a known limitation); effects → `effect(() => …)`; layout effects the same (runtime treats them alike in M1); refs → `const r = ref("r")`; child links → `const _pN = computed(() => ({ n: count(), onReset: _h1 }))` or `(item) => ({ name: item.n })` for item-scoped; list sources → `const _lN = computed(() => <source js>)`; key fns → `const _kN = (item) => <key js>`; per-item state-dependent slots → `const _cN = (item, index) => …`.
- Return object lists every member in `Artifacts.members` order.
- React-freedom test greps for `react` in every generated chunk; a syntax check runs `bun build --no-bundle` on each golden in `tests/lower_client.rs` (skip when `bun` is not on PATH, with a printed warning).

Commit `feat(lower): client backend — directive chunk printed from the IR`.

---

### Task 7: Dual-evaluation harness, `brustc --emit template|server|client|all`, CI

**Files:** `tests/dual_eval.rs`, `tests/harness/eval.ts`, `crates/brust-compiler-cli/src/main.rs`, `.github/workflows/ci.yml` (bun on the rust job already; add `bun install` for runtime-dom before tests), `tests/fixtures/<case>/sample-props.json` for every fixture with state or jobs

Harness per fixture (`tests/dual_eval.rs`):
1. `lower` the IR; write `server.ts`/`client.js` to a temp dir next to a `money.ts` stub the fixture ships (`tests/fixtures/product-card/money.ts`), with `runtime_import` pointing at `packages/runtime-dom/src/index.ts` (absolute path).
2. Run `bun tests/harness/eval.ts <dir> <sample-props.json>`: it imports `server.ts` (if present) and calls `precompute(props)`; imports `client.js` with a shimmed `defineBehavior` that captures the factory, calls it with `{ el: fake, props: signal(props), effect: () => () => {}, onCleanup(){}, ref: () => ({current:null}) }` (import `signal` from the real runtime-dom), and prints JSON `{ slots: {...}, members: { _c1: String(value), … } }` reading each `_cN`/derived member once (computeds called, signals called).
3. Render the jinja with minijinja (`brust_jinja::register`) and context = sample props + `slots`; extract every `x-text="_cN"` element's text content and every `x-bind-<attr>="_cN"` attribute value with a small regex pass (the templates are our own output, regular enough), and assert they equal `members[_cN]` as strings (`js_str` formatting on the jinja side).
4. Also assert the rendered HTML parses as a single root (quick tag-balance check) and that `json_attr` round-trips (`x-props` value parsed back equals `client_props` subset of sample props).

CLI: `--emit template|server|client` print one artifact; `--emit all --out <dir>` writes `<id>.jinja`, `<id>.server.ts` (if any), `<id>.client.js` (if any) and prints the file list; `--runtime-import <spec>` overrides the import specifier.

CI: the `rust` job gains `bun install --frozen-lockfile` (root) before `cargo test` so the harness can import runtime-dom's deps (none at runtime, but `bun` needs the workspace manifest).

Commit `feat(brustc): --emit template|server|client|all and the dual-evaluation harness`.

---

## Inputs carried over from the M1b-2 review (lead, 2026-10-09)

Binding for this plan; each item names the task that owns it.

1. **Module-level locals.** `ComponentIR.client_module_locals: Vec<String>` (added by M1b-2 ruling B2) lists module-scope `function`/`const` declarations that a handler, effect, state init or client-placed value reaches, transitively. The client chunk (Task 6) prints those declarations, in source order, before the behavior factory; the precompute job (Task 5) prints the ones its slots reach. Their imports are already in `client_imports`.
2. **Precomputed slots that call body-local derived functions** (`_s1 = f(a)` where `f` is a derived arrow placed `ClientOnly` or `Server`): the job prints every derived local a slot's `js` reaches (walk `deps_of` on the slot, collect `Ident{Local}`), as `const f = <to_js>` lines before the slot. Task 5 pins it with one test.
3. **React islands inside a props-only list** (`items.map(i => <Island data={i}/>)`): the single `Ssr` job renders once per item; its output is an array aligned with the list, and the template indexes it with the loop index (`{{ _ssr_<id>[loop.index0] }}`). `JobDecl.per_item` (added in M1b-2 Task 3 for precompute slots) carries the loop binding for `Ssr` jobs too; Task 4 (islands) consumes it.
4. **Nested lists** produce nested arrays in precompute job output (`per_item` = innermost loop binding; outer index first). The jinja side indexes with `loop.index0` per level; the dual-evaluation harness (Task 6) adds one nested-list case.
5. **`ClientOnly` / `Block` / `Opaque` sources keep source-local names** (ledger F23): the chunk binds every prop by `PropDecl.local` and every state/derived by its declared name before any printed source runs.

## Self-review notes

- **Spec coverage:** §6.1 template shape incl. seeds, `| e`, `json_attr`, child inlining with per-instance renaming, island slot/placeholder → Tasks 3–4; §6.2 jinja printer → Task 2; §6.3 → Task 7; §6.4 → Task 5; §7.1 chunk shape, setter/state/props rewrites, `x-model` pair, per-item handlers → Tasks 4, 6; §7.2 attribute set → Task 4 (printed exactly per M1d README); §7.4 `_pN` computeds + `x-props-bind` → Tasks 4, 6; §11 dual-evaluation, react-freedom, job purity → Tasks 5–7; §4.4 amended (client backend prints text) — recorded in the spec by the lead before dispatch.
- **Type consistency:** `LowerCtx`, `Artifacts`, `to_jinja/JinjaCtx`, `attr_name/escape_*/register`, member prefixes `_s _h _p _c _k _l _d`, `ChildInline` consistent across tasks.
- **Review Focus → tests:** 1, 2, 5 → Task 4; 3 → Tasks 1 and 7; 4 → Task 3.
- **Soft spots:** rewriting identifiers inside `Opaque` arrow bodies textually (noted as limitation; the battery will count how often it bites); minijinja `~` vs `+` typing for `Add`; regex extraction in the harness relies on our own output format.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1c-lowering` | 1–7 | complex | Implementer (Complex) | `m1b2-placement-tier` merged AND `m1d-runtime-dom` merged | complex | all tests green with per-file counts (brust-jinja unit, dual_printer, lower_template, lower_server, lower_client, dual_eval, fixtures); clippy/fmt clean; `brustc tests/fixtures/product-card/input.tsx --emit all --out /tmp/pc` file list + the three files pasted; PR -> v2 CI green; lane HEAD sha. |
