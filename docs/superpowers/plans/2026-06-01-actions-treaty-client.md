# Actions → Treaty Client (Eden-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace brust's string-id POST-only actions with an Eden-Treaty-style, end-to-end type-safe RPC: chained builder `defineActions()` on the server, proxy client `client<Actions>()` in the browser, all HTTP methods, configurable mount prefix, Standard Schema validation.

**Architecture:** Three subsystems. (1) Rust wire: path-only `matchit` router whose value is a per-path method table; dispatch selects by method (404 on path-miss, 405 on method-miss), harvests params, ships an envelope. (2) Server builder: `defineActions()` accumulates `EndpointDef`s and a builder type; the worker validates body/query via Standard Schema then calls a context-object handler. (3) Client proxy: a `Proxy` reconstructs the URL from the literal registered path and returns `{data,error,status,headers,response}`.

**Tech Stack:** Rust (matchit 0.9, napi-rs, tokio), TypeScript (Bun test), Standard Schema v1 (Zod/Valibot/ArkType compatible).

**Scope of THIS plan (vertical slice — be loud):** GET/POST/PUT/PATCH/DELETE; JSON body; path params; query passthrough; Standard Schema body+query validation (JSON only); configurable `actionPrefix`; full replace of the old `'use server'`/`action()`/`formAction()` system. **Deferred follow-ups:** HEAD method, multipart/urlencoded→object coercion for schema validation, runtime query coercion beyond strings, `onRequest`/`onResponse` client hooks, per-status error schemas, exhaustive type-narrowing goldens.

---

## File Structure

Create:
- `crates/brust/src/action_router.rs` — `Method` enum, `ActionRouter` (path-only matchit + per-path method table), `MatchOutcome`.
- `runtime/standard-schema.ts` — Standard Schema v1 types + `validate()` helper.
- `runtime/define-actions.ts` — `defineActions()` builder, `ActionsBuilder<Acc>` type, `EndpointDef` runtime shape, `ActionContext`, `respond`.
- `runtime/treaty.ts` — `client<A>()` proxy, `TreatyResponse`, tree type. (Re-exported from `runtime/client/index.ts`.)

Modify:
- `crates/brust/src/routes.rs` — `ActionEnvelope.params`; `build_action_envelope(... params ...)`.
- `crates/brust/src/server.rs` — prefix-keyed method gate; action dispatch via `ActionRouter`; GET/HEAD no-body; 404/405.
- `crates/brust/src/lib.rs` — `register_actions(Vec<EndpointReg>)` builds `ActionRouter`; store `actionPrefix`; remove `is_safe_action_id` (+ invariant test).
- `runtime/actions.ts` — replace `ActionDef`/`ActionFn`/`withMiddleware`/`isValidActionId` with `EndpointDef` + `isValidEndpointPath`.
- `runtime/routes.ts` — `RouteCall` action variant (+`params`); rewrite `actionBranchToResponse`.
- `runtime/index.ts` — `run`/`serve` accept `actions` builder + `actionPrefix`; walk endpoints to register; inject `__BRUST_ACTION_PREFIX__`; drop `scanActions`.
- `runtime/client/index.ts` — remove `action`/`formAction`; export `client` from `treaty.ts`.

Remove:
- `runtime/scan-actions.ts`, `runtime/scan-actions.test.ts`.

Migrate (slice):
- `tests/fixtures/app/actions.ts` + `components/{NoteForm,WhoAmI,AvatarUpload}.tsx` + `routes.tsx` wiring.
- `example/hello-world/{actions.ts,index.ts,routes.tsx as needed}`.
- `bench/apps/brust/actions.ts`.
- `architecture.md` actions section.

---

## Task R1: Rust `ActionRouter` (path-only matchit + method table)

**Files:**
- Create: `crates/brust/src/action_router.rs`
- Modify: `crates/brust/src/lib.rs` (add `mod action_router;`)
- Test: inline `#[cfg(test)]` in `action_router.rs`

- [ ] **Step 1: Write the failing tests**

```rust
// crates/brust/src/action_router.rs  (tests at bottom)
#[cfg(test)]
mod tests {
    use super::*;

    fn router() -> ActionRouter {
        let mut r = ActionRouter::new();
        r.insert(Method::Get, "/notes/{id}", 0).unwrap();
        r.insert(Method::Delete, "/notes/{id}", 1).unwrap();
        r.insert(Method::Post, "/notes", 2).unwrap();
        r
    }

    #[test]
    fn matches_method_and_extracts_params() {
        let r = router();
        match r.at(Method::Get, "/notes/abc") {
            MatchOutcome::Found { endpoint_id, params } => {
                assert_eq!(endpoint_id, 0);
                assert_eq!(params, vec![("id".to_string(), "abc".to_string())]);
            }
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn unknown_path_is_not_found() {
        let r = router();
        assert!(matches!(r.at(Method::Get, "/nope"), MatchOutcome::NotFound));
    }

    #[test]
    fn known_path_wrong_method_is_method_not_allowed() {
        let r = router();
        // PUT /notes/{id} not registered, but the path exists for GET/DELETE.
        assert!(matches!(
            r.at(Method::Put, "/notes/xyz"),
            MatchOutcome::MethodNotAllowed
        ));
    }

    #[test]
    fn duplicate_method_path_errors() {
        let mut r = router();
        assert!(r.insert(Method::Get, "/notes/{id}", 9).is_err());
    }

    #[test]
    fn method_from_str_roundtrip() {
        assert_eq!(Method::from_http("GET"), Some(Method::Get));
        assert_eq!(Method::from_http("delete"), None); // case-sensitive: HTTP is upper
        assert_eq!(Method::from_http("PATCH"), Some(Method::Patch));
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/detoro/code/brust && cargo test -p brust action_router 2>&1 | tail -20`
Expected: FAIL — `action_router` module not found / types undefined.

- [ ] **Step 3: Implement**

