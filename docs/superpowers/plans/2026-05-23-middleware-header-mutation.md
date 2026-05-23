# Middleware + Header Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routes can declare `middleware: [(req, next) => RouteResponse, ...]` that wraps loader+render. Middleware can short-circuit by returning a response directly, mutate the response (status + headers) on the way out, and chain across multiple entries. Loaders + middleware receive a structured `req` (method, url, headers, cookies, search) parsed by Rust.

**Architecture:**
- SAB wire format extends from `[status u16 BE][body]` to `[meta_len u16 BE][meta JSON UTF-8][body]`. `meta = {status: number, headers?: Record<string, string>}`. Rust reads meta JSON and builds the wire response with the mutated status + headers.
- `RouteEnvelope` in Rust grows a `req` field carrying `{method, url, headers, cookies, search}` parsed once via `httparse`. Workers no longer derive this TS-side.
- TS `makeRenderer` composes per-route middleware via Express/Koa-style `(req, next) => Promise<RouteResponse>` chain. The terminal `next()` runs loader → component render and returns a `RouteResponse`. Each middleware can return early (short-circuit) or call `next()` and mutate the returned response.
- errorBoundary still catches loader/render exceptions and surfaces them as status 500 via the meta envelope; middleware that raises (unwrapped) bubbles to the same boundary.
- Cache continues to store the full wire-format response bytes built by Rust *after* status+headers are known, so middleware-mutated responses cache correctly.

**Tech Stack:** Rust (httparse, serde_json), TypeScript (Bun Worker), React 18 (renderToString), napi-rs 3, matchit 0.8.

**Out of scope (deferred to follow-ups):**
- Global `app/middleware.ts` array — only per-route `route.middleware: [...]` lands here.
- Header *deletion* (only set/override). Reasoning: response headers come from `build_response()` defaults — deletion requires another channel.
- WebSocket upgrades or streaming responses — meta envelope assumes one-shot HTML.
- Cookie *serialization* helpers (`Set-Cookie` parsing libraries). Middleware emits raw header strings; apps wire their own cookie lib.

---

## File Structure

**New (none)** — every change is in existing files. Plan stays surgical.

**Rust modifications:**
- `src/routes.rs` — `RouteEnvelope` adds `req: RequestEnvelope`; `RouteTable::match_path` signature grows `method` + `raw_request` params.
- `src/server.rs` — `handle_conn` passes method+buf to `match_path`; meta envelope parser replaces the `[status u16][body]` reader; `build_response` call site picks up mutated headers.
- `src/http.rs` — `build_response` accepts an optional `extra_headers: &[(String, String)]` slice and appends them to the wire header block.

**TypeScript modifications:**
- `runtime/routes.ts` — adds `BrustRequest`, `RouteResponse`, `Middleware` types; extends `Route` with `middleware?: Middleware[]`; `RouteCall` adds `req`; `makeRenderer` builds the middleware chain and writes the meta envelope.

**Example app additions:**
- `example/hello-world/routes.tsx` — adds `/protected` (auth middleware) and `/with-header` (header-mutating middleware) routes.
- `example/hello-world/components/Protected.tsx` — new component (rendered when auth passes).
- `example/hello-world/components/WithHeader.tsx` — new component for header demo.

**Test modifications:**
- `tests/integration.test.ts` — adds 4 new tests (auth short-circuit, custom response header, req.cookies in loader, middleware chain ordering).

---

## Task 1: Add `extra_headers` parameter to `build_response`

**Files:**
- Modify: `src/http.rs:29-52`

This is the foundation: every response Rust writes must be able to carry middleware-injected headers.

- [ ] **Step 1: Update `build_response` signature + implementation**

Replace the current `build_response` function in `src/http.rs` (lines 29-52) with:

```rust
pub fn build_response(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    body: Vec<u8>,
) -> Vec<u8> {
    let status_text = match status {
        200 => "OK",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        414 => "URI Too Long",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let mut header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: keep-alive\r\n",
        body.len(),
    );
    for (name, value) in extra_headers {
        // Skip names that would collide with the fixed lines above.
        let lower = name.to_ascii_lowercase();
        if lower == "content-type" || lower == "content-length" || lower == "connection" {
            continue;
        }
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}
```

- [ ] **Step 2: Update all `build_response` call sites in `src/http.rs`**

Find every line in `src/http.rs` that calls `build_response` (lines 55, 58, 61, 78) and add `&[]` as the new 3rd argument. After this step the file should compile.

