# Dynamic template registry — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R1 (`docs/brust-requirements.md` upstream consumer) — per-tenant templates registered at runtime (`registerTemplate('shop/{id}/section/{id}@v{n}', jinjaSrc)`), compile-on-save custom sections.

## Goal

Let an application register, update, remove, and render minijinja templates **at runtime**, keyed by arbitrary string names, without touching the boot-time directory-loaded environment. The compile side already works (`compileJsx` via NAPI returns jinja source); this closes the load-into-env side.

## Non-goals

- **Route-level dynamic template selection** (a native route whose `native_template` is computed per request). Routes keep their boot-time template binding. Consumers render dynamic templates imperatively via `templates.render()` inside handlers/loaders.
- **Persistence.** Dynamic templates are in-memory, per-process. The app re-registers on boot (consumer stores compiled sources in its own DB).
- **Cross-process sync.** Registering in one process does not propagate to another (pairs with R9 cache-sync if the consumer needs it; out of scope here).
- **Template sandboxing/quota.** Names and source sizes are the app's responsibility beyond basic validation.

## High-level architecture

Two-tier environment in `crates/brust-core/src/template/jinja.rs`:

- **Boot env** (existing): `static ENV: RwLock<Option<Environment>>` — loaded from directory, whole-replaced on dev hot reload. Unchanged.
- **Dynamic env** (new): `static DYN_ENV: RwLock<Option<Environment<'static>>>` + `static DYN_SOURCES: RwLock<HashMap<String, String>>` as source of truth.
  - DYN_ENV is lazily initialized on first register with a **hardcoded copy of the `load_from` setup** (`UndefinedBehavior::Chainable` + `json_attr` filter) — it must NOT read config from the boot ENV (register may legally run before `load_from`; no boot-ordering dependency). Extract the env construction into a shared `fn base_env() -> Environment<'static>` used by both `load_from` and the dynamic tier so the two cannot drift.
  - `register_template(name, source)` → validate name, `add_template_owned` into DYN_ENV, then insert into DYN_SOURCES on success. minijinja 2.20 parses eagerly inside `add_template_owned` for owned inputs: `make_owned_template` (the parse) is evaluated **before** the map `replace` is called, and the `ok!` macro short-circuits out on parse failure — so a syntax error mutates nothing and the prior entry (if any) survives. Syntax errors are returned to JS as a thrown error.
  - Re-registering an existing name **replaces** it atomically inside `add_template_owned` (single map insert under our write lock). No remove-then-add — that would create a window where the template is missing.
  - `remove_dynamic_template(name)` → minijinja's `Environment::remove_template` returns `()`, so compute the bool from `DYN_SOURCES.remove(name).is_some()` (sources map is the source of truth), then call `remove_template` on the env.
  - `dynamic_template_names()` → keys of DYN_SOURCES (do not rely on `env.templates()` iteration).

**Render lookup order:** `render(name, data)` checks **dynamic env first**, then boot env. Dynamic wins on name collision (allows runtime override of a boot template; documented). `RenderError::UnknownTemplate` only when both miss. Boot-env hot reload (dev) does NOT touch the dynamic tier.

Both ENV and DYN_ENV are process-global in the NAPI addon → visible to all Bun worker isolates immediately (same model as the existing cache singletons).

## API surface

### Rust (`brust_core::template::jinja`)

```rust
pub fn register_template(name: &str, source: &str) -> Result<(), RegisterError>
pub fn remove_dynamic_template(name: &str) -> bool
pub fn dynamic_template_names() -> Vec<String>
pub fn has_template(name: &str) -> bool          // dynamic OR boot
// render(name, data) — existing fn, lookup order changes to dynamic-first
```

`RegisterError` variants: `EmptyName`, `Syntax(String)` (minijinja error display, includes line info).

Name validation: non-empty, ≤ 512 bytes, no NUL/control chars. `/`, `@`, `:`, `{`, `}` etc. are all allowed — consumer keys look like `shop/42/section/7@v3`.

### NAPI (`crates/brust/src/lib.rs`)

```rust
#[napi] fn napi_register_template(name: String, source: String) -> Result<()>  // Err(reason) on syntax/name error
#[napi] fn napi_remove_template(name: String) -> bool
#[napi] fn napi_list_dynamic_templates() -> Vec<String>
#[napi] fn napi_has_template(name: String) -> bool
#[napi] fn napi_render_template(name: String, data_json: String) -> Result<String>  // Err on unknown/render error
```