```rust
// crates/brust/src/action_router.rs
//! Path-only matchit router for server actions. The value at each path is a
//! per-method table, so a path that exists for GET but not PUT yields
//! MethodNotAllowed (405) rather than NotFound (404) — a distinction a
//! method-keyed single tree cannot make.

use matchit::Router;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
}

impl Method {
    /// Parse an uppercase HTTP method token. Case-sensitive (HTTP methods are
    /// upper-case on the wire; the parser upstream passes them verbatim).
    pub fn from_http(s: &str) -> Option<Self> {
        Some(match s {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            "DELETE" => Method::Delete,
            "HEAD" => Method::Head,
            _ => return None,
        })
    }

    fn index(self) -> usize {
        match self {
            Method::Get => 0,
            Method::Post => 1,
            Method::Put => 2,
            Method::Patch => 3,
            Method::Delete => 4,
            Method::Head => 5,
        }
    }
}

const N_METHODS: usize = 6;

/// Per-path method table: endpoint id per method slot, None = unregistered.
type MethodTable = [Option<u32>; N_METHODS];

#[derive(Debug, PartialEq, Eq)]
pub enum MatchOutcome {
    Found {
        endpoint_id: u32,
        params: Vec<(String, String)>,
    },
    /// Path matched but the requested method is not registered → 405.
    MethodNotAllowed,
    /// No path matched → 404.
    NotFound,
}

#[derive(Debug)]
pub enum InsertError {
    Duplicate { method: &'static str, path: String },
    Matchit { path: String, reason: String },
}

impl std::fmt::Display for InsertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InsertError::Duplicate { method, path } => {
                write!(f, "duplicate endpoint {method} {path}")
            }
            InsertError::Matchit { path, reason } => {
                write!(f, "invalid endpoint path {path}: {reason}")
            }
        }
    }
}

#[derive(Default)]
pub struct ActionRouter {
    // matchit value = index into `tables`
    inner: Router<usize>,
    tables: Vec<MethodTable>,
    // keep the literal pattern for each table slot, for clearer errors
    patterns: Vec<String>,
}

impl ActionRouter {
    pub fn new() -> Self {
        Self::default()
    }

    fn method_name(m: Method) -> &'static str {
        match m {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
            Method::Head => "HEAD",
        }
    }

    /// Insert (method, path) → endpoint_id. A new path allocates a fresh method
    /// table; an existing path reuses its table. Duplicate (method, path) errors.
    pub fn insert(
        &mut self,
        method: Method,
        path: &str,
        endpoint_id: u32,
    ) -> Result<(), InsertError> {
        // Does this exact path already have a table?
        let slot = match self.inner.at(path) {
            // matchit `.at` requires a concrete path, not a pattern, so we
            // can't look up "/notes/{id}" directly. Track patterns ourselves.
            _ => self.patterns.iter().position(|p| p == path),
        };
        let table_idx = match slot {
            Some(i) => i,
            None => {
                let i = self.tables.len();
                self.tables.push([None; N_METHODS]);
                self.patterns.push(path.to_string());
                self.inner.insert(path, i).map_err(|e| {
                    // roll back the speculative push on matchit rejection
                    self.tables.pop();
                    self.patterns.pop();
                    InsertError::Matchit {
                        path: path.to_string(),
                        reason: e.to_string(),
                    }
                })?;
                i
            }
        };
        let cell = &mut self.tables[table_idx][method.index()];
        if cell.is_some() {
            return Err(InsertError::Duplicate {
                method: Self::method_name(method),
                path: path.to_string(),
            });
        }
        *cell = Some(endpoint_id);
        Ok(())
    }

    /// Match a concrete request path against the tree, then select by method.
    pub fn at(&self, method: Method, path: &str) -> MatchOutcome {
        match self.inner.at(path) {
            Ok(m) => {
                let table = &self.tables[*m.value];
                match table[method.index()] {
                    Some(endpoint_id) => {
                        let params = m
                            .params
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();
                        MatchOutcome::Found { endpoint_id, params }
                    }
                    None => MatchOutcome::MethodNotAllowed,
                }
            }
            Err(_) => MatchOutcome::NotFound,
        }
    }
}
```