For reference, the call sites should become:
```rust
pub fn error_400() -> Vec<u8> {
    build_response(400, "text/plain", &[], b"bad request".to_vec())
}
pub fn error_404() -> Vec<u8> {
    build_response(404, "text/plain", &[], b"not found".to_vec())
}
pub fn error_405() -> Vec<u8> {
    build_response(405, "text/plain", &[], b"method not allowed".to_vec())
}
pub fn error_503(msg: &str) -> Vec<u8> {
    build_response(503, "text/plain", &[], msg.as_bytes().to_vec())
}
```

- [ ] **Step 3: Update all `build_response` call sites in `src/server.rs`**

Find every line in `src/server.rs` that calls `http::build_response` (lines 121, 132, 173, 183, 194, 200) and add `&[]` as the new 3rd argument. Example:

```rust
let bytes = http::build_response(200, "text/plain", &[], b"pong\n".to_vec());
```

- [ ] **Step 4: Build to confirm signature change is consistent**

Run: `cargo build`
Expected: clean build (the existing `io::other` warning is allowed). No compile errors.

- [ ] **Step 5: Commit**

```bash
git add src/http.rs src/server.rs
git commit -m "$(cat <<'EOF'
refactor(http): build_response accepts extra_headers slice

Foundation for middleware-injected response headers. All existing call
sites pass &[] (no extra headers) — behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `RequestEnvelope` to `RouteEnvelope` (Rust)

**Files:**
- Modify: `src/routes.rs:1-93`
- Modify: `src/server.rs:139-145` (call-site)

Add the structured `req` shape that loaders + middleware see.

- [ ] **Step 1: Update `src/routes.rs` to add `RequestEnvelope` and extend `RouteEnvelope`**

Replace the imports + envelope definition at the top of `src/routes.rs` (lines 1-25) with:

```rust
use std::collections::HashMap;

use httparse::EMPTY_HEADER;
use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;

use crate::cache::CacheConfig;

/// Structured view of the incoming HTTP request, owned by the envelope.
/// Parsed once in Rust (cheaper than re-parsing in JS) and embedded in
/// the JSON envelope handed to the worker.
#[derive(Serialize)]
pub struct RequestEnvelope {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub cookies: HashMap<String, String>,
    pub search: HashMap<String, String>,
}

/// JSON envelope shipped across the tsfn boundary for each render call.
/// Worker JS deserializes this and uses `route_id` to pick the component.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
    pub req: RequestEnvelope,
}

/// Outcome of a match against the radix tree.
pub enum MatchResult {
    Matched {
        route_id: u32,
        envelope_json: String,
    },
    NoMatch,
}
```

- [ ] **Step 2: Update `RouteTable::match_path` to accept method + raw request bytes**

Replace the `match_path` method (lines 71-92 in the current file) with:

```rust
    pub fn match_path(
        &self,
        method: &str,
        full_path: &str,
        raw_request: &[u8],
    ) -> MatchResult {
        let (path_only, query) = match full_path.split_once('?') {
            Some((p, q)) => (p, q),
            None => (full_path, ""),
        };
        let router = self.inner.read();
        match router.at(path_only) {
            Ok(matched) => {
                let mut params: HashMap<&str, &str> = HashMap::new();
                for (k, v) in matched.params.iter() {
                    params.insert(k, v);
                }
                let req = build_request_envelope(method, full_path, query, raw_request);
                let envelope = RouteEnvelope {
                    route_id: *matched.value,
                    path: full_path,
                    params,
                    req,
                };
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                MatchResult::Matched {
                    route_id: *matched.value,
                    envelope_json,
                }
            }
            Err(_) => MatchResult::NoMatch,
        }
    }
