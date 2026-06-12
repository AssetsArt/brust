# Dynamic template registry — implementation plan

Spec: `docs/superpowers/specs/2026-06-13-dynamic-template-registry-design.md`
Branch: `feat/dynamic-template-registry`

## Task 1 — Rust core: dynamic tier in jinja.rs (TDD)

File: `crates/brust-core/src/template/jinja.rs`

1. Extract shared env construction (used by `load_from` and the dynamic tier — keeps filters/undefined-behavior from drifting):

```rust
/// Shared construction for both the boot env (`load_from`) and the dynamic
/// tier — single source of truth for filters + undefined behavior.
fn base_env() -> Environment<'static> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.add_filter("json_attr", json_attr);
    env
}
```

Replace the first three lines of `load_from`'s body with `let mut env = base_env();`.

2. Add the dynamic tier statics after `ENV`:

```rust
// Dynamic tier — templates registered at runtime (per-tenant sections etc.).
// Source of truth is DYN_SOURCES; DYN_ENV mirrors it. Lazily initialized with
// base_env() — deliberately NOT copied from ENV (register may legally run
// before load_from; no boot-ordering dependency). Dev hot reload replaces ENV
// only; dynamic registrations survive.
static DYN_ENV: RwLock<Option<Environment<'static>>> = RwLock::new(None);
static DYN_SOURCES: RwLock<Option<std::collections::HashMap<String, String>>> =
    RwLock::new(None);
```

3. Public API:

```rust
#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    #[error("template name must be non-empty")]
    EmptyName,
    #[error("template name too long (max 512 bytes)")]
    NameTooLong,
    #[error("template name contains control characters")]
    NameControlChar,
    #[error("template syntax: {0}")]
    Syntax(String),
}

/// Register (or replace) a runtime template. minijinja parses eagerly inside
/// add_template_owned for owned inputs — on a syntax error nothing is mutated
/// and any prior registration under `name` survives.
pub fn register_template(name: &str, source: &str) -> Result<(), RegisterError> {
    if name.is_empty() { return Err(RegisterError::EmptyName); }
    if name.len() > 512 { return Err(RegisterError::NameTooLong); }
    if name.chars().any(|c| c.is_control()) { return Err(RegisterError::NameControlChar); }

    let mut env_guard = DYN_ENV.write();
    let env = env_guard.get_or_insert_with(base_env);
    env.add_template_owned(name.to_string(), source.to_string())
        .map_err(|e| RegisterError::Syntax(e.to_string()))?;
    DYN_SOURCES
        .write()
        .get_or_insert_with(Default::default)
        .insert(name.to_string(), source.to_string());
    Ok(())
}

/// Remove a runtime-registered template. Returns whether it existed.
/// minijinja's remove_template returns (), so existence comes from DYN_SOURCES.
pub fn remove_dynamic_template(name: &str) -> bool {
    let existed = DYN_SOURCES
        .write()
        .as_mut()
        .is_some_and(|m| m.remove(name).is_some());
    if existed && let Some(env) = DYN_ENV.write().as_mut() {
        env.remove_template(name);
    }
    existed
}

/// Names of runtime-registered templates (dynamic tier only).
pub fn dynamic_template_names() -> Vec<String> {
    DYN_SOURCES
        .read()
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// True when `name` resolves in either tier (dynamic first, then boot).
pub fn has_template(name: &str) -> bool {
    if DYN_SOURCES.read().as_ref().is_some_and(|m| m.contains_key(name)) {
        return true;
    }
    ENV.read()
        .as_ref()
        .is_some_and(|env| env.get_template(name).is_ok())
}
```