> **BLOCKED fallback:** if `self.inner.at(path)` cannot be used to detect an
> existing *pattern* during insert (it matches concrete paths, not patterns), the
> code above already sidesteps it by scanning `self.patterns`. If matchit rejects
> re-inserting because the radix structure conflicts on first insert of a new
> path, surface `InsertError::Matchit` (the test only inserts distinct patterns).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p brust action_router 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/brust/src/action_router.rs crates/brust/src/lib.rs
git commit -m "feat(rust): ActionRouter — path-only matchit + per-path method table (404/405)"
```

---

## Task R2: Wire `ActionRouter` into registration, envelope, and dispatch

**Files:**
- Modify: `crates/brust/src/lib.rs` (`register_actions`, store prefix, drop `is_safe_action_id` + its invariant test)
- Modify: `crates/brust/src/routes.rs` (`ActionEnvelope.params`, `build_action_envelope`)
- Modify: `crates/brust/src/server.rs` (method gate by prefix, dispatch via ActionRouter, GET/HEAD no-body, 404/405)
- Test: inline Rust tests + `cargo build`

**Context for the implementer:** Today `register_actions(ids: Vec<String>)` (`lib.rs:392`) stores a `HashSet` consulted by `action_id_registered` (`lib.rs:90`); dispatch (`server.rs:313`) does `strip_prefix("/_brust/action/")` + `is_safe_action_id` + body read + `build_action_envelope`. Replace the registry with a global `ActionRouter` + a global `action_prefix: String`. The endpoint id (`u32`) indexes the JS-side endpoint table (registration order).

- [ ] **Step 1: Failing test — registration + match through the global registry**

```rust
// crates/brust/src/lib.rs  (in #[cfg(test)] mod tests)
#[test]
fn register_and_match_actions() {
    // EndpointReg shape mirrors the napi input.
    install_action_router(vec![
        EndpointReg { method: "POST".into(), path: "/notes".into() },
        EndpointReg { method: "GET".into(), path: "/notes/{id}".into() },
    ])
    .unwrap();
    use crate::action_router::{Method, MatchOutcome};
    assert!(matches!(
        with_action_router(|r| r.at(Method::Get, "/notes/42")),
        MatchOutcome::Found { endpoint_id: 1, .. }
    ));
    assert!(matches!(
        with_action_router(|r| r.at(Method::Put, "/notes/42")),
        MatchOutcome::MethodNotAllowed
    ));
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p brust register_and_match 2>&1 | tail -20`
Expected: FAIL — `EndpointReg`/`install_action_router`/`with_action_router` undefined.

- [ ] **Step 3: Implement registry + prefix globals (lib.rs)**

```rust
// crates/brust/src/lib.rs
use crate::action_router::{ActionRouter, Method};
use parking_lot::RwLock;
use once_cell::sync::Lazy;   // match the crate's existing lazy/global idiom

static ACTION_ROUTER: Lazy<RwLock<ActionRouter>> =
    Lazy::new(|| RwLock::new(ActionRouter::new()));
static ACTION_PREFIX: Lazy<RwLock<String>> =
    Lazy::new(|| RwLock::new("/_brust/action".to_string()));

#[napi(object)]
pub struct EndpointReg {
    pub method: String,
    pub path: String,
}

pub(crate) fn install_action_router(regs: Vec<EndpointReg>) -> Result<u32, String> {
    let mut router = ActionRouter::new();
    for (i, reg) in regs.iter().enumerate() {
        let method = Method::from_http(&reg.method)
            .ok_or_else(|| format!("unknown method {}", reg.method))?;
        router
            .insert(method, &reg.path, i as u32)
            .map_err(|e| e.to_string())?;
    }
    let n = regs.len() as u32;
    *ACTION_ROUTER.write() = router;
    Ok(n)
}

pub(crate) fn with_action_router<R>(f: impl FnOnce(&ActionRouter) -> R) -> R {
    f(&ACTION_ROUTER.read())
}

pub(crate) fn action_prefix() -> String {
    ACTION_PREFIX.read().clone()
}

pub(crate) fn set_action_prefix(p: String) {
    *ACTION_PREFIX.write() = p;
}

/// napi entry — replaces the old `register_actions(Vec<String>)`.
#[napi]
pub fn register_actions(endpoints: Vec<EndpointReg>) -> NapiResult<u32> {
    install_action_router(endpoints).map_err(|e| napi::Error::from_reason(e))
}
```

Delete: the old `register_actions(ids: Vec<String>)`, `action_id_registered`,
`is_safe_action_id` (lib.rs) and the `server_action_id_matches_lib_helper`
invariant test. (The path/method validity now lives in TS + matchit.)

- [ ] **Step 4: Implement envelope params (routes.rs)**

Add to `ActionEnvelope` (after `action_id`):
```rust
    #[serde(serialize_with = "crate::routes::serialize_as_map")]
    pub params: Vec<(std::borrow::Cow<'a, str>, &'a str)>,
```
Change `build_action_envelope` to take `params: Vec<(Cow<str>, &str)>` and set it.
The caller (server.rs) passes the params harvested from `ActionRouter::at`.
> Note: `MatchOutcome::Found.params` is `Vec<(String,String)>` (owned). To fit the
> borrowed envelope, hold the owned `Vec` in a local in server.rs and build
> `Vec<(Cow::Borrowed(k), v.as_str())>` referencing it.

- [ ] **Step 5: Implement dispatch (server.rs)**

Replace the outer method gate (`server.rs:197-204`) so the action-prefix check is dynamic:
```rust
let prefix = crate::action_prefix();
let under_actions = path.starts_with(&format!("{prefix}/")) || path == prefix;
if method != "GET"
    && !under_actions
    && !(method == "POST" && path.starts_with("/_brust/cache/invalidate"))
    && !(method == "POST" && path == "/_brust/mcp")
{
    let _ = s.write_all(http::error_405()).await;
    return;
}
```
Replace the action branch (`server.rs:313`) so it:
1. computes `rel = path[prefix.len()..]` (strip query first via `split('?')`),
2. `let m = Method::from_http(&method)` → if `None`, `error_405`,
3. `match crate::with_action_router(|r| r.at(m, rel))`:
   - `NotFound` → `error_404`, `continue`
   - `MethodNotAllowed` → `error_405`, `continue`
   - `Found { endpoint_id, params }` → proceed to body read + envelope, passing
     `endpoint_id` as the `action_id` string (`endpoint_id.to_string()`) and `params`.
4. **GET/HEAD no-body**: before the `parse_content_length` → `error_411` branch,
   add: `if matches!(m, Method::Get | Method::Head) { content_length = 0; }` and
   skip the 411. For other methods keep the existing 411-on-missing-CL.

> The JS side keys its endpoint table by the numeric id string; `action_id` in the
> envelope becomes `endpoint_id.to_string()`. Keep the field name `action_id` to
> minimize churn in `RouteCall`.

- [ ] **Step 6: Run Rust gates**

Run: `cargo test -p brust 2>&1 | tail -20 && cargo build -p brust 2>&1 | tail -5`
Expected: tests PASS; build OK.
Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add crates/brust/src/{lib.rs,routes.rs,server.rs}
git commit -m "feat(rust): action dispatch via ActionRouter — all methods, configurable prefix, 404/405, params, GET no-body"
```

---

## Task T1: Standard Schema helper (TS)

**Files:**
- Create: `runtime/standard-schema.ts`
- Test: `runtime/standard-schema.test.ts`

- [ ] **Step 1: Failing test**

```ts
// runtime/standard-schema.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { validate } from './standard-schema.ts'

test('passes valid input and returns parsed value', async () => {
  const schema = z.object({ text: z.string() })
  const r = await validate(schema, { text: 'hi' })
  expect(r).toEqual({ ok: true, value: { text: 'hi' } })
})

test('fails invalid input and returns issues', async () => {
  const schema = z.object({ text: z.string() })
  const r = await validate(schema, { text: 123 })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(Array.isArray(r.issues)).toBe(true)
})

test('passthrough when schema is undefined', async () => {
  const r = await validate(undefined, { anything: true })
  expect(r).toEqual({ ok: true, value: { anything: true } })
})
```

- [ ] **Step 2: Run fail**

Run: `cd /Users/detoro/code/brust && bun test runtime/standard-schema.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found. (If `zod` is absent, add it as a devDependency: `bun add -d zod` — note in commit.)

- [ ] **Step 3: Implement**

```ts
// runtime/standard-schema.ts
/** Minimal Standard Schema v1 surface — https://standardschema.dev */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>
  }
}
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }
export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}