napi-rs camelCases these in JS: `napi_register_template` → `napiRegisterTemplate`, `napi_remove_template` → `napiRemoveTemplate`, `napi_list_dynamic_templates` → `napiListDynamicTemplates`, `napi_has_template` → `napiHasTemplate`, `napi_render_template` → `napiRenderTemplate`.

`napi_render_template` reuses `jinja::render` at the Rust level but returns the HTML as a NAPI string allocation — a different calling convention from the SAB fast-lane (`napi_render_jinja`). It is **not** for the request hot path; it is for handlers/loaders/studio tooling that need an HTML string in JS. Document this in the TS docstring.

### TypeScript (`runtime/templates.ts`, new)

```ts
export const templates = {
  register(name: string, jinjaSource: string): void   // throws Error with minijinja message on syntax error
  remove(name: string): boolean
  has(name: string): boolean
  list(): string[]                                     // dynamic names only
  render(name: string, data?: unknown): string         // throws on unknown template / render error
}
```

Exported from `brustjs` root (`runtime/index.ts`). `render` JSON-stringifies `data ?? {}`.

## File structure

- `crates/brust-core/src/template/jinja.rs` — dynamic tier + lookup-order change + unit tests
- `crates/brust/src/lib.rs` — 5 NAPI fns
- `runtime/templates.ts` — TS wrapper (new)
- `runtime/templates.test.ts` — TS tests against real addon (new)
- `runtime/index.ts` — export `templates`
- `runtime/index.d.ts` — regenerated by napi build
- `example/docs` — new docs page `dynamic-templates.md` (brief; API + per-tenant example + caveats)

## Behavior / concurrency invariants

1. Register/remove take the DYN_ENV write lock briefly; renders take read locks. No lock is held across both tiers simultaneously in a way that can deadlock (lookup: read DYN, drop, read ENV).
2. `register` is atomic from a renderer's perspective: a concurrent render sees either the old or the new template, never a partially-built env.
3. A failed `register` (syntax error) leaves prior state untouched (validate-then-commit: add into env first — minijinja parses eagerly on `add_template_owned`; only update DYN_SOURCES after success).
4. Dev hot reload (`load_from`) replaces only the boot tier; dynamic registrations survive.
5. `templates.render` never touches request/store context — it is a pure (name, data) → html function.
6. The boot-time native-route validation in `runtime/index.ts` (~line 258, warns when a `native: true` route's template name is missing) must consult **both tiers**: replace the `napiListNativeTemplates()` set check with `napiHasTemplate(name)` per expected name, so a template registered dynamically before `registerRoutes` does not warn falsely.

## Tests

Rust (`jinja.rs` unit tests):
- register → render round-trip with per-tenant style name (`shop/1/section/2@v1`)
- update replaces output
- remove → render returns UnknownTemplate; remove returns true/false correctly
- syntax error on register: returns Err, prior template (if any) still renders
- precedence: dynamic name shadowing a boot template wins; after remove, boot template visible again
- boot hot-reload (`load_from` twice) preserves dynamic registrations
- name validation: empty / control char rejected

TS (`runtime/templates.test.ts`, real addon — requires `bun run build:debug`):
- register + render + list + has + remove round-trip
- syntax error throws with message containing line info
- render unknown name throws

Integration: extend `tests/jinja-route.test.ts` or new small test — register a template via `templates.register` inside a handler, return `templates.render(...)` from an action/handler, assert HTTP body.

## Acceptance criteria

- All new Rust + TS tests green; full `cargo test -p brust-core` and `bun test` suites stay green.
- `bun run ci` (biome) green.
- `templates` exported from `brustjs` with types in regenerated `index.d.ts`.
- Docs page exists.

## Known limitations

- In-memory only; re-register on boot.
- Dynamic-first precedence means a misnamed registration can shadow a built page template — documented, considered a feature (runtime override).
- No streaming render of dynamic templates; `render` returns a full string (consistent with the native fast-lane which is single-chunk anyway).

## Open questions resolved at plan-time

- ~~Whether `add_template_owned` overwrites an existing name in minijinja 2.20~~ — RESOLVED at spec review: yes, single map insert; parse failure short-circuits before any mutation (verified against minijinja 2.20.0 `loader.rs` `insert_cow`/`make_owned_template`).