NOTE: lock discipline — `register_template` takes DYN_ENV.write then DYN_SOURCES.write (nested is fine: these two locks are only ever taken in this order; `remove_dynamic_template` takes DYN_SOURCES.write then DYN_ENV.write — REORDER remove to take DYN_ENV first then DYN_SOURCES to keep a single global lock order (DYN_ENV → DYN_SOURCES) and rule out deadlock:

```rust
pub fn remove_dynamic_template(name: &str) -> bool {
    let mut env_guard = DYN_ENV.write();
    let existed = DYN_SOURCES
        .write()
        .as_mut()
        .is_some_and(|m| m.remove(name).is_some());
    if existed && let Some(env) = env_guard.as_mut() {
        env.remove_template(name);
    }
    existed
}
```

(`has_template`/`dynamic_template_names` take single read locks; `render` below takes DYN locks and drops them before touching ENV.)

4. Render lookup order — dynamic first, then boot. Rewrite `render`:

```rust
/// Render the named template against the supplied JSON bytes. Lookup order:
/// dynamic tier first (runtime registrations win on collision — documented
/// override semantics), then the boot env.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let value: serde_json::Value =
        serde_json::from_slice(data_json).map_err(|e| RenderError::BadJson(e.to_string()))?;

    {
        let dyn_guard = DYN_ENV.read();
        if let Some(env) = dyn_guard.as_ref()
            && let Ok(tmpl) = env.get_template(name)
        {
            return tmpl.render(&value).map_err(|e| RenderError::Render(e.to_string()));
        }
    } // dyn lock dropped before boot lookup

    let guard = ENV.read();
    let env = guard.as_ref().ok_or(RenderError::NotLoaded)?;
    let tmpl = env
        .get_template(name)
        .map_err(|_| RenderError::UnknownTemplate(name.to_string()))?;
    tmpl.render(&value).map_err(|e| RenderError::Render(e.to_string()))
}
```

CAREFUL: `RenderError::NotLoaded` semantics change slightly: when boot env was never loaded but the dynamic template exists, render succeeds (spec invariant: dynamic tier independent of boot ordering). When NEITHER loaded and name unknown → NotLoaded (boot env None) — acceptable, test pins it.
BadJson now surfaces before UnknownTemplate (parse moved up to avoid re-parsing per tier) — adjust existing test expectations ONLY if any assert orders these (current tests use valid-name+bad-json and bad-name+valid-json separately, so no change needed).

5. Unit tests (append to existing `tests` mod — single `#[test]` fn `dynamic_registry_round_trip` since ENV/DYN are process-global, same pattern as `jinja_round_trip`; plus a separate small `#[test] fn register_validation_errors`):

- register `shop/1/section/2@v1` → render with data → exact html
- re-register same name with new source → render shows new output
- syntax error register (`{% for x in %}`) → Err(Syntax(..)), then previous registration still renders old output
- remove → true; second remove → false; render → UnknownTemplate (after load_from has run so boot env exists)
- precedence: load_from a dir containing `HelloDyn.jinja`; register dynamic `HelloDyn` with different body → render shows dynamic; remove → render shows boot version
- load_from twice (hot reload) → dynamic registrations still render
- `has_template`: dynamic name true, boot name true, missing false
- `dynamic_template_names` contains the registered key
- validation: `""` → EmptyName; `"a\u{0}b"` → NameControlChar; 513-byte name → NameTooLong

IMPORTANT: these tests share process-global state with `jinja_round_trip` — Rust runs tests in the same process across threads. `jinja_round_trip` already replaces ENV. Use UNIQUE template names in the new tests (prefix `dynreg/`) and do NOT assume ENV contents; where boot-tier interplay is needed, call `load_from` with a fresh tempdir INSIDE the test (last-write-wins on ENV is tolerated by `jinja_round_trip` only if it doesn't run interleaved — cargo runs tests concurrently! `jinja_round_trip` calls `load_from` then renders; our test also calls `load_from` → RACE. Mitigation: gate both tests on a shared `static TEST_LOCK: Mutex<()>` (parking_lot) acquired at test start. Add `static TEST_LOCK` in the tests mod and take it in BOTH `jinja_round_trip` and the new boot-interacting test. The validation-only test doesn't touch ENV/load_from but does touch DYN_* → also take the lock to keep dynamic state deterministic.)

Verify: `cargo test -p brust-core template::jinja` → all green (expect 4 tests incl. existing). Then `cargo fmt --all && cargo clippy --all-targets --locked -- -D warnings` for the touched crate compiles clean.

## Task 2 — NAPI bindings + addon rebuild

File: `crates/brust/src/lib.rs` — add after `napi_load_jinja_templates` (~line 1150):

```rust
/// R1 dynamic template registry — register (or replace) a runtime template.
/// Errors (name validation / jinja syntax) surface as a thrown JS Error with
/// the minijinja message (includes line info).
#[napi]
pub fn napi_register_template(name: String, source: String) -> NapiResult<()> {
    brust_core::template::jinja::register_template(&name, &source)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// R1 — remove a runtime-registered template. Returns whether it existed.
/// Boot-tier (directory-loaded) templates are not removable.
#[napi]
pub fn napi_remove_template(name: String) -> bool {
    brust_core::template::jinja::remove_dynamic_template(&name)
}

/// R1 — names of runtime-registered templates (dynamic tier only).
#[napi]
pub fn napi_list_dynamic_templates() -> Vec<String> {
    brust_core::template::jinja::dynamic_template_names()
}

/// R1 — true when `name` resolves in either tier (dynamic first, then boot).
#[napi]
pub fn napi_has_template(name: String) -> bool {
    brust_core::template::jinja::has_template(&name)
}

/// R1 — render a template (either tier) to an HTML string. NOT the request
/// hot path (allocates a JS string per call; the fast lane is
/// napi_render_jinja via SAB) — intended for handlers/loaders/tooling.
#[napi]
pub fn napi_render_template(name: String, data_json: String) -> NapiResult<String> {
    brust_core::template::jinja::render(&name, data_json.as_bytes())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
```

Rebuild addon: `cd runtime && bun run build:debug` (regenerates `index.js`/`index.d.ts`; memory: stale .node silently lies). Verify `grep napiRegisterTemplate runtime/index.d.ts` shows the camelCased export.

## Task 3 — TS wrapper, boot-validation fix, tests, docs

1. New `runtime/templates.ts`:

```ts
// R1 dynamic template registry — runtime registration of minijinja templates
// (per-tenant sections etc.). Thin TS over NAPI; the Rust env is process-global
// so registrations are visible to every worker isolate immediately.
import * as native from './index.js'

export const templates = {
  /** Register (or replace) a runtime template under `name`. Names are opaque
   * keys (`shop/42/section/7@v3` is fine). Throws on jinja syntax errors
   * (message includes line info). Replacement is atomic: concurrent renders
   * see old or new, never missing. */
  register(name: string, jinjaSource: string): void {
    ;(native as any).napiRegisterTemplate(name, jinjaSource)
  },
  /** Remove a runtime-registered template. Returns whether it existed.
   * Boot-tier templates (compiled from routes) are not removable. */
  remove(name: string): boolean {
    return (native as any).napiRemoveTemplate(name)
  },
  /** True when `name` resolves in either tier (dynamic first, then boot). */
  has(name: string): boolean {
    return (native as any).napiHasTemplate(name)
  },
  /** Names of runtime-registered templates (dynamic tier only). */
  list(): string[] {
    return (native as any).napiListDynamicTemplates() ?? []
  },
  /** Render a template (either tier) to an HTML string. Pure (name, data) →
   * html — no request/store context. NOT the request fast lane; intended for
   * handlers/loaders/tooling (draft canvases, section previews). */
  render(name: string, data?: unknown): string {
    return (native as any).napiRenderTemplate(name, JSON.stringify(data ?? {}))
  },
}
```

2. Export from `runtime/index.ts`: find the line `export { cache }` (or the export block near it — grep `from './cache.ts'`) and add `export { templates } from './templates.ts'` adjacent.

3. Boot-validation dual-tier fix in `runtime/index.ts` (~line 262-272): replace the Set check with per-name `napiHasTemplate`, keeping a fallback for stale addons:

```ts
    const expected = routes.filter((r) => r.nativeTemplate).map((r) => r.nativeTemplate!)
    if (expected.length > 0) {
      // Dual-tier check (boot env + R1 dynamic registry). `napiHasTemplate`
      // may be absent on a stale addon — fall back to the boot-tier list.
      const hasTemplate: (name: string) => boolean = (native as any).napiHasTemplate
        ? (name) => (native as any).napiHasTemplate(name)
        : (() => {
            const registered = new Set<string>((native as any).napiListNativeTemplates() ?? [])
            return (name) => registered.has(name)
          })()
      for (const name of expected) {
        if (!hasTemplate(name)) {
          console.warn(
            `[brust] native: true route expects template "${name}.jinja" but it's not registered (boot warning — request will 500)`,
          )
        }
      }
    }