export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never

export type ValidateOk<T> = { ok: true; value: T }
export type ValidateErr = { ok: false; issues: ReadonlyArray<StandardIssue> }

/** Validate `input` against a Standard Schema. Undefined schema = passthrough.
 * Always returns (never throws) so the dispatcher can map failure to 422. */
export async function validate<S extends StandardSchemaV1 | undefined>(
  schema: S,
  input: unknown,
): Promise<ValidateOk<S extends StandardSchemaV1 ? InferOutput<S> : unknown> | ValidateErr> {
  if (schema === undefined) {
    return { ok: true, value: input as never }
  }
  let result = schema['~standard'].validate(input)
  if (result instanceof Promise) result = await result
  if (result.issues) {
    return { ok: false, issues: result.issues }
  }
  return { ok: true, value: result.value as never }
}
```

- [ ] **Step 4: Run pass**

Run: `bun test runtime/standard-schema.test.ts 2>&1 | tail -15`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/standard-schema.ts runtime/standard-schema.test.ts package.json bun.lock
git commit -m "feat(ts): Standard Schema v1 validate() helper"
```

---

## Task T2: `defineActions()` builder (TS)

**Files:**
- Create: `runtime/define-actions.ts`
- Test: `runtime/define-actions.test.ts`

**Context:** `Middleware`, `RouteResponse`, `BrustRequest` live in `runtime/routes.ts`. Reuse those types (import). The builder accumulates a runtime `endpoints: EndpointDef[]` and a phantom type param for client inference.

- [ ] **Step 1: Failing test (runtime behavior)**

```ts
// runtime/define-actions.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from './define-actions.ts'

test('accumulates endpoints with method/path/handler/schemas', () => {
  const a = defineActions()
    .post('/notes', ({ body }) => ({ id: '1' }), { body: z.object({ text: z.string() }) })
    .get('/notes/{id}', ({ params }) => ({ id: params.id }))
  const eps = a.endpoints
  expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(['POST /notes', 'GET /notes/{id}'])
  expect(typeof eps[0].handler).toBe('function')
  expect(eps[0].body).toBeDefined()
})

test('global .use middleware is prepended to every endpoint chain', () => {
  const mw = async (_req: any, next: any) => next()
  const a = defineActions().use(mw).get('/x', () => 1).post('/y', () => 2)
  expect(a.endpoints[0].middleware[0]).toBe(mw)
  expect(a.endpoints[1].middleware[0]).toBe(mw)
})

test('duplicate METHOD path throws at definition', () => {
  expect(() =>
    defineActions().get('/notes/{id}', () => 1).get('/notes/{id}', () => 2),
  ).toThrow(/duplicate/i)
})

test('invalid path throws', () => {
  expect(() => defineActions().get('notes', () => 1)).toThrow(/path/i)
  expect(() => defineActions().get('/a b', () => 1)).toThrow(/path/i)
})
```

- [ ] **Step 2: Run fail**

Run: `bun test runtime/define-actions.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// runtime/define-actions.ts
import type { BrustRequest, Middleware, RouteResponse } from './routes.ts'
import type { StandardSchemaV1, InferOutput } from './standard-schema.ts'

const RESPOND = Symbol('brust.respond')
export interface ActionResponseSentinel {
  readonly [RESPOND]: true
  status: number
  body: unknown
  headers?: Record<string, string>
}
export function isRespondSentinel(v: unknown): v is ActionResponseSentinel {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[RESPOND] === true
}
function makeRespond() {
  return (body: unknown, init?: { status?: number; headers?: Record<string, string> }): ActionResponseSentinel => ({
    [RESPOND]: true,
    status: init?.status ?? 200,
    body,
    headers: init?.headers,
  })
}

export interface ActionContext<Body = unknown, Params = Record<string, string>, Query = Record<string, string>> {
  req: BrustRequest
  body: Body
  params: Params
  query: Query
  headers: Record<string, string>
  respond: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ActionResponseSentinel
}

type Handler<B, P, Q, R> = (ctx: ActionContext<B, P, Q>) => R | Promise<R>

export interface EndpointOptions {
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  middleware?: Middleware[]
}

/** Runtime descriptor consumed by the worker dispatcher + registration. */
export interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  path: string
  handler: (ctx: ActionContext) => unknown
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  middleware: Middleware[]
}

// Extract {param} names → Record<name, string>
type ParamKeys<P extends string> =
  P extends `${string}{${infer K}}${infer Rest}`
    ? (K extends `*${infer C}` ? C : K) | ParamKeys<Rest>
    : never
type Params<P extends string> = [ParamKeys<P>] extends [never]
  ? Record<string, string>
  : { [K in ParamKeys<P>]: string }

type BodyOf<O> = O extends { body: infer S } ? (S extends StandardSchemaV1 ? InferOutput<S> : unknown) : unknown
type QueryOf<O> = O extends { query: infer S } ? (S extends StandardSchemaV1 ? InferOutput<S> : unknown) : Record<string, string>

/** Accumulated endpoint type map for client inference:
 *  { [path]: { [METHOD]: { input; output } } } */
export type EndpointEntry = { input: unknown; output: unknown }
export type EndpointMap = Record<string, Partial<Record<EndpointDef['method'], EndpointEntry>>>

const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

export function isValidEndpointPath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && p.startsWith('/') && !/[\s?#]/.test(p)
}

export interface ActionsBuilder<Acc extends EndpointMap = {}> {
  endpoints: EndpointDef[]
  use(mw: Middleware): ActionsBuilder<Acc>
  get<P extends string, O extends EndpointOptions, R>(
    path: P, handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>, opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { GET: { input: QueryOf<O>; output: Awaited<R> } } }>
  post<P extends string, O extends EndpointOptions, R>(
    path: P, handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>, opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { POST: { input: BodyOf<O>; output: Awaited<R> } } }>
  put<P extends string, O extends EndpointOptions, R>(
    path: P, handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>, opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { PUT: { input: BodyOf<O>; output: Awaited<R> } } }>
  patch<P extends string, O extends EndpointOptions, R>(
    path: P, handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>, opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { PATCH: { input: BodyOf<O>; output: Awaited<R> } } }>
  delete<P extends string, O extends EndpointOptions, R>(
    path: P, handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>, opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { DELETE: { input: BodyOf<O>; output: Awaited<R> } } }>
}

export function defineActions(): ActionsBuilder {
  const endpoints: EndpointDef[] = []
  const globalMw: Middleware[] = []
  const seen = new Set<string>()

  function add(method: EndpointDef['method'], path: string, handler: (c: ActionContext) => unknown, opts?: EndpointOptions) {
    if (!isValidEndpointPath(path)) {
      throw new Error(`defineActions: invalid endpoint path ${JSON.stringify(path)} (must start with '/', no whitespace/?#)`)
    }
    const key = `${method} ${path}`
    if (seen.has(key)) throw new Error(`defineActions: duplicate endpoint ${key}`)
    seen.add(key)
    endpoints.push({
      method, path, handler,
      body: opts?.body, query: opts?.query,
      middleware: [...globalMw, ...(opts?.middleware ?? [])],
    })
  }

  const builder = {
    endpoints,
    use(mw: Middleware) { globalMw.push(mw); return builder },
    get(p: string, h: any, o?: EndpointOptions) { add('GET', p, h, o); return builder },
    post(p: string, h: any, o?: EndpointOptions) { add('POST', p, h, o); return builder },
    put(p: string, h: any, o?: EndpointOptions) { add('PUT', p, h, o); return builder },
    patch(p: string, h: any, o?: EndpointOptions) { add('PATCH', p, h, o); return builder },
    delete(p: string, h: any, o?: EndpointOptions) { add('DELETE', p, h, o); return builder },
  }
  return builder as unknown as ActionsBuilder
}