```

Then append this helper function at the bottom of `src/routes.rs` (after the existing `RouteInstallError` enum):

```rust
fn build_request_envelope(
    method: &str,
    full_path: &str,
    query: &str,
    raw_request: &[u8],
) -> RequestEnvelope {
    // 64-header ceiling matches src/server.rs::lookup_vary_headers — enough
    // for Apache-default-shaped requests; headers beyond are dropped silently.
    let mut headers_storage = [EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers_storage);
    let _ = req.parse(raw_request);

    let mut headers: HashMap<String, String> = HashMap::new();
    let mut cookies: HashMap<String, String> = HashMap::new();
    for h in req.headers.iter() {
        if h.name.is_empty() {
            continue;
        }
        let name_lower = h.name.to_ascii_lowercase();
        let value = std::str::from_utf8(h.value).unwrap_or("").to_string();
        if name_lower == "cookie" {
            for pair in value.split(';') {
                let trimmed = pair.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    cookies.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
        headers.insert(name_lower, value);
    }

    let mut search: HashMap<String, String> = HashMap::new();
    if !query.is_empty() {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            match pair.split_once('=') {
                Some((k, v)) => {
                    search.insert(
                        url_decode(k),
                        url_decode(v),
                    );
                }
                None => {
                    search.insert(url_decode(pair), String::new());
                }
            }
        }
    }

    RequestEnvelope {
        method: method.to_string(),
        url: full_path.to_string(),
        headers,
        cookies,
        search,
    }
}

/// Minimal percent-decode for query-string keys/values. Decodes %xx and treats
/// `+` as space. Unrecognised escapes pass through unchanged.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push(((h << 4) | l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}
```

- [ ] **Step 3: Update the `match_path` call site in `src/server.rs`**

Find the block in `src/server.rs` around lines 139-145 that currently reads:

```rust
        let (envelope_json, route_id) = match routes.match_path(&path) {
            MatchResult::Matched { envelope_json, route_id } => (envelope_json, route_id),
            MatchResult::NoMatch => {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
        };
```

Replace it with:

```rust
        let (envelope_json, route_id) = match routes.match_path(&method, &path, &buf) {
            MatchResult::Matched { envelope_json, route_id } => (envelope_json, route_id),
            MatchResult::NoMatch => {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
        };
```

- [ ] **Step 4: Build to confirm**

Run: `cargo build`
Expected: clean (no warnings about unused parser results since `_` is used).

- [ ] **Step 5: Commit**

```bash
git add src/routes.rs src/server.rs
git commit -m "$(cat <<'EOF'
feat(routes): RouteEnvelope carries structured req (method, url, headers, cookies, search)

Rust parses the HTTP request once via httparse and embeds the result in
the JSON envelope handed to the worker. Loaders and (forthcoming)
middleware can now read req.cookies/headers/search without re-parsing
TS-side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Upgrade SAB wire format from `[status u16][body]` to `[meta_len u16 BE][meta JSON][body]` — Rust read side

**Files:**
- Modify: `src/server.rs:160-209` (the render call + response building block)

The TS side will be updated in Task 5 — tests will fail in between. That's expected for TDD; we're staging Rust before TS.

- [ ] **Step 1: Add a serde struct for the response meta envelope**

Add to the top of `src/server.rs` (under the existing imports, before `enum ReadOutcome`):

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ResponseMeta {
    status: u16,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}
```

- [ ] **Step 2: Replace the post-tsfn-call response builder**

Find the block in `src/server.rs` starting at:

```rust
        match entry.tsfn.call_async(envelope_json).await {
            Ok(promise) => match promise.await {
                Ok(n) => {
                    let n = n as usize;
                    // n must include the 2-byte status prefix + at least 1 body byte.
                    if n < 3 || n > entry.buf_len {
```

and ending at:

```rust
                    if let (Some(key), Some(cfg)) = (cache_key, cache_config.as_ref()) {
                        cache.insert(key, bytes.clone(), Duration::from_secs(cfg.ttl_seconds));
                    }
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
```

Replace it with:

```rust
        match entry.tsfn.call_async(envelope_json).await {
            Ok(promise) => match promise.await {
                Ok(n) => {
                    let n = n as usize;
                    // Envelope layout: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
                    // Minimum valid frame: 2 bytes meta_len + at least the smallest
                    // JSON object {"status":200} (15 bytes). Tighten the check to >= 17.
                    if n < 17 || n > entry.buf_len {
                        error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "render oversized or empty");
                        let _ = s.write_all(http::build_response(500, "text/plain", &[], b"render oversized".to_vec())).await;
                        return;
                    }
                    // SAFETY: see pool.rs BufPtr safety argument.
                    let raw: Vec<u8> = unsafe {
                        std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec()
                    };
                    let meta_len = u16::from_be_bytes([raw[0], raw[1]]) as usize;
                    if meta_len + 2 > n {
                        error!(worker_id = entry.id, meta_len, total = n, "meta_len out of range");
                        let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid render envelope".to_vec())).await;
                        return;
                    }
                    let meta_bytes = &raw[2..2 + meta_len];
                    let meta: ResponseMeta = match serde_json::from_slice(meta_bytes) {
                        Ok(m) => m,
                        Err(e) => {
                            error!(worker_id = entry.id, error = %e, "meta JSON parse failed");
                            let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid render envelope".to_vec())).await;
                            return;
                        }
                    };
                    let body = raw[2 + meta_len..].to_vec();
                    let extra: Vec<(String, String)> = meta
                        .headers
                        .into_iter()
                        .collect();
                    let bytes = http::build_response(meta.status, "text/html; charset=utf-8", &extra, body);
                    if let (Some(key), Some(cfg)) = (cache_key, cache_config.as_ref()) {
                        cache.insert(key, bytes.clone(), Duration::from_secs(cfg.ttl_seconds));
                    }
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
```

(Note: the `Err(e) => {...}` arm immediately after and the outer `Err(e) => {...}` arm at the end keep their existing code — only update the two `build_response` calls inside to include `&[]`.)

- [ ] **Step 3: Update the two error-arm `build_response` calls in the same block to include `&[]`**

For reference, after this step the two remaining error arms should look like:

```rust
                Err(e) => {
                    error!(worker_id = entry.id, error = %e, "render promise rejected");
                    let msg = format!("render error: {e}");
                    let _ = s.write_all(http::build_response(500, "text/plain", &[], msg.into_bytes())).await;
                    return;
                }
            },
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "tsfn call_async failed");
                let _ = s.write_all(http::build_response(502, "text/plain", &[], b"upstream call failed".to_vec())).await;
                pool.remove(entry.id);
                if pool.registered_count() == 0 {
                    error!("all workers died");
                    std::process::exit(1);
                }
                return;
            }
```

(These may already be in their final form after Task 1, in which case nothing to do here. Verify by inspecting the file.)

- [ ] **Step 4: Build to confirm Rust side compiles**

Run: `cargo build`
Expected: clean build. The integration tests will not pass yet — the TS worker still writes the old `[status u16][body]` format and the Rust side now expects `[meta_len u16][meta JSON][body]`. Skip running tests until Task 5 lands.

- [ ] **Step 5: Commit**

```bash
git add src/server.rs
git commit -m "$(cat <<'EOF'
feat(server): parse meta JSON envelope from SAB ([meta_len u16][meta JSON][body])

Rust reads the new SAB layout: u16 BE meta_len, JSON meta = {status,
headers}, then body. Mutated headers from the worker flow into
build_response via the new extra_headers slice. Tests will not pass
until the worker is updated in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TypeScript types — `BrustRequest`, `RouteResponse`, `Middleware`

**Files:**
- Modify: `runtime/routes.ts:1-53` (types only — behavior in Task 5)
- Modify: `runtime/index.ts:71-76` (re-exports)

- [ ] **Step 1: Replace the type block at the top of `runtime/routes.ts`**

Replace lines 1-53 of `runtime/routes.ts` (everything from the imports through `RouteCall`) with:

```ts
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

/** Structured view of the request, parsed once in Rust and shipped in the
 * JSON envelope. Header names are lower-cased. Cookies are parsed from the
 * Cookie header. `search` is the query string parsed as key→value (last
 * occurrence wins on duplicates). */
export interface BrustRequest {
  method: string
  /** Full request URL path including query string, e.g. `/foo?bar=1`. */
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  search: Record<string, string>
}

export interface RouteContext<Params = Record<string, string>, Data = unknown> {
  params: Params
  path: string
  /** Value returned by `route.loader`. Undefined if the route has no loader. */
  data: Data
  /** Bun Worker id rendering this request. null before the first registerRenderer
   * return resolves (a brief window during boot). */
  workerId: number | null
  /** Structured request shape. Available to components for read-only inspection. */
  req: BrustRequest
}

export interface ErrorBoundaryProps {
  error: Error
}

export interface RouteCacheConfig {
  /** Time-to-live in seconds. */
  ttl_seconds: number
  /** Request headers that affect content. Each becomes part of the cache key. */
  vary?: string[]
}

/** Shape returned by a middleware or by the terminal `next()` (loader + render).
 * Middleware can short-circuit by returning a RouteResponse without calling next,
 * or call next() and mutate the returned response (status, headers). */
export interface RouteResponse {
  status: number
  body: string
  /** Extra response headers. Names are case-insensitive on the wire; Rust
   * deduplicates by lower-casing internally. Skips collisions with the fixed
   * Content-Type / Content-Length / Connection lines. */
  headers?: Record<string, string>
}

/** Middleware contract — Express/Koa-style chain. Receives a structured
 * request and a `next()` that runs the rest of the chain (eventually the
 * loader + render). Return a `RouteResponse` to short-circuit, or call
 * `await next()` and return its (possibly mutated) result. */
export type Middleware = (
  req: BrustRequest,
  next: () => Promise<RouteResponse>,
) => Promise<RouteResponse>

export interface Route<Params = Record<string, string>, Data = unknown> {
  /** matchit syntax — use `/blog/{slug}` for parameters (NOT Express-style `:slug`). */
  path: string
  Component: ComponentType<RouteContext<Params, Data>>
  /** Optional async function that runs in the worker before rendering. Its
   * return value becomes the component's `data` prop. Exceptions are caught
   * by `errorBoundary` if declared. */
  loader?: (ctx: { params: Params; path: string; req: BrustRequest }) => Promise<Data>
  /** Optional component invoked when Component or loader throws. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Opt-in cache. Omit for no caching (default for authed/personalised routes). */
  cache?: RouteCacheConfig
  /** Per-route middleware chain. Runs in declaration order; each middleware
   * wraps the next. Cache lookup happens BEFORE middleware runs — cached
   * responses skip the chain entirely. */
  middleware?: Middleware[]
}

/** Identity helper that pins the `routes` array's element type for the IDE
 * and ensures route_ids are stable across worker reloads (they = array index).
 */
export function defineRoutes(routes: Route[]): Route[] {
  return routes
}

/** Wire-level shape of the JSON envelope produced by Rust `routes::match_path`.
 * Keep this struct in sync with src/routes.rs::RouteEnvelope.
 */
export interface RouteCall {
  route_id: number
  path: string
  params: Record<string, string>
  req: BrustRequest
}
```

- [ ] **Step 2: Update re-exports in `runtime/index.ts`**

Replace lines 71-72 of `runtime/index.ts`:

```ts
export { defineRoutes, makeRenderer } from './routes.ts'
export type { Route, RouteCall, RouteContext, ErrorBoundaryProps, RouteCacheConfig } from './routes.ts'
```

with:

```ts
export { defineRoutes, makeRenderer } from './routes.ts'
export type {
  Route,
  RouteCall,
  RouteContext,
  ErrorBoundaryProps,
  RouteCacheConfig,
  BrustRequest,
  RouteResponse,
  Middleware,
} from './routes.ts'
```

- [ ] **Step 3: Type-check (no runtime change yet)**

Run: `cd runtime && bun run build:debug && cd -`
Expected: build succeeds. `makeRenderer` does not yet consume the new types — it will be rewritten in Task 5.

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): add BrustRequest, RouteResponse, Middleware types

Type-only commit. makeRenderer still produces the old wire format; the
chain composition + envelope upgrade lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite `makeRenderer` — middleware chain + meta JSON envelope

**Files:**
- Modify: `runtime/routes.ts:65-112` (the `makeRenderer` function)

This is the load-bearing TS change. After this task lands, the existing integration tests should pass again.

- [ ] **Step 1: Replace the `makeRenderer` function**

Replace lines 65-112 of `runtime/routes.ts` (everything from `export function makeRenderer` to the closing brace, including the docstring above) with:

```ts
/**
 * Build a render callback for a given routes table. The returned function is
 * what gets passed to `brust.registerRenderer(view, fn)` on the worker side.
 *
 * Wire format written to the SAB: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
 * meta = { status: number, headers?: Record<string, string> }.
 */
export interface MakeRendererOptions {
  /** Lazy getter for the Bun Worker id. Called per-render so the value can be
   * resolved after `registerRenderer` returns. Returns null before that. */
  getWorkerId?: () => number | null
}

export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byId = new Map<number, Route>()
  routes.forEach((r, i) => byId.set(i, r))

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall
    const route = byId.get(call.route_id)
    if (!route) {
      console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
      return 0
    }

    const workerId = opts.getWorkerId ? opts.getWorkerId() : null

    // Terminal `next()` — runs loader (if any), then renderToString. Wraps both
    // in a try/catch so errorBoundary catches both loader and render exceptions.
    const terminal = async (): Promise<RouteResponse> => {
      try {
        const data = route.loader
          ? await route.loader({ params: call.params, path: call.path, req: call.req })
          : undefined
        const html = renderToString(
          createElement(route.Component, {
            params: call.params,
            path: call.path,
            data,
            workerId,
            req: call.req,
          }),
        )
        return { status: 200, body: html }
      } catch (renderErr) {
        if (!route.errorBoundary) throw renderErr
        const boundary: ReactNode = createElement(route.errorBoundary, {
          error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
        })
        const html = renderToString(boundary as any)
        return { status: 500, body: html }
      }
    }

    // Compose middleware chain right-to-left so the first entry runs outermost.
    // Each link calls the next via `next()`; returning without calling next()
    // short-circuits the chain.
    let chain = terminal
    if (route.middleware && route.middleware.length > 0) {
      for (let i = route.middleware.length - 1; i >= 0; i--) {
        const mw = route.middleware[i]
        const next = chain
        chain = () => mw(call.req, next)
      }
    }

    let response: RouteResponse
    try {
      response = await chain()
    } catch (err) {
      // A middleware (or terminal without errorBoundary) raised. Render as 500
      // text/plain inside the envelope so the wire response is still valid.
      console.error(`[brust] middleware/render uncaught:`, err)
      response = {
        status: 500,
        body: 'internal error',
      }
    }

    // Pack the meta JSON envelope: [meta_len u16 BE][meta JSON][body].
    const meta = response.headers
      ? { status: response.status, headers: response.headers }
      : { status: response.status }
    const metaBytes = encoder.encode(JSON.stringify(meta))
    if (metaBytes.length > 0xffff) {
      console.error(`[brust] meta too large: ${metaBytes.length} bytes`)
      return 0
    }
    if (2 + metaBytes.length + 1 > view.length) {
      console.error(`[brust] envelope > SAB capacity`)
      return 0
    }
    view[0] = (metaBytes.length >> 8) & 0xff
    view[1] = metaBytes.length & 0xff
    view.set(metaBytes, 2)
    const bodyView = view.subarray(2 + metaBytes.length)
    const { written } = encoder.encodeInto(response.body, bodyView)
    if (written === undefined) return 0
    return 2 + metaBytes.length + written
  }
}
```

- [ ] **Step 2: Rebuild the .node and run the existing test suite**

Run:
```bash
cd runtime && bun run build:debug && cd -
bun run test
```

Expected: **All 8 tests pass.** The wire format upgrade is transparent to existing tests because:
- The cache hit test (`/cache-test`) still receives identical responses
- The errorBoundary test still gets 500 (now via `meta.status = 500`)
- 414/404 tests don't go through the worker
- TOML/routing tests work because the envelope shape changes underneath unchanged behavior

If any test fails, inspect the new SAB layout: the first two bytes are now meta_len, not status. Rust must read meta JSON between bytes 2 and 2+meta_len, body starts at 2+meta_len.

- [ ] **Step 3: Commit**

```bash
git add runtime/routes.ts
git commit -m "$(cat <<'EOF'
feat(runtime): makeRenderer composes per-route middleware chain

- SAB envelope upgraded to [meta_len u16 BE][meta JSON][body].
- Middleware runs in declaration order around loader+render. Short-circuit
  by returning a RouteResponse without calling next(). Mutate headers/status
  by calling next() and modifying the returned object.
- errorBoundary remains the catch for loader/render exceptions; uncaught
  middleware errors collapse to a plain-text 500.
- Loader now receives req in its ctx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Example app — auth middleware + header-mutation routes

**Files:**
- Create: `example/hello-world/components/Protected.tsx`
- Create: `example/hello-world/components/WithHeader.tsx`
- Modify: `example/hello-world/routes.tsx`

- [ ] **Step 1: Create `example/hello-world/components/Protected.tsx`**

```tsx
import type { RouteContext } from '../../../runtime/routes.ts'

export default function Protected({ req }: RouteContext) {
  const user = req.cookies['user'] ?? 'unknown'
  return (
    <html>
      <body>
        <h1>Protected</h1>
        <p>signed in as {user}</p>
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Create `example/hello-world/components/WithHeader.tsx`**

```tsx
import type { RouteContext } from '../../../runtime/routes.ts'

export default function WithHeader({ req }: RouteContext) {
  const sp = req.search['name'] ?? 'world'
  return (
    <html>
      <body>
        <h1>Hello, {sp}</h1>
        <p>see x-render-ms response header</p>
      </body>
    </html>
  )
}
```

- [ ] **Step 3: Update `example/hello-world/routes.tsx`**

Replace the file with:

```tsx
import { defineRoutes, type Middleware } from '../../runtime/routes.ts'
import HelloWorld    from './components/HelloWorld'
import BlogPost      from './components/BlogPost'
import Crash         from './components/Crash'
import CrashBoundary from './components/CrashBoundary'
import CacheTest     from './components/CacheTest'
import Protected     from './components/Protected'
import WithHeader    from './components/WithHeader'

// Auth middleware: 401 short-circuit if no `user` cookie.
const authRequired: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return {
      status: 401,
      body: 'unauthorised',
      headers: { 'WWW-Authenticate': 'Cookie' },
    }
  }
  return next()
}

// Header-mutation middleware: measure render time + tag the response.
const timeIt: Middleware = async (req, next) => {
  const t0 = Date.now()
  const res = await next()
  res.headers = { ...(res.headers ?? {}), 'x-render-ms': String(Date.now() - t0) }
  return res
}

export const routes = defineRoutes([
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
  { path: '/protected',    Component: Protected,    middleware: [authRequired] },
  { path: '/with-header',  Component: WithHeader,   middleware: [timeIt] },
])
```

- [ ] **Step 4: Rebuild + sanity check**

Run:
```bash
cd runtime && bun run build:debug && cd -
bun run test
```

Expected: All 8 existing tests still pass. New tests come in Task 7.

- [ ] **Step 5: Commit**

```bash
git add example/hello-world/components/Protected.tsx \
        example/hello-world/components/WithHeader.tsx \
        example/hello-world/routes.tsx
git commit -m "$(cat <<'EOF'
feat(example): add /protected and /with-header routes demonstrating middleware

- /protected — authRequired middleware short-circuits with 401 when no
  `user` cookie. On pass, Component reads cookie + greets.
- /with-header — timeIt middleware measures render duration and writes
  x-render-ms response header.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Integration tests — middleware behavior

**Files:**
- Modify: `tests/integration.test.ts` (append 4 new tests at the end, before the `readPortLine` helper)

- [ ] **Step 1: Append the four new tests to `tests/integration.test.ts`**

Add these 4 tests at the end of the file, immediately before the `async function readPortLine(...)` line:

```ts
test('middleware short-circuits with 401 when cookie missing', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38161', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/protected`)
    expect(r.status).toBe(401)
    expect(await r.text()).toBe('unauthorised')
    expect(r.headers.get('www-authenticate')).toBe('Cookie')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware lets request through when cookie present + req.cookies reaches component', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38162', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      headers: { cookie: 'user=alice; sid=xyz' },
    })
    expect(r.status).toBe(200)
    const body = await r.text()
    expect(body).toContain('signed in as alice')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('middleware injects x-render-ms response header + req.search reaches component', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38163', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/with-header?name=brust`)
    expect(r.status).toBe(200)
    const ms = r.headers.get('x-render-ms')
    expect(ms).not.toBeNull()
    expect(Number(ms)).toBeGreaterThanOrEqual(0)
    const body = await r.text()
    expect(body).toContain('Hello, brust')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('errorBoundary still returns 500 under the new envelope', async () => {
  // Repeats the /crash test under the new wire format to make the regression
  // path explicit. Status now flows through meta.status rather than the
  // legacy 2-byte prefix.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38164', BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/crash`)
    expect(r.status).toBe(500)
    const body = await r.text()
    expect(body).toContain('CrashBoundary')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)
```

- [ ] **Step 2: Run the full test suite**

Run: `bun run test`
Expected: **12 tests pass** (8 existing + 4 new). 0 fail.

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): cover middleware short-circuit, header mutation, req shape

- 401 short-circuit when authRequired sees no cookie
- req.cookies reaches component when authRequired calls next()
- timeIt middleware mutates response with x-render-ms header
- req.search['name'] reaches component
- errorBoundary still returns 500 under the new meta envelope

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update `architecture.md` — Middleware ships

**Files:**
- Modify: `architecture.md` (Middleware section + Built/Designed-not-built lists)

- [ ] **Step 1: Update the Middleware section status flag**

In `architecture.md`, find the block around lines 638-644:

```
**Mechanism gap (partially closed):** the tsfn signature still returns
`u32` (total bytes), but the SAB layout is now `[status: u16 BE][body]` —
Rust reads the prefix and uses it when calling `build_response`. This
unlocks status-side middleware (errorBoundary returns 500 today). Response
header mutation still has no channel — the follow-up extends the prefix to
`[meta_len: u16][meta JSON][body]` carrying a `{status, headers}` struct,
and lands alongside TS-side `(req, next) => res` composition.
```

Replace it with:

```
**Mechanism (shipped):** SAB layout is `[meta_len: u16 BE][meta JSON][body]`
where `meta = {status, headers?}`. Workers compose per-route middleware
via `(req, next) => Promise<RouteResponse>`; the chain wraps loader +
render. Middleware can short-circuit (return early) or call `next()` and
mutate the returned response. Cached responses skip the chain entirely —
cache lookup is keyed on path+query+vary headers and replays the full
wire response. Global `app/middleware.ts` and header *deletion* are
deferred follow-ups.
```

- [ ] **Step 2: Move "Middleware" from Designed-not-built to Built**

Find the Designed-not-built list (around line 959). Remove the first bullet:

```
- Middleware: response header mutation channel + TS-side composition (per-route + global, short-circuit on `Response`)
```

Find the Built list earlier (around line 320-340 area — look for the "Built" / "Shipped" surface). Add a line:

```
- ✅ Per-route middleware (`(req, next) => RouteResponse`) — short-circuit + response header mutation; SAB envelope is `[meta_len u16][meta JSON][body]`; loaders receive `req` in their ctx.
```

(If the section uses a different formatting convention, follow that — but the substance is: middleware moves from "designed" to "built", and a new entry under Built reflects that req+meta envelope shipped.)

- [ ] **Step 3: Verify build + tests still pass on the final tree**

Run:
```bash
cargo build
cd runtime && bun run build:debug && cd -
bun run test
```

Expected: cargo clean (1 pre-existing `io::other` warning is OK), 12 tests pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): middleware + header mutation shipped

- Mechanism gap closed: SAB envelope = [meta_len u16][meta JSON][body],
  meta = {status, headers?}.
- Per-route middleware chain documented as built. Global middleware +
  header deletion remain follow-ups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verification checklist

Run all three before considering the plan complete:

```bash
cargo build                                    # clean, 1 pre-existing warning OK
cd runtime && bun run build:debug && cd -      # rebuild .node
bun run test                                   # 12 pass, 0 fail
```

For interactive sanity:

```bash
bun run dev                                    # boots on :3000
curl -i http://127.0.0.1:3000/protected                                       # 401 + WWW-Authenticate
curl -i -H 'Cookie: user=alice' http://127.0.0.1:3000/protected               # 200 + "signed in as alice"
curl -i 'http://127.0.0.1:3000/with-header?name=brust'                        # 200 + x-render-ms header
curl -i http://127.0.0.1:3000/crash                                           # 500 via errorBoundary
curl -i http://127.0.0.1:3000/                                                # 200 (HelloWorld)
```

---

## Risks / caveats

1. **Meta JSON adds ~50-200 bytes per render call** — encoded JSON for `{status:200}` is 14 bytes; with headers it grows. This is cost on the worker→Rust hot path (encoding) and Rust→builder hot path (deserialize). Re-benchmark after this lands; if the SSR RPS drops more than 5%, evaluate a binary frame replacement (planned as a future optimisation).

2. **Header de-duplication is a one-way override** — middleware-supplied headers override server defaults except for the fixed `Content-Type`, `Content-Length`, `Connection` triple. Names with mixed case will appear on the wire exactly as the middleware wrote them; HTTP/1.1 is case-insensitive so clients handle it, but log scrapers should normalise.

3. **Cache-and-middleware ordering** — cache lookup happens *before* middleware runs. So a route that uses middleware to set per-request response headers (e.g. `x-request-id`) and is also `cache: { ... }` will replay the *first* renderer's headers on every hit. This is the intended semantic (cache replays bytes), but apps should not combine personalising middleware with route-level caching.

4. **httparse 64-header ceiling carries over** — headers beyond the 64th are silently dropped from `req.headers`. This matches the existing cache-vary path and is documented in `architecture.md`.

5. **Cookie parser is permissive** — splits on `;`, strips whitespace, accepts the first `=` as separator. Empty cookie names are dropped. No attempt to decode `%XX` (browsers don't percent-encode cookie values).

6. **`url_decode` is minimal** — handles `%xx` and `+` → space. Does not Unicode-normalise. Sufficient for ASCII query strings; apps using non-ASCII should re-decode TS-side if they care about NFC vs NFD.

---

*End of plan.*