```

4. New `runtime/templates.test.ts` (real addon, mirrors `runtime/cache.test.ts` style — no mocks):

- register `shop/1/section/2@v1` with `<div class="s">{{ title }}</div>` → `templates.render(name, {title:'X'})` === `<div class="s">X</div>`; `has` true; `list()` contains name
- register again with new body → render reflects update
- syntax error → `expect(() => templates.register(n, '{% for x in %}')).toThrow()`; previous body still renders
- `remove` → true then false; `has` → false; `render` throws
- `render('no-such-template-xyz')` throws
- `render` with no data arg works for a static template

5. Docs page `example/docs/content/dynamic-templates.md` — follow the structure of an existing short page (look at `example/docs/content/` for frontmatter conventions; check `lib/` nav registration — mdNav/mdRoutes in `example/docs/routes.tsx`). Content: what it is (runtime template registry), API table (register/remove/has/list/render), per-tenant example (register at boot from DB, render in a handler), caveats (in-memory per process; dynamic shadows boot names; not the request fast lane; pair with compileJsx for JSX→jinja). Register the page in the docs nav the same way neighboring pages are.

6. Gates: `bun test runtime/templates.test.ts`, then full `bun test`, `bun run ci` (biome), `cargo test -p brust-core`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --locked -- -D warnings`.

## BLOCKED fallbacks

- If `add_template_owned` re-registration does NOT replace (render shows old): fall back to `env.remove_template(name)` immediately followed by `add_template_owned` **inside the same DYN_ENV write lock** (no observable window — readers are excluded by the write lock).
- If `let ... && let Some(...)` chains hit edition/clippy issues, use nested if-let (repo is Rust 2021? check Cargo.toml edition — if 2021, let-chains are NOT stable; USE NESTED if-let from the start).
- If happy-path TS test can't see the addon (`bun run build:debug` missing), run it first; tests requiring the addon follow the cache.test.ts precedent.

## Spec coverage map

| Spec section | Task |
|---|---|
| Dynamic env + sources, register/remove/list/has, lookup order | 1 |
| RegisterError variants + name validation | 1 |
| Concurrency invariants 1–4 | 1 (lock order note + tests) |
| NAPI surface + camelCase | 2 |
| TS `templates` API + export | 3 |
| Boot-validation dual-tier (invariant 6) | 3 |
| Tests (Rust/TS) | 1, 3 |
| Docs page | 3 |