export { makeRespond, RESPOND }
```

> **Note on `.use` + middleware capture:** because `.use` pushes to `globalMw`
> and `add` snapshots `[...globalMw, ...]` at call time, an endpoint only gets the
> middleware registered *before* it. The test registers `.use` first; that's the
> documented contract (parent-before-child, declaration order). State this in the
> handler-context doc comment.

- [ ] **Step 4: Run pass**

Run: `bun test runtime/define-actions.test.ts 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/define-actions.ts runtime/define-actions.test.ts
git commit -m "feat(ts): defineActions() chained builder + accumulated endpoint type"
```

---

## Task T3: Worker dispatch + registration rewrite (TS)

**Files:**
- Modify: `runtime/actions.ts` (replace old `ActionDef`/`ActionFn`/`withMiddleware`/`isValidActionId`; re-export `EndpointDef`)
- Modify: `runtime/routes.ts` (`RouteCall` action variant `+params`; rewrite `actionBranchToResponse`)
- Modify: `runtime/index.ts` (`run`/`serve` take `actions` builder + `actionPrefix`; register via `registerActions(endpoints.map → {method,path})`; inject `__BRUST_ACTION_PREFIX__`; drop `scanActions`)
- Remove: `runtime/scan-actions.ts`, `runtime/scan-actions.test.ts`
- Test: `runtime/action-dispatch.test.ts`

**Context:** `actionBranchToResponse` (`routes.rs` JS side, `runtime/routes.ts:1093-1196`) currently decodes an args array and calls `def.fn(req, ...args)`. Rewrite to: build `ctx`, validate, run middleware chain, call `def.handler(ctx)`, map `respond`/plain value → RouteResponse. The endpoint table is now keyed by the numeric id string (registration order) — `byId.get(call.action_id)` where `action_id = String(endpointIndex)`.

- [ ] **Step 1: Failing test (drive `actionBranchToResponse` directly)**

```ts
// runtime/action-dispatch.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from './define-actions.ts'
import { dispatchAction } from './routes.ts'  // new exported helper

function table(b: ReturnType<typeof defineActions>) {
  return new Map(b.endpoints.map((e, i) => [String(i), e]))
}

test('GET with params returns 200 JSON', async () => {
  const a = defineActions().get('/notes/{id}', ({ params }) => ({ id: params.id }))
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: '', params: { id: 'abc' },
      req: { method: 'GET', headers: {}, cookies: {}, search: '' } as any },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ id: 'abc' })
})

test('POST validates body, 422 on bad input', async () => {
  const a = defineActions().post('/notes', ({ body }) => body, { body: z.object({ text: z.string() }) })
  const bad = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: JSON.stringify({ text: 123 }),
      req: { method: 'POST', headers: {}, cookies: {}, search: '' } as any },
    table(a),
  )
  expect(bad.status).toBe(422)
  expect(JSON.parse(bad.body).error.issues).toBeDefined()
})

test('respond() sentinel controls status', async () => {
  const a = defineActions().post('/x', ({ respond }) => respond({ ok: true }, { status: 201 }))
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', headers: {}, cookies: {}, search: '' } as any },
    table(a),
  )
  expect(res.status).toBe(201)
})
```

- [ ] **Step 2: Run fail**

Run: `bun test runtime/action-dispatch.test.ts 2>&1 | tail -15`
Expected: FAIL — `dispatchAction` not exported.

- [ ] **Step 3: Implement dispatch (routes.ts)**

Add `params?: Record<string,string>` to the `RouteCall` action variant. Export and implement `dispatchAction` (replaces `actionBranchToResponse`):

```ts
// runtime/routes.ts
import { isRespondSentinel } from './define-actions.ts'
import type { EndpointDef } from './define-actions.ts'
import { validate } from './standard-schema.ts'

export async function dispatchAction(
  call: Extract<RouteCall, { kind: 'action' }>,
  byId: Map<string, EndpointDef>,
): Promise<BranchResponse> {
  const def = byId.get(call.action_id)
  if (!def) {
    return { status: 404, body: '{"error":{"message":"unknown action"}}', contentType: 'application/json; charset=utf-8' }
  }
  call.req.signal = NEVER_ABORTS

  // Body decode — JSON only in this slice. (multipart/urlencoded deferred.)
  let rawBody: unknown = undefined
  if (def.method !== 'GET' && def.method !== 'HEAD') {
    try {
      rawBody = call.body_text != null && call.body_text !== '' ? JSON.parse(call.body_text) : undefined
    } catch (err) {
      return { status: 400, body: JSON.stringify({ error: { message: `invalid JSON body: ${(err as Error).message}` } }), contentType: 'application/json; charset=utf-8' }
    }
  }

  // Validate body + query.
  const bodyCheck = await validate(def.body, rawBody)
  if (!bodyCheck.ok) {
    return { status: 422, body: JSON.stringify({ error: { message: 'body validation failed', issues: bodyCheck.issues } }), contentType: 'application/json; charset=utf-8' }
  }
  const queryObj = parseSearch(call.req.search ?? '')
  const queryCheck = await validate(def.query, queryObj)
  if (!queryCheck.ok) {
    return { status: 422, body: JSON.stringify({ error: { message: 'query validation failed', issues: queryCheck.issues } }), contentType: 'application/json; charset=utf-8' }
  }

  const ctx = {
    req: call.req,
    body: bodyCheck.value,
    params: call.params ?? {},
    query: queryCheck.value,
    headers: call.req.headers ?? {},
    respond: (body: unknown, init?: { status?: number; headers?: Record<string,string> }) => ({
      // identity-branded; see define-actions.ts RESPOND
      ...makeRespondSentinel(body, init),
    }),
  }

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const result = await def.handler(ctx as never)
      if (isRespondSentinel(result)) {
        return { status: result.status, body: result.body === undefined ? '' : JSON.stringify(result.body), contentType: 'application/json; charset=utf-8', headers: result.headers }
      }
      return { status: 200, body: result === undefined ? '' : JSON.stringify(result), contentType: 'application/json; charset=utf-8' }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      console.error(`[brust] action ${def.method} ${def.path} threw:`, err)
      return { status: 500, body: JSON.stringify({ error: { message: e.message, name: e.name } }), contentType: 'application/json; charset=utf-8' }
    }
  }

  const chain = composeChain(call.req, def.middleware, terminal)
  let response: RouteResponse
  try { response = await chain() } catch (err) {
    console.error('[brust] action middleware uncaught:', err)
    response = { status: 500, body: '{"error":{"message":"internal error"}}', contentType: 'application/json; charset=utf-8' }
  }
  return { status: response.status, body: response.body, contentType: response.contentType ?? 'application/json; charset=utf-8', headers: response.headers }
}

function parseSearch(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  const qs = search.startsWith('?') ? search.slice(1) : search
  if (!qs) return out
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v
  return out
}
```

> Use the single `ctx.respond` from `define-actions.ts` (`makeRespond`) rather
> than re-implementing — import `makeRespond` and call it to build `ctx.respond`,
> so the same `RESPOND` symbol brands the sentinel `isRespondSentinel` checks.
> (Replace the inline `makeRespondSentinel` placeholder above with `makeRespond()`.)

Update the dispatcher call site (`runtime/routes.ts:726`, `if (call.kind === 'action')`) to call `dispatchAction(call, this.actions)` where `this.actions` is the `Map<string,EndpointDef>` built from the builder.

- [ ] **Step 4: Implement registration (index.ts) + actions.ts cleanup**

In `runtime/actions.ts`: delete `ActionFn`, `ActionDef`, `withMiddleware`, `getActionMiddleware`, `isValidActionId`. Re-export `EndpointDef`, `isValidEndpointPath` from `define-actions.ts`. Keep nothing referencing the old charset.

In `runtime/index.ts`:
- `serve`/`run` opts: replace `actions?: ActionDef[]` with `actions?: ActionsBuilder` and add `actionPrefix?: string`.
- Registration:
```ts
if (opts.actions) {
  const eps = opts.actions.endpoints
  ;(native as any).registerActions(eps.map((e) => ({ method: e.method, path: e.path })))
  if (opts.actionPrefix) (native as any).setActionPrefix(opts.actionPrefix)  // napi setter
}
```
- Build the worker dispatch table `Map<string,EndpointDef>` from `eps` (index→def) and pass to `makeRenderer({ actions })`.
- Remove the `scanActions` import + call; delete `runtime/scan-actions.ts` and its test.
- Inject the prefix global into rendered pages: in the island/bootstrap injection (where importmap/bootstrap is emitted), add `globalThis.__BRUST_ACTION_PREFIX__ = ${JSON.stringify(prefix)}`. (Find the existing bootstrap injection via `configureDevClientSnippet`/island bootstrap; add a one-line script.)

Add a napi `set_action_prefix` export in lib.rs:
```rust
#[napi]
pub fn set_action_prefix(prefix: String) { crate::set_action_prefix(prefix); }
```

- [ ] **Step 5: Run unit + targeted suites**

Run: `bun test runtime/action-dispatch.test.ts runtime/define-actions.test.ts runtime/standard-schema.test.ts 2>&1 | tail -20`
Expected: PASS.
Run: `bun test runtime/ 2>&1 | tail -25`
Expected: PASS (old action tests removed; no dangling imports). Fix any compile breaks from removed symbols.

- [ ] **Step 6: Commit**

```bash
git add runtime/actions.ts runtime/routes.ts runtime/index.ts runtime/action-dispatch.test.ts
git rm runtime/scan-actions.ts runtime/scan-actions.test.ts
git commit -m "feat(ts): context-object action dispatch + builder registration; remove use-server scanner"
```

---

## Task C1: `client<A>()` treaty proxy (TS)

**Files:**
- Create: `runtime/treaty.ts`
- Modify: `runtime/client/index.ts` (remove `action`/`formAction`/`BrustActionError`-only-path; export `client`, keep `BrustActionError` only if still referenced — otherwise remove)
- Test: `runtime/treaty.test.ts`

- [ ] **Step 1: Failing test (injected fetch)**

```ts
// runtime/treaty.test.ts
import { test, expect } from 'bun:test'
import { client } from './treaty.ts'

function fakeFetch(calls: any[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: init.body })
    return new Response(JSON.stringify({ echoed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

test('GET builds prefixed URL with params + query', async () => {
  const calls: any[] = []
  const api = client<any>({ prefix: '/api', fetch: fakeFetch(calls) })
  const { data, status } = await api.notes({ id: 'x' }).get({ query: { verbose: 'true' } })
  expect(calls[0].url).toBe('/api/notes/x?verbose=true')
  expect(calls[0].method).toBe('GET')
  expect(status).toBe(200)
  expect(data).toEqual({ echoed: true })
})

test('POST sends JSON body', async () => {
  const calls: any[] = []
  const api = client<any>({ prefix: '/api', fetch: fakeFetch(calls) })
  await api.notes.post({ text: 'hi' })
  expect(calls[0].url).toBe('/api/notes')
  expect(calls[0].method).toBe('POST')
  expect(JSON.parse(calls[0].body)).toEqual({ text: 'hi' })
})

test('non-2xx populates error not data, never throws', async () => {
  const api = client<any>({ prefix: '/api', fetch: async () => new Response('{"error":{"message":"nope"}}', { status: 422 }) })
  const { data, error, status } = await api.notes.post({})
  expect(data).toBeNull()
  expect(status).toBe(422)
  expect(error?.status).toBe(422)
})

test('network failure resolves as error status 0', async () => {
  const api = client<any>({ prefix: '/api', fetch: async () => { throw new Error('offline') } })
  const { error } = await api.notes.get()
  expect(error?.status).toBe(0)
})
```

- [ ] **Step 2: Run fail**

Run: `bun test runtime/treaty.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// runtime/treaty.ts
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head'])

export interface TreatyResponse<Data = unknown, Err = unknown> {
  data: Data | null
  error: { status: number; value: Err } | null
  status: number
  headers: Record<string, string>
  response: Response | null
}

export interface ClientOptions {
  prefix?: string
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
}

function resolvePrefix(opts?: ClientOptions): string {
  if (opts?.prefix) return opts.prefix
  const g = (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__
  return g ?? '/_brust/action'
}

/** Build a treaty proxy. Segments accumulate as a path; a function call with an
 * object fills the NEXT {param} (positionally, in registration order); a
 * terminal method key (.get/.post/…) performs the request. */
export function client<App = unknown>(opts?: ClientOptions): App {
  const prefix = resolvePrefix(opts)
  const doFetch = opts?.fetch ?? fetch

  function make(segments: string[]): any {
    return new Proxy(function () {}, {
      get(_t, key: string) {
        if (METHODS.has(key)) {
          return async (arg1?: unknown, arg2?: unknown): Promise<TreatyResponse> => {
            const isBodyless = key === 'get' || key === 'head'
            const options = (isBodyless ? arg1 : arg2) as { query?: Record<string, string>; headers?: Record<string, string> } | undefined
            const body = isBodyless ? undefined : arg1
            let url = prefix + '/' + segments.join('/')
            if (options?.query) {
              const qs = new URLSearchParams(options.query as Record<string, string>).toString()
              if (qs) url += '?' + qs
            }
            const baseHeaders = typeof opts?.headers === 'function' ? opts.headers() : (opts?.headers ?? {})
            const init: RequestInit = { method: key.toUpperCase(), headers: { ...baseHeaders, ...(options?.headers ?? {}) } }
            if (!isBodyless && body !== undefined) {
              init.body = JSON.stringify(body)
              ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
            }
            try {
              const res = await doFetch(url, init)
              const text = await res.text()
              const parsed = text ? safeJson(text) : undefined
              const headers: Record<string, string> = {}
              res.headers.forEach((v, k) => (headers[k] = v))
              if (res.ok) return { data: parsed ?? null, error: null, status: res.status, headers, response: res }
              return { data: null, error: { status: res.status, value: parsed ?? text }, status: res.status, headers, response: res }
            } catch (err) {
              return { data: null, error: { status: 0, value: err }, status: 0, headers: {}, response: null }
            }
          }
        }
        // static path segment
        return make([...segments, key])
      },
      apply(_t, _this, args: unknown[]) {
        // path param: append each value of the object arg, in insertion order
        const arg = args[0] as Record<string, string> | undefined
        if (!arg) return make(segments)
        return make([...segments, ...Object.values(arg).map(String)])
      },
    })
  }
  return make([]) as App
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}
```

> **Type surface (best-effort):** add a `Treaty<App>` mapped type that turns the
> `EndpointMap` into the nested proxy type so `api.notes.post(body)` infers
> body/return. If the recursive template-literal path parse proves too costly,
> ship `client<App>(): App` with `App` defaulting to a permissive recursive
> interface and capture the precise inference as the documented type follow-up —
> **runtime correctness does not depend on it** (URLs come from the literal
> segments, per the spec invariant). BLOCKED fallback: keep the runtime + a loose
> `any`-tree type; do not block the slice on perfect inference.

- [ ] **Step 4: Run pass**

Run: `bun test runtime/treaty.test.ts 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `runtime/client/index.ts`**

Remove `action`, `formAction`, `ServerFn`, `DropReq`, `FormActionFn`. Re-export:
```ts
export { client } from '../treaty.ts'
export type { TreatyResponse, ClientOptions } from '../treaty.ts'
```
Keep `BrustActionError` only if other modules import it; otherwise delete. Grep first: `grep -rn "BrustActionError\|formAction\|action<" runtime tests example`.

- [ ] **Step 6: Commit**

```bash
git add runtime/treaty.ts runtime/treaty.test.ts runtime/client/index.ts
git commit -m "feat(ts): client<A>() treaty proxy — all methods, {data,error}, prefix propagation"
```

---

## Task M1: Migrate fixtures, example, bench, docs

**Files:**
- Modify: `tests/fixtures/app/actions.ts`, `tests/fixtures/app/components/{NoteForm,WhoAmI,AvatarUpload}.tsx`, `tests/fixtures/app/routes.tsx`, `tests/fixtures/app/index.ts` (registration)
- Modify: `example/hello-world/{actions.ts,index.ts}`
- Modify: `bench/apps/brust/actions.ts`
- Modify: `architecture.md` (actions section)
- Test: existing `tests/*integration*`, `tests/native-island*`, plus a new `tests/treaty-integration.test.ts`

**Context:** This is the "replace" cutover. Every `'use server'` + `action('id')` + `formAction('id')` usage must become `defineActions` + `client`. Find them: `grep -rn "'use server'\|action<\|formAction<\|withMiddleware" runtime tests example bench`.

- [ ] **Step 1: Port `tests/fixtures/app/actions.ts`**

```ts
// tests/fixtures/app/actions.ts
import { defineActions } from '../../../runtime/index.ts'
import { z } from 'zod'
import type { Middleware } from '../../../runtime/routes.ts'

const requireUser: Middleware = async (req, next) =>
  req.cookies['user'] ? next() : { status: 401, body: 'login required' }

export const actions = defineActions()
  .post('/notes', ({ body }) => ({ id: 'n-' + body.text.length }), {
    body: z.object({ text: z.string().max(1000) }),
  })
  .get('/whoami', ({ req }) => ({ user: req.cookies['user'] ?? null }))
  .delete('/notes/{id}', ({ params }) => ({ ok: true as const, id: params.id }), {
    middleware: [requireUser],
  })

export type Actions = typeof actions
```

- [ ] **Step 2: Port components to `client`**

```tsx
// tests/fixtures/app/components/NoteForm.tsx
import { useState } from 'react'
import { client } from '../../../../runtime/client/index.ts'
import type { Actions } from '../actions'

const api = client<Actions>()

export default function NoteForm() {
  const [text, setText] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form onSubmit={async (e) => {
      e.preventDefault(); setErr(null)
      const { data, error } = await api.notes.post({ text })
      if (error) setErr(`status ${error.status}`)
      else { setCreated(data!.id); setText('') }
    }}>
      <input data-testid="note-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="note text" />
      <button>Save</button>
      {created && <span data-testid="note-created">created {created}</span>}
      {err && <span data-testid="note-error">{err}</span>}
    </form>
  )
}
```
(Port `WhoAmI.tsx` → `api.whoami.get()`; replace `AvatarUpload.tsx`/`AvatarPage`
multipart usage with a note that multipart-through-treaty is deferred — delete the
avatar route/component from the fixture set and any test asserting it, OR keep a
plain JSON endpoint stand-in. Choose deletion to keep the slice honest; record in
commit message.)

- [ ] **Step 3: Register in fixture entry + example**

In `tests/fixtures/app/index.ts` and `example/hello-world/index.ts`, change `brust.run` to pass the builder:
```ts
import { actions } from './actions'
await brust.run({ routes, entry: import.meta.url, actions /*, actionPrefix: '/_brust/action' */ })
```
Port `example/hello-world/actions.ts` to a `defineActions` with the bench `createNote` as `.post('/notes', …)`. Update `bench/apps/brust/actions.ts` likewise and adjust the bench request (`POST /_brust/action/notes`, JSON object body — NOT the old positional array).

- [ ] **Step 4: New integration test**

```ts
// tests/treaty-integration.test.ts  — model after tests/native-island.test.ts boot harness
// Boot the fixture server, then exercise the real wire with client<Actions>({ prefix, fetch: globalThis.fetch }) pointed at the booted origin.
// Assert: POST /notes 200 + id; POST /notes bad body → 422; GET /whoami 200; DELETE /notes/{id} without cookie → 401; unknown path → 404; GET on a POST-only path → 405.
```
(Use the existing native-island test's server-boot scaffolding verbatim for port allocation + readiness; copy its `beforeAll`/`afterAll`.)

- [ ] **Step 5: Run full gates**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings 2>&1 | tail && cargo test -p brust 2>&1 | tail -5`
Run: `bun test runtime/ 2>&1 | tail -20`
Run: `bun test tests/treaty-integration.test.ts 2>&1 | tail -20`
Run: `rm -rf tests/fixtures/app/.brust tests/fixtures/app/dist; bun test tests/native-island.test.ts 2>&1 | tail; bun test tests/native-island-ssr.test.ts 2>&1 | tail`
Expected: all green (cli-build `/native-islands` dual-React failure is pre-existing/out-of-gate — ignore only that one).

- [ ] **Step 6: Update `architecture.md` + commit**

Update the actions section of `architecture.md` to document `defineActions`/`client`, the prefix config, and the wire (`METHOD <prefix>/<path>`). Remove `'use server'` references.

```bash
git add -A
git commit -m "feat: migrate fixtures/example/bench/docs to defineActions + client; drop use-server"
```

---

## Self-Review

**Spec coverage:**
- Server `defineActions` chained builder + accumulated type → T2 ✓
- Standard Schema validation (JSON, 422) → T1 + T3 ✓
- `client<A>()` proxy, `{data,error,status}`, never-throw, prefix global → C1 ✓
- All methods at wire + 404/405 + params + GET no-body → R1 + R2 ✓
- Configurable `actionPrefix` (run opt + napi + client) → R2 + T3 + C1 ✓
- `ctx.respond` branded sentinel → T2 + T3 ✓
- Charset: all 4 legacy sites removed/repurposed → R2 (Rust ×2 + invariant test) + T3 (TS gate) ✓
- Replace migration (fixtures/example/bench/docs) → M1 ✓
- Deferred (HEAD runtime breadth, multipart schema coercion, query runtime coercion, hooks, type-narrow goldens) → documented in scope header ✓

**Placeholder scan:** `makeRespondSentinel` placeholder in T3 Step 3 is explicitly flagged to be replaced with `makeRespond()` from define-actions — call it out to the implementer. No other placeholders.

**Type consistency:** `EndpointDef` fields (`method/path/handler/body/query/middleware`) consistent across T2/T3. `action_id` carries `String(endpointIndex)` (R2 ↔ T3). `MatchOutcome`/`Method` consistent R1 ↔ R2. `TreatyResponse` shape consistent C1 ↔ tests.

**Risks / BLOCKED fallbacks embedded:** R1 (matchit pattern-vs-concrete insert dedup), C1 (type inference may loosen — runtime independent), M1 (multipart fixture deletion to keep slice honest).
