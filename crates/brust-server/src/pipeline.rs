//! The request pipeline (spec §4 S7): replaces 0.1.x `handle_request`
//! (`server/mod.rs:447-833`) and the per-page work the Bun worker used to do.
//!
//! Order: method gate → `/ping`, `/_brust/cache/stats`, static files → route
//! match → L1 decision (carried from `server/mod.rs:710-808`) → loader call →
//! job keys / job cache / one batched `jobs` call → child slots + `useId` →
//! leaf-first render → asset tags → L1 store of the JSON context.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use http::{HeaderMap, Request, Response};
use hyper::body::Incoming;
use serde_json::{Map, Value};

use crate::cache::job_cache::JobKey;
use crate::cache::key_expr::EvalCtx;
use crate::cache::l1::{CacheKey, build_cache_key};
use crate::config::Server;
use crate::dispatch::{CallError, CallKind, call_worker};
use crate::inputs::{self, Path};
use crate::manifest::{ALL_PROPS, Instances, JobKind, JobRecord, Manifest, RouteRecord};
use crate::protocol::{JobCall, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse, Verdict};
use crate::render::{RenderError, inject_assets, use_ids};
use crate::routing::{MatchResult, RouteEnvelope};
use crate::server::body::{self, ResponseBody, empty_body};
use crate::server::header_str;
use crate::server::static_assets::{
    asset_lookup_key, content_type_for, is_safe_css_filename, is_safe_island_filename,
    static_asset_response,
};

/// L1 outcome of a page request, for the `x-brust-cache` header and the log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheOutcome {
    Hit,
    Miss,
    Bypass,
    /// The route has no `cache`.
    None,
}

impl std::fmt::Display for CacheOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Hit => "HIT",
            Self::Miss => "MISS",
            Self::Bypass => "BYPASS",
            Self::None => "-",
        })
    }
}

/// What the per-request log line needs from the page branch.
pub(crate) struct PageMeta {
    pub route: String,
    pub cache: CacheOutcome,
    pub bun_calls: u8,
}

/// Immutable `Cache-Control` for content-hashed static files.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub(crate) async fn handle(req: Request<Incoming>, s: Arc<Server>) -> Response<ResponseBody> {
    let (parts, _body) = req.into_parts();
    let method = parts.method.as_str();
    let full = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| parts.uri.path());
    let path_only = full.split('?').next().unwrap_or(full);
    let headers = &parts.headers;

    // ----- CORS preflight (carried from server/mod.rs:484-501) -----
    // OPTIONS + Origin + Access-Control-Request-Method + allowed origin →
    // answered here with a full 204, BEFORE the method gate would 405 it.
    if method == "OPTIONS"
        && let Some(c) = &s.cors_resolved
        && let Some(origin) = headers.get(http::header::ORIGIN)
        && headers.contains_key(http::header::ACCESS_CONTROL_REQUEST_METHOD)
        && let Some(acao) = c.allow_origin_value(origin)
    {
        return c.preflight_response(acao, headers);
    }

    let head = method == "HEAD";
    if !(method == "GET" || head) {
        return body::error_405();
    }
    if path_only == "/ping" {
        tracing::debug!(target: "brust::request", path = path_only, status = 200u16, "ping");
        return body::resp(200, "text/plain", &[], b"pong\n".to_vec());
    }
    if path_only == "/_brust/cache/stats" {
        tracing::debug!(target: "brust::request", path = path_only, status = 200u16, "stats");
        let json = serde_json::to_vec(&s.stats()).unwrap_or_else(|_| b"{}".to_vec());
        return body::resp(200, "application/json", &[], json);
    }
    let static_root = if let Some(rel) = path_only.strip_prefix("/_brust/") {
        Some((StaticRoot::Brust, rel))
    } else {
        path_only
            .strip_prefix("/public/")
            .map(|rel| (StaticRoot::Public, rel))
    };
    if let Some((root, rel)) = static_root {
        let resp = static_file(&s, root, rel, headers, head).await;
        tracing::debug!(
            target: "brust::request",
            path = path_only,
            status = resp.status().as_u16(),
            "static"
        );
        return resp;
    }

    let t0 = std::time::Instant::now();
    let mut meta = PageMeta {
        route: "-".into(),
        cache: CacheOutcome::None,
        bun_calls: 0,
    };
    let resp = page(&s, full, headers, &mut meta).await;
    tracing::info!(
        target: "brust::request",
        route = %meta.route,
        status = resp.status().as_u16(),
        cache = %meta.cache,
        bun_calls = meta.bun_calls,
        dur_ms = t0.elapsed().as_secs_f64() * 1e3,
        "request"
    );
    if head {
        // RFC 9110 §9.3.2: a HEAD carries the GET's Content-Length. Page bodies
        // are fully buffered, so the size hint is exact.
        let len = http_body::Body::size_hint(resp.body()).exact();
        let (mut p, _) = resp.into_parts();
        if let Some(n) = len {
            p.headers.insert(http::header::CONTENT_LENGTH, n.into());
        }
        return Response::from_parts(p, empty_body());
    }
    resp
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StaticRoot {
    /// `/_brust/<rel>` → `dist/<rel>`, restricted to `client/` chunks.
    Brust,
    /// `/public/<rel>` → `dist/public/<rel>`.
    Public,
}

/// Validate a static `rel` path (already percent-decoded). Every segment is
/// non-empty, does not start with `.` (so no `.`/`..`/dotfiles) and holds only
/// `[A-Za-z0-9_.-]`. Under `/_brust/` only `client/<file>.js|.css` is served:
/// the dist root also holds `manifest.json`, `jobs.js` (server-side) and
/// `jinja/`, none of which may leave the server.
fn safe_rel(rel: &str, root: StaticRoot) -> Option<&str> {
    let segs: Vec<&str> = rel.split('/').collect();
    let seg_ok = |s: &&str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    if !segs.iter().all(seg_ok) {
        return None;
    }
    if root == StaticRoot::Brust {
        let [dir, file] = segs.as_slice() else {
            return None;
        };
        if *dir != "client" || !(is_safe_island_filename(file) || is_safe_css_filename(file)) {
            return None;
        }
    }
    Some(rel)
}

/// `<stem>` ends in `-<hex6+>` (lowercase) holding at least one digit: a
/// content-hashed file name. The digit rule keeps English words spelt in hex
/// letters (`brand-facade.css`, `-decade`) from being marked immutable.
fn is_hashed(file: &std::path::Path) -> bool {
    let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    match stem.rsplit_once('-') {
        Some((_, h)) => {
            h.len() >= 6
                && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                && h.bytes().any(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

/// `file` resolved through every symlink still lies under `root` (resolved
/// too: `dist/` itself may sit behind a symlink). A symlink under `dist/` that
/// points outside the served directory, or a missing file, is `false`.
async fn inside_root(root: &std::path::Path, file: &std::path::Path) -> bool {
    let (Ok(root), Ok(file)) = (
        tokio::fs::canonicalize(root).await,
        tokio::fs::canonicalize(file).await,
    ) else {
        return false;
    };
    file.starts_with(&root) && file != root
}

async fn static_file(
    s: &Server,
    root: StaticRoot,
    rel: &str,
    headers: &HeaderMap,
    head: bool,
) -> Response<ResponseBody> {
    let decoded = asset_lookup_key(rel);
    let Some(rel) = safe_rel(&decoded, root) else {
        return body::error_404();
    };
    // `/_brust/` only serves `client/<file>` (see `safe_rel`), so its root is
    // `dist/client`.
    let served = match root {
        StaticRoot::Brust => s.dist_dir.join("client"),
        StaticRoot::Public => s.dist_dir.join("public"),
    };
    let file = match root {
        StaticRoot::Brust => s.dist_dir.join(rel),
        StaticRoot::Public => served.join(rel),
    };
    if !inside_root(&served, &file).await {
        return body::error_404();
    }
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return body::error_404();
    };
    let accept_enc = header_str(headers, "accept-encoding").unwrap_or_default();
    let mut resp = static_asset_response(
        &accept_enc,
        content_type_for(&file),
        &file.to_string_lossy(),
        bytes,
        head,
        false,
    );
    if is_hashed(&file) {
        resp.headers_mut().insert(
            http::header::CACHE_CONTROL,
            http::HeaderValue::from_static(IMMUTABLE),
        );
    }
    resp.headers_mut().insert(
        http::header::X_CONTENT_TYPE_OPTIONS,
        http::HeaderValue::from_static("nosniff"),
    );
    resp
}

// ----------------------------------------------------------------------------
// page path
// ----------------------------------------------------------------------------

async fn page(
    s: &Server,
    full: &str,
    headers: &HeaderMap,
    meta: &mut PageMeta,
) -> Response<ResponseBody> {
    // Pages are GET; a HEAD runs the same path (and shares its L1 entries).
    let (route_id, envelope, status) = match s.routes.match_path("GET", full, headers) {
        MatchResult::Matched { route_id, envelope } => (route_id, envelope, 200u16),
        MatchResult::NotFound { route_id, envelope } => (route_id, envelope, 404),
        MatchResult::NoMatch => return body::error_404(),
    };
    let route = &s.manifest.routes[s.routes.route_index(route_id)];
    meta.route = route.id.clone();
    let accept_enc = header_str(headers, "accept-encoding");
    let accept_enc = accept_enc.as_deref();

    // ----- (3) L1 -----
    let (cache_key, outcome) = l1_decision(s, route_id, route, full, headers, &envelope);
    meta.cache = outcome;
    if let Some(k) = &cache_key
        && let Some(hit) = s.l1.get(k)
    {
        meta.cache = CacheOutcome::Hit;
        return finish(
            s,
            route,
            &hit.ctx,
            200,
            hit.headers.to_vec(),
            accept_enc,
            Some("HIT"),
        )
        .unwrap_or_else(|e| render_failed(route, &e));
    }

    // ----- (4) loader -----
    let path_only = full.split('?').next().unwrap_or(full);
    let params: BTreeMap<String, String> = envelope
        .params
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let mut ctx = Map::new();
    ctx.insert(
        "params".into(),
        serde_json::to_value(&params).unwrap_or_default(),
    );
    ctx.insert("path".into(), Value::String(path_only.to_string()));
    let mut status = status;
    let mut cacheable = true;
    let mut extra: Vec<(String, String)> = Vec::new();
    if !route.loaders.is_empty() {
        let req = LoaderRequest {
            route_id: &route.id,
            params,
            path: path_only,
            req: envelope.req,
        };
        let r = call_worker::<_, LoaderResponse>(
            &s.pool,
            s.claim_timeout,
            s.call_timeout,
            CallKind::Loader,
            &req,
        )
        .await;
        if !matches!(r, Err(CallError::NoWorkers | CallError::Timeout)) {
            s.loader_calls.fetch_add(1, Ordering::Relaxed);
            meta.bun_calls += 1;
        }
        match r {
            Ok(LoaderResponse::Ok {
                ok: true,
                data,
                headers,
            }) => {
                merge_loader_data(&mut ctx, data, &route.id);
                for (k, v) in headers {
                    if k.eq_ignore_ascii_case("set-cookie") {
                        cacheable = false;
                    }
                    extra.push((k, v));
                }
            }
            Ok(LoaderResponse::Ok { ok: false, .. }) => {
                tracing::error!(route = %route.id, "loader returned ok: false");
                return body::error_500();
            }
            Ok(LoaderResponse::Verdict(Verdict::NotFound { data })) => {
                merge_loader_data(&mut ctx, data, &route.id);
                status = 404;
                cacheable = false;
            }
            Ok(LoaderResponse::Verdict(Verdict::Redirect { location, status })) => {
                // A Location `resp` would silently drop (control characters)
                // must not become a redirect without a target.
                let Some(location) = location_header(&location) else {
                    tracing::error!(route = %route.id, ?location, "redirect location is not a valid header value");
                    return body::error_500();
                };
                let status = if (300..=308).contains(&status) {
                    status
                } else {
                    tracing::warn!(route = %route.id, status, "redirect status outside 300-308; using 302");
                    302
                };
                return body::resp(
                    status,
                    "text/plain",
                    &[("Location".into(), location)],
                    Vec::new(),
                );
            }
            Ok(LoaderResponse::Verdict(Verdict::HttpError { status, body })) => {
                if !(400..=599).contains(&status) {
                    tracing::error!(route = %route.id, status, "httpError status outside 400-599");
                    return body::error_500();
                }
                return body::resp(status, "text/plain", &[], body.into_bytes());
            }
            Ok(LoaderResponse::Error { error }) => {
                tracing::error!(route = %route.id, %error, "loader threw");
                return body::error_500();
            }
            Err(e @ (CallError::NoWorkers | CallError::Timeout)) => {
                return body::error_503(&e.to_string());
            }
            Err(CallError::Deadline) => {
                s.timed_out_calls.fetch_add(1, Ordering::Relaxed);
                return body::error_504("call deadline exceeded");
            }
            Err(e) => {
                tracing::error!(route = %route.id, error = %e, "loader call failed");
                return body::error_500();
            }
        }
    }
    let mut ctx = Value::Object(ctx);

    // ----- (5) jobs -----
    let plans = match collect_jobs(&s.manifest, &route.chain, &ctx) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(route = %route.id, error = %e, "job planning failed");
            return body::error_500();
        }
    };
    let mut values: Vec<Option<Arc<Value>>> = plans.iter().map(|p| s.jobs.get(&p.key)).collect();
    // Plans sharing a JobKey (e.g. two identical rows) are one computation:
    // `owner[i]` is the first missing plan with plan i's key; only owners are
    // sent to the worker, and each value is fanned out to every plan sharing it.
    let mut owner: Vec<usize> = (0..plans.len()).collect();
    let mut misses: Vec<usize> = Vec::new();
    {
        let mut first: HashMap<&JobKey, usize> = HashMap::new();
        for i in (0..plans.len()).filter(|&i| values[i].is_none()) {
            match first.get(&plans[i].key) {
                Some(&o) => owner[i] = o,
                None => {
                    first.insert(&plans[i].key, i);
                    misses.push(i);
                }
            }
        }
    }
    if !misses.is_empty() {
        let req = JobsRequest {
            jobs: misses
                .iter()
                .map(|&i| JobCall {
                    id: plans[i].call_id.clone(),
                    component_id: plans[i].component_id.clone(),
                    kind: plans[i].kind,
                    inputs: plans[i].inputs.clone(),
                    target: plans[i].target.clone(),
                    row: plans[i].instance_row(),
                })
                .collect(),
        };
        let r = call_worker::<_, JobsResponse>(
            &s.pool,
            s.claim_timeout,
            s.call_timeout,
            CallKind::Jobs,
            &req,
        )
        .await;
        if !matches!(r, Err(CallError::NoWorkers | CallError::Timeout)) {
            s.job_calls.fetch_add(1, Ordering::Relaxed);
            meta.bun_calls += 1;
        }
        let resp = match r {
            Ok(r) => r,
            Err(e @ (CallError::NoWorkers | CallError::Timeout)) => {
                return body::error_503(&e.to_string());
            }
            Err(CallError::Deadline) => {
                s.timed_out_calls.fetch_add(1, Ordering::Relaxed);
                return body::error_504("call deadline exceeded");
            }
            Err(e) => {
                tracing::error!(route = %route.id, error = %e, "jobs call failed");
                return body::error_500();
            }
        };
        // Validate every result before inserting any: one bad job fails the
        // request and nothing is cached. Log fields come from the plan the id
        // names (ids are opaque `<…>/<jobId>[/<row>]` strings, never parsed).
        let plan_of: HashMap<&str, &JobPlan> = misses
            .iter()
            .map(|&i| (plans[i].call_id.as_str(), &plans[i]))
            .collect();
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for res in resp.results {
            let (component_id, job_id) = plan_of
                .get(res.id.as_str())
                .map_or(("?", "?"), |p| (p.component_id.as_str(), p.job_id.as_str()));
            if let Some(error) = res.error {
                tracing::error!(route = %route.id, component_id, job_id, call_id = %res.id, %error, "job threw");
                return body::error_500();
            }
            let Some(value) = res.value else {
                tracing::error!(route = %route.id, component_id, job_id, call_id = %res.id, "job result has neither value nor error");
                return body::error_500();
            };
            by_id.insert(res.id, value);
        }
        let mut fresh = Vec::with_capacity(misses.len());
        for &i in &misses {
            let Some(v) = by_id.remove(&plans[i].call_id) else {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, "jobs response has no result for {}", plans[i].call_id);
                return body::error_500();
            };
            if let Err(e) = check_value(&plans[i], &v) {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, call_id = %plans[i].call_id, error = %e, "job result does not fit its outputs");
                return body::error_500();
            }
            fresh.push((i, Arc::new(v)));
        }
        for (i, v) in fresh {
            let p = &plans[i];
            s.jobs.insert(
                p.key.clone(),
                Arc::clone(&v),
                p.ttl,
                &p.tags,
                p.user_key.as_deref(),
            );
            values[i] = Some(v);
        }
        for i in 0..plans.len() {
            if values[i].is_none() {
                values[i] = values[owner[i]].clone();
            }
        }
    }

    // ----- (6) child slots + useId, then merge job values -----
    if let Err(e) = seed_child_slots(&s.manifest, &route.id, &route.chain, &mut ctx) {
        tracing::error!(route = %route.id, error = %e, "child slot seeding failed");
        return body::error_500();
    }
    if let Value::Object(map) = &mut ctx {
        for (p, v) in plans.iter().zip(&values) {
            if let Some(v) = v {
                merge_result(map, p, v);
            }
        }
    }

    // ----- (7) render, assets, L1 store -----
    let ctx = Arc::new(ctx);
    let hdr = match outcome {
        CacheOutcome::Miss => Some("MISS"),
        CacheOutcome::Bypass => Some("BYPASS"),
        _ => None,
    };
    let headers: Arc<[(String, String)]> = extra.into();
    let resp = match finish(s, route, &ctx, status, headers.to_vec(), accept_enc, hdr) {
        Ok(r) => r,
        Err(e) => return render_failed(route, &e),
    };
    if let Some(k) = cache_key
        && status == 200
        && cacheable
        && let Some(c) = &route.cache
    {
        // The loader's headers ride with the ctx so a HIT replays them.
        s.l1.insert(k, ctx, headers, Duration::from_secs(c.ttl_seconds), &c.tags);
    }
    resp
}

fn render_failed(route: &RouteRecord, e: &RenderError) -> Response<ResponseBody> {
    tracing::error!(route = %route.id, error = %e, "render failed");
    body::error_500()
}

/// Leaf-first render with each chain component's overlay (its `_idN`, its
/// own child-instance slots from `ctx["__children"][<id>]`, its own job
/// results from `ctx["__own"][<id>]`, and `_props`), asset tags,
/// optional gzip. Shared by the HIT and MISS paths so a HIT renders
/// byte-identically.
fn finish(
    s: &Server,
    route: &RouteRecord,
    ctx: &Value,
    status: u16,
    mut headers: Vec<(String, String)>,
    accept_enc: Option<&str>,
    cache_hdr: Option<&str>,
) -> Result<Response<ResponseBody>, RenderError> {
    let children = ctx.get(CHILDREN_KEY);
    let own_all = ctx.get(OWN_KEY);
    // `_props` (the island host's `x-props`): the merged loader context — params,
    // path, loader data — without the server's per-component maps. Built once,
    // shared by every chain component (minijinja `Value`s are `Arc`-backed).
    let props = brust_jinja::value_of(all_props(ctx));
    let overlay = |id: &str| {
        let slots = s.manifest.components.get(id).map_or(0, |c| c.use_id_slots);
        let mut out: Vec<(String, minijinja::Value)> = use_ids(&route.id, id, slots)
            .into_iter()
            .map(|(k, v)| (k, minijinja::Value::from(v)))
            .collect();
        for map in [children, own_all] {
            if let Some(Value::Object(own)) = map.and_then(|c| c.get(id)) {
                for (k, v) in own {
                    out.push((k.clone(), brust_jinja::value_of(v)));
                }
            }
        }
        out.push((PROPS_KEY.into(), props.clone()));
        out
    };
    let html = s.renderer.render_chain(&route.chain, ctx, &overlay)?;
    let mut bytes = inject_assets(html, &route.chain, &s.manifest).into_bytes();
    if let Some(h) = cache_hdr {
        headers.push(("x-brust-cache".into(), h.into()));
    }
    if bytes.len() >= 1024
        && crate::http::compress::accepts_gzip(accept_enc)
        && let Some(gz) = crate::http::compress::gzip(&bytes)
    {
        bytes = gz;
        headers.push(("Content-Encoding".into(), "gzip".into()));
        headers.push(("Vary".into(), "Accept-Encoding".into()));
    }
    Ok(body::resp(
        status,
        "text/html; charset=utf-8",
        &headers,
        bytes,
    ))
}

/// Reserved ctx key holding child-instance slots per parent component:
/// `ctx["__children"][<parentId>]` = `{ "__<childId>_<k>": cell(s),
/// "_ssr_<childId>": html }`. `k` is per parent template, so two parents
/// inlining the same child never share a slot; `render_chain` overlays a
/// parent's map only while rendering that parent.
const CHILDREN_KEY: &str = "__children";

/// Reserved ctx key holding each chain component's own job results:
/// `ctx["__own"][<componentId>]` = its precompute keys (`_s1`, …, numbered per
/// component, so a layout's `_s1` and its page's `_s1` differ) and its ssr
/// HTML at `_ssr_<componentId>`. Overlaid only while rendering that component.
const OWN_KEY: &str = "__own";

/// Overlay key: the merged loader context, printed by island hosts as
/// `x-props='{{ _props | json_attr }}'`.
const PROPS_KEY: &str = "_props";

/// Context names the server owns: templates print them with `| safe`
/// (`__outlet`, `_ssr_*`), read per-component maps through them
/// (`__children`, `__own`, `_props`), or read job/useId slots (`_s<digits>`,
/// `_id<digits>`, exactly). Any other name — `_id`, `_session`,
/// `__typename` — is the loader's. Overlays already beat the base context;
/// this is defence in depth.
fn is_server_slot(k: &str) -> bool {
    let numbered = |p: &str| {
        k.strip_prefix(p)
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
    };
    matches!(k, "__outlet" | CHILDREN_KEY | OWN_KEY | PROPS_KEY)
        || k.starts_with("_ssr_")
        || numbered("_s")
        || numbered("_id")
}

/// A redirect target as a `Location` value: non-ASCII characters are
/// percent-encoded as UTF-8 (`/café` → `/caf%C3%A9`); any control character
/// (CR, LF, NUL, DEL, …) is `None`, never a header.
fn location_header(location: &str) -> Option<String> {
    if location.chars().any(char::is_control) {
        return None;
    }
    let mut out = String::with_capacity(location.len());
    for c in location.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    http::HeaderValue::from_str(&out).ok().map(|_| out)
}

/// Merge loader `data` keys over `ctx` (data wins), dropping server slots.
fn merge_loader_data(ctx: &mut Map<String, Value>, data: Value, route: &str) {
    let Value::Object(o) = data else { return };
    for (k, v) in o {
        if is_server_slot(&k) {
            tracing::warn!(route, key = %k, "loader data key collides with a server slot; dropped");
            continue;
        }
        ctx.insert(k, v);
    }
}

// ----------------------------------------------------------------------------
// (3) L1 decision
// ----------------------------------------------------------------------------

/// Keep the LAST value per exact name, in first-seen name order: what the
/// loader's `JSON.parse` of the envelope's header/cookie/search objects sees.
fn last_wins<'a>(pairs: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut out: Vec<(&str, &str)> = Vec::with_capacity(pairs.len());
    for &(k, v) in pairs {
        match out.iter_mut().find(|(n, _)| *n == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    out
}

/// Two distinct names equal ignoring ASCII case: `key_expr`'s first-match,
/// case-insensitive lookup would pick one the loader may not.
fn ci_collision(pairs: &[(&str, &str)]) -> bool {
    pairs.iter().enumerate().any(|(i, (a, _))| {
        pairs[i + 1..]
            .iter()
            .any(|(b, _)| a.eq_ignore_ascii_case(b))
    })
}

/// Carried from `server/mod.rs:710-808`: assemble the borrowed request data,
/// evaluate `bypass` then `prefix`, build the L1 key. v2 additions (the key
/// must see what the loader sees): header/cookie lists collapse to the last
/// value per name; query names/values are the decoded `req.search`; a
/// case-insensitive name collision, or a query name repeated after decoding
/// (`sort_query` would merge orders the loader reads differently), bypasses L1.
fn l1_decision(
    s: &Server,
    route_id: u32,
    route: &RouteRecord,
    full: &str,
    headers: &HeaderMap,
    envelope: &RouteEnvelope<'_>,
) -> (Option<CacheKey>, CacheOutcome) {
    if route.cache.is_none() {
        return (None, CacheOutcome::None);
    }
    let method = "GET";
    let mut seen: HashSet<&str> = HashSet::new();
    if !envelope
        .req
        .search
        .iter()
        .all(|(k, _)| seen.insert(k.as_ref()))
    {
        return (None, CacheOutcome::Bypass);
    }
    let compiled = s.routes.compiled_cache_for(route_id);
    let Some(cc) = compiled.filter(|cc| cc.prefix.is_some() || cc.bypass.is_some()) else {
        // cache configured but no prefix/bypass exprs → default L1 key (no prefix).
        return (
            Some(build_cache_key(method, full, String::new())),
            CacheOutcome::Miss,
        );
    };
    // Header pairs (HeaderName is lowercase) + all cookies across every
    // Cookie header (build_request_envelope's parsing semantics).
    let mut header_pairs: Vec<(&str, &str)> = Vec::new();
    let mut cookie_pairs: Vec<(&str, &str)> = Vec::new();
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if n.is_empty() {
            continue;
        }
        let v = std::str::from_utf8(value.as_bytes()).unwrap_or("");
        if name == http::header::COOKIE {
            for pair in v.split(';') {
                if let Some((k, val)) = pair.trim().split_once('=') {
                    cookie_pairs.push((k.trim(), val.trim()));
                }
            }
        }
        header_pairs.push((n, v));
    }
    // Query pairs DECODED, exactly the loader's `req.search` (the envelope's
    // list): `?pre%76iew=1` is `preview`, `mode=dr%61ft` is `draft`. Names are
    // unique here (a repeat bypassed above). The CacheKey keeps the raw sorted
    // query: distinct raw spellings only split entries, never merge them.
    let query_pairs: Vec<(&str, &str)> = envelope
        .req
        .search
        .iter()
        .map(|(k, v)| (k.as_ref(), v.as_ref()))
        .collect();
    let header_pairs = last_wins(&header_pairs);
    let cookie_pairs = last_wins(&cookie_pairs);
    if ci_collision(&header_pairs) || ci_collision(&cookie_pairs) || ci_collision(&query_pairs) {
        return (None, CacheOutcome::Bypass);
    }
    let host = header_pairs
        .iter()
        .find(|(n, _)| *n == "host")
        .map_or("", |(_, v)| *v);
    let scheme = if s.tls.is_some() { "https" } else { "http" };
    let bare_path = full.split('?').next().unwrap_or(full);
    // Matched path params come straight off the envelope, so `param(id)` keys
    // an L1 entry per route param (decoded, as the loader sees them).
    let param_pairs: Vec<(&str, &str)> = envelope
        .params
        .iter()
        .map(|(k, v)| (k.as_ref(), v.as_ref()))
        .collect();
    let ctx = EvalCtx {
        headers: &header_pairs,
        cookies: &cookie_pairs,
        query: &query_pairs,
        params: &param_pairs,
        method,
        host,
        scheme,
        path: bare_path,
    };
    let bypass_hit = match &cc.bypass {
        None => false,
        Some(None) => true, // always
        Some(Some(expr)) => !expr.eval(&ctx).is_empty(),
    };
    if bypass_hit {
        return (None, CacheOutcome::Bypass); // skip L1 read AND write
    }
    let prefix = cc.prefix.as_ref().map(|e| e.eval(&ctx)).unwrap_or_default();
    (
        Some(build_cache_key(method, full, prefix)),
        CacheOutcome::Miss,
    )
}

// ----------------------------------------------------------------------------
// (5) job planning and merge
// ----------------------------------------------------------------------------

/// Where a job's value lands (S7 step 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Dest {
    /// The chain component's own overlay `ctx["__own"][<component>]`. `row`:
    /// a `per_instance` job's row; its value lands at `outputs[0][row]`.
    Chain {
        component: String,
        row: Option<usize>,
    },
    /// An inlined child instance's cell in its parent's map.
    Child {
        /// The chain component whose template inlines the child.
        parent: String,
        component: String,
        k: u32,
        row: Option<usize>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct JobPlan {
    pub key: JobKey,
    pub call_id: String,
    pub component_id: String,
    pub job_id: String,
    pub kind: JobKind,
    pub inputs: Value,
    pub ttl: Option<Duration>,
    pub tags: Vec<String>,
    /// The evaluated `cache({key})` value (string raw, else canonical JSON):
    /// what `invalidate({key})` addresses.
    pub user_key: Option<String>,
    pub dest: Dest,
    /// The manifest record's `outputs` (empty = legacy merge, see `merge_result`).
    pub outputs: Vec<String>,
    /// The manifest record's `target`, passed through as `JobCall.target`.
    pub target: Option<String>,
}

impl JobPlan {
    /// The `per_instance` row this call renders (`JobCall.row`).
    fn instance_row(&self) -> Option<usize> {
        match self.dest {
            Dest::Chain { row, .. } => row,
            Dest::Child { .. } => None,
        }
    }
}

/// `"*"` (all props): the props object without the server's per-component
/// maps — for a chain entry the merged loader context, i.e. exactly `_props`.
fn all_props(props: &Value) -> Value {
    match props {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| k.as_str() != CHILDREN_KEY && k.as_str() != OWN_KEY)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        v => v.clone(),
    }
}

/// What the worker receives as `inputs` (and the hashed key hashes): the
/// record's `props` map evaluated at `row` when set (the react target's own
/// props), else every props value when `inputs` holds `"*"`, else the
/// projection of `inputs`.
fn job_inputs(j: &JobRecord, props: &Value, row: Option<usize>) -> Result<Value, String> {
    if let Some(map) = &j.props {
        return inputs::child_props(props, map, row);
    }
    if j.inputs.iter().any(|i| i == ALL_PROPS) {
        return Ok(all_props(props));
    }
    inputs::project(props, &j.inputs, None)
}

/// Job cache key: `cache.key` evaluated against the props when set → the user
/// key (a string raw, any other non-null value canonical JSON), namespaced as
/// `"k:<componentId>/<keyJob>/<user key>"` so two components keyed on one value
/// never share an entry; unset or `null` → the hashed inputs key. `key_job`
/// is the job id, plus `#<row>` for a `per_instance` row whose inputs do not
/// identify the row on their own.
fn plan_key(
    cid: &str,
    key_job: &str,
    j: &JobRecord,
    props: &Value,
    projected: &Value,
) -> Result<(JobKey, Option<String>), String> {
    if let Some(expr) = &j.cache.key {
        let user = match Path::parse(expr)?.get(props, None) {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            v => Some(String::from_utf8(inputs::canonical(v)).expect("JSON is UTF-8")),
        };
        if let Some(u) = user {
            return Ok((JobKey(format!("k:{cid}/{key_job}/{u}")), Some(u)));
        }
    }
    Ok((JobKey(inputs::job_key(cid, key_job, projected)), None))
}

/// `call_id` = `<instance>/<jobId>[/<row>]`, where `instance` is the
/// component id for a chain job and `<parentId>/<childId>_<k>` for a child
/// instance — unique per request even when one child id is inlined more than
/// once (by one parent, or by several), and per row of a `per_instance` job.
fn plan_one(
    out: &mut Vec<JobPlan>,
    cid: &str,
    instance: &str,
    j: &JobRecord,
    props: &Value,
    dest: Dest,
    row: Option<usize>,
) -> Result<(), String> {
    let per_instance = match dest {
        Dest::Chain { row, .. } => row,
        Dest::Child { .. } => None,
    };
    let projected = job_inputs(j, props, per_instance)?;
    // With a `props` map each row's inputs are that row's props (content-keyed:
    // equal rows share an entry); otherwise every row projects the same
    // parent-scope inputs, so the row is part of the key.
    let key_job = match per_instance {
        Some(r) if j.props.is_none() || j.cache.key.is_some() => format!("{}#{r}", j.id),
        _ => j.id.clone(),
    };
    let (key, user_key) = plan_key(cid, &key_job, j, props, &projected)?;
    let call_id = match row {
        Some(r) => format!("{instance}/{}/{r}", j.id),
        None => format!("{instance}/{}", j.id),
    };
    out.push(JobPlan {
        key,
        call_id,
        component_id: cid.into(),
        job_id: j.id.clone(),
        kind: j.kind,
        inputs: projected,
        ttl: j.cache.ttl_seconds.map(Duration::from_secs),
        tags: j.cache.tags.clone(),
        user_key,
        dest,
        outputs: j.outputs.clone(),
        target: j.target.clone(),
    });
    Ok(())
}

/// Rows of a `per-row:<list>` instance group in `ctx`.
fn row_count(list: &str, ctx: &Value) -> Result<usize, String> {
    Ok(Path::parse(list)?
        .get(ctx, None)
        .as_array()
        .map_or(0, |a| a.len()))
}

/// Every job of the chain in template order: each chain component's own jobs
/// (a `per_instance` job once per row of its list), then its children's
/// (static: one instance; per-row: one per list row).
pub(crate) fn collect_jobs(
    m: &Manifest,
    chain: &[String],
    ctx: &Value,
) -> Result<Vec<JobPlan>, String> {
    let mut out = Vec::new();
    for id in chain {
        let c = &m.components[id];
        for j in &c.jobs {
            let dest = |row| Dest::Chain {
                component: id.clone(),
                row,
            };
            match &j.per_instance {
                None => plan_one(&mut out, id, id, j, ctx, dest(None), None)?,
                Some(list) => {
                    for r in 0..row_count(list, ctx)? {
                        plan_one(&mut out, id, id, j, ctx, dest(Some(r)), Some(r))?;
                    }
                }
            }
        }
        let mut ordinal: BTreeMap<&str, u32> = BTreeMap::new();
        for ch in &c.children {
            let k = {
                let e = ordinal.entry(ch.id.as_str()).or_insert(0);
                *e += 1;
                *e
            };
            let child = &m.components[&ch.id];
            let instance = format!("{id}/{}_{k}", ch.id);
            let target = |row| Dest::Child {
                parent: id.clone(),
                component: ch.id.clone(),
                k,
                row,
            };
            match &ch.instances {
                Instances::Static => {
                    let props = inputs::child_props(ctx, &ch.props, None)?;
                    for j in &child.jobs {
                        plan_one(&mut out, &ch.id, &instance, j, &props, target(None), None)?;
                    }
                }
                Instances::PerRow(list) => {
                    for r in 0..row_count(list, ctx)? {
                        let props = inputs::child_props(ctx, &ch.props, Some(r))?;
                        for j in &child.jobs {
                            plan_one(
                                &mut out,
                                &ch.id,
                                &instance,
                                j,
                                &props,
                                target(Some(r)),
                                Some(r),
                            )?;
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// The parent's child-slot map `ctx["__children"][<parent>]`, created on demand.
fn parent_slots<'a>(ctx: &'a mut Map<String, Value>, parent: &str) -> &'a mut Map<String, Value> {
    component_map(ctx, CHILDREN_KEY, parent)
}

/// `ctx[root][<id>]` as an object, created (or reset from a non-object) on demand.
fn component_map<'a>(
    ctx: &'a mut Map<String, Value>,
    root: &str,
    id: &str,
) -> &'a mut Map<String, Value> {
    let all = ctx.entry(root).or_insert_with(|| Value::Object(Map::new()));
    if !all.is_object() {
        *all = Value::Object(Map::new());
    }
    let Value::Object(all) = all else {
        unreachable!()
    };
    let own = all.entry(id).or_insert_with(|| Value::Object(Map::new()));
    if !own.is_object() {
        *own = Value::Object(Map::new());
    }
    let Value::Object(own) = own else {
        unreachable!()
    };
    own
}

/// S7 step 6 for children: `ctx["__children"][<parent>]["__<id>_<k>"]` = `{}`
/// (static) or one `{}` per row (per-row, so a row whose child has no jobs
/// still indexes), each carrying its instance's `_idN` (instance
/// `<parent>.<id>_<k>[-<row>]`). Runs before the L1 store, so a HIT
/// re-renders identical ids.
pub(crate) fn seed_child_slots(
    m: &Manifest,
    route_id: &str,
    chain: &[String],
    ctx: &mut Value,
) -> Result<(), String> {
    let cell = |instance: &str, slots: u32| {
        let mut o = Map::new();
        for (k, v) in use_ids(route_id, instance, slots) {
            o.insert(k, Value::String(v));
        }
        Value::Object(o)
    };
    let mut seeds: Vec<(&str, String, Value)> = Vec::new();
    for id in chain {
        let mut ordinal: BTreeMap<&str, u32> = BTreeMap::new();
        for ch in &m.components[id].children {
            let k = {
                let e = ordinal.entry(ch.id.as_str()).or_insert(0);
                *e += 1;
                *e
            };
            let slots = m.components[&ch.id].use_id_slots;
            let slot = match &ch.instances {
                Instances::Static => cell(&format!("{id}.{}_{k}", ch.id), slots),
                Instances::PerRow(list) => Value::Array(
                    (0..row_count(list, ctx)?)
                        .map(|r| cell(&format!("{id}.{}_{k}-{r}", ch.id), slots))
                        .collect(),
                ),
            };
            seeds.push((id, format!("__{}_{k}", ch.id), slot));
        }
    }
    if let Value::Object(map) = ctx {
        for (parent, key, slot) in seeds {
            parent_slots(map, parent).insert(key, slot);
        }
    }
    Ok(())
}

/// The cell of one child instance (`ctx["__children"][<parent>]["__<id>_<k>"]`,
/// or its `row` entry), created on demand.
fn child_cell<'a>(
    ctx: &'a mut Map<String, Value>,
    parent: &str,
    component: &str,
    k: u32,
    row: Option<usize>,
) -> Option<&'a mut Map<String, Value>> {
    let slot = parent_slots(ctx, parent)
        .entry(format!("__{component}_{k}"))
        .or_insert_with(|| {
            if row.is_some() {
                Value::Array(vec![])
            } else {
                Value::Object(Map::new())
            }
        });
    let cell = match row {
        Some(r) => {
            let a = slot.as_array_mut()?;
            while a.len() <= r {
                a.push(Value::Object(Map::new()));
            }
            &mut a[r]
        }
        None => slot,
    };
    cell.as_object_mut()
}

/// A value has the shape its `outputs` need: a precompute result is an object
/// holding every output name (`{ _s1: … }`, the generated `precompute`
/// returns it keyed by slot); an ssr result is an HTML string. Legacy plans
/// (no `outputs`) are not checked.
fn check_value(p: &JobPlan, v: &Value) -> Result<(), String> {
    if p.outputs.is_empty() {
        return Ok(());
    }
    match p.kind {
        JobKind::Precompute => {
            let o = v.as_object().ok_or("precompute result is not an object")?;
            match p.outputs.iter().find(|n| !o.contains_key(n.as_str())) {
                Some(n) => Err(format!("precompute result has no {n:?}")),
                None => Ok(()),
            }
        }
        JobKind::Ssr if v.is_string() => Ok(()),
        JobKind::Ssr => Err("ssr result is not a string".into()),
    }
}

/// Writes one job's value into the overlay its `dest` names (S7 step 5):
/// a chain component's `ctx["__own"][<id>]`, or a child instance's cell in
/// `ctx["__children"][<parent>]`. Output `k` gets result `k`: a precompute
/// result object's `outputs[k]` key, an ssr job's HTML at `outputs[0]`; for a
/// `per_instance` job, `outputs[0]` is an array indexed by row (the template
/// reads `{{ _ssr_<id>[_i1] | safe }}`). Without `outputs` (older manifests)
/// see [`merge_legacy`].
pub(crate) fn merge_result(ctx: &mut Map<String, Value>, plan: &JobPlan, value: &Value) {
    if plan.outputs.is_empty() {
        return merge_legacy(ctx, plan, value);
    }
    let row = plan.instance_row();
    let obj = match &plan.dest {
        Dest::Chain { component, .. } => component_map(ctx, OWN_KEY, component),
        Dest::Child {
            parent,
            component,
            k,
            row,
        } => match child_cell(ctx, parent, component, *k, *row) {
            Some(o) => o,
            None => return,
        },
    };
    for (i, name) in plan.outputs.iter().enumerate() {
        let v = match plan.kind {
            JobKind::Precompute => value.get(name).cloned().unwrap_or(Value::Null),
            JobKind::Ssr if i == 0 => value.clone(),
            JobKind::Ssr => continue,
        };
        match row {
            None => {
                obj.insert(name.clone(), v);
            }
            Some(r) => {
                let slot = obj
                    .entry(name.clone())
                    .or_insert_with(|| Value::Array(vec![]));
                if !slot.is_array() {
                    *slot = Value::Array(vec![]);
                }
                let Value::Array(a) = slot else {
                    unreachable!()
                };
                while a.len() <= r {
                    a.push(Value::Null);
                }
                a[r] = v;
            }
        }
    }
}

/// Manifests without `outputs`: a precompute result object is spread into the
/// overlay; a chain ssr result lands at `_ssr_<componentId>`; a child's ssr
/// result in its cell and (static instance) at `_ssr_<childId>` in the
/// parent's map.
fn merge_legacy(ctx: &mut Map<String, Value>, plan: &JobPlan, value: &Value) {
    fn spread(obj: &mut Map<String, Value>, value: &Value) {
        if let Some(o) = value.as_object() {
            for (k, v) in o {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    match &plan.dest {
        Dest::Chain { component, .. } => {
            let own = component_map(ctx, OWN_KEY, component);
            match plan.kind {
                JobKind::Precompute => spread(own, value),
                JobKind::Ssr => {
                    own.insert(format!("_ssr_{component}"), value.clone());
                }
            }
        }
        Dest::Child {
            parent,
            component,
            k,
            row,
        } => {
            if plan.kind == JobKind::Ssr && row.is_none() {
                parent_slots(ctx, parent).insert(format!("_ssr_{component}"), value.clone());
            }
            let Some(obj) = child_cell(ctx, parent, component, *k, *row) else {
                return;
            };
            match plan.kind {
                JobKind::Precompute => spread(obj, value),
                JobKind::Ssr => {
                    obj.insert(format!("_ssr_{component}"), value.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Manifest {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
        Manifest::load(&dir).expect("fixture manifest").manifest
    }

    fn chain(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn pikachu() -> Value {
        json!({"pokemon": {"name": "pikachu", "stats": {"hp": 35},
                "moves": [{"name": "tackle"}, {"name": "growl"}]}})
    }

    #[test]
    fn plan_lists_chain_jobs_then_child_rows_in_template_order() {
        let m = manifest();
        let plans =
            collect_jobs(&m, &chain(&["appLayout_a1", "detailPage_c3"]), &pikachu()).unwrap();
        let ids: Vec<&str> = plans.iter().map(|p| p.call_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "detailPage_c3/j0",
                "detailPage_c3/moveCard_d4_1/j0/0",
                "detailPage_c3/moveCard_d4_1/j0/1"
            ]
        );
        assert_eq!(plans[0].inputs, json!({"pokemon": {"stats": {"hp": 35}}}));
        assert_eq!(
            plans[0].dest,
            Dest::Chain {
                component: "detailPage_c3".into(),
                row: None
            }
        );
        assert_eq!(plans[2].inputs, json!({"move": {"name": "growl"}}));
        assert_eq!(
            plans[2].dest,
            Dest::Child {
                parent: "detailPage_c3".into(),
                component: "moveCard_d4".into(),
                k: 1,
                row: Some(1)
            }
        );
        assert_eq!(plans[2].ttl, Some(Duration::from_secs(30)));
        assert_eq!(plans[2].tags, ["moves"]);
        // Row keys depend on row content, not position.
        assert_ne!(plans[1].key, plans[2].key);
        assert_eq!(
            plans[1].key.0,
            inputs::job_key("moveCard_d4", "j0", &json!({"move": {"name": "tackle"}}))
        );
    }

    #[test]
    fn plan_uses_cache_key_expression_when_set() {
        let mut m = manifest();
        let key_of = |m: &Manifest| -> Vec<String> {
            collect_jobs(m, &chain(&["detailPage_c3"]), &pikachu())
                .unwrap()
                .into_iter()
                .skip(1)
                .map(|p| p.key.0)
                .collect()
        };
        let set = |m: &mut Manifest, k: Option<&str>| {
            m.components.get_mut("moveCard_d4").unwrap().jobs[0]
                .cache
                .key = k.map(String::from);
        };
        // A string value: raw.
        set(&mut m, Some("move.name"));
        assert_eq!(
            key_of(&m),
            ["k:moveCard_d4/j0/tackle", "k:moveCard_d4/j0/growl"]
        );
        // Any other non-null value: canonical JSON.
        set(&mut m, Some("props.move"));
        assert_eq!(
            key_of(&m),
            [
                r#"k:moveCard_d4/j0/{"name":"tackle"}"#,
                r#"k:moveCard_d4/j0/{"name":"growl"}"#
            ]
        );
        // Null / absent: the hashed inputs key.
        set(&mut m, Some("move.nothing"));
        assert_eq!(
            key_of(&m),
            [
                inputs::job_key("moveCard_d4", "j0", &json!({"move": {"name": "tackle"}})),
                inputs::job_key("moveCard_d4", "j0", &json!({"move": {"name": "growl"}})),
            ]
        );
    }

    #[test]
    fn child_slots_are_seeded_per_row_with_use_ids() {
        let mut m = manifest();
        m.components.get_mut("moveCard_d4").unwrap().use_id_slots = 1;
        let mut ctx = pikachu();
        seed_child_slots(
            &m,
            "r2",
            &chain(&["appLayout_a1", "detailPage_c3"]),
            &mut ctx,
        )
        .unwrap();
        assert_eq!(
            ctx["__children"]["detailPage_c3"]["__moveCard_d4_1"],
            json!([{"_id0": "brust-r2-detailPage_c3.moveCard_d4_1-0-1"},
                   {"_id0": "brust-r2-detailPage_c3.moveCard_d4_1-1-1"}])
        );
        assert!(ctx.get("__moveCard_d4_1").is_none(), "never top-level");
        // A job value merges into the seeded cell without losing its id.
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &ctx).unwrap();
        let Value::Object(map) = &mut ctx else {
            unreachable!()
        };
        merge_result(map, &plans[2], &json!({"_s1": "MOVE growl"}));
        assert_eq!(
            ctx["__children"]["detailPage_c3"]["__moveCard_d4_1"][1],
            json!({"_id0": "brust-r2-detailPage_c3.moveCard_d4_1-1-1", "_s1": "MOVE growl"})
        );
    }

    #[test]
    fn react_child_ssr_job_fills_parent_overlay_output() {
        let m = manifest();
        let ctx = json!({"team": ["a"]});
        let plans = collect_jobs(&m, &chain(&["teamPage_g7"]), &ctx).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].call_id, "teamPage_g7/j0");
        assert_eq!(plans[0].target.as_deref(), Some("teamBuilder_h8"));
        assert_eq!(plans[0].inputs, json!({"team": ["a"]}));
        let mut map = Map::new();
        merge_result(&mut map, &plans[0], &json!("<ul></ul>"));
        assert_eq!(
            map["__own"]["teamPage_g7"],
            json!({"_ssr_teamBuilder_h8": "<ul></ul>"})
        );
        assert!(
            map.get("_ssr_teamBuilder_h8").is_none(),
            "scoped, not global"
        );
        assert!(map.get("__children").is_none());
    }

    #[test]
    fn per_instance_job_fills_an_array_by_row() {
        let mut m = manifest();
        {
            let j = &mut m.components.get_mut("detailPage_c3").unwrap().jobs[0];
            j.kind = JobKind::Ssr;
            j.per_instance = Some("pokemon.moves".into());
            j.inputs = vec!["pokemon.moves".into()];
            j.outputs = vec!["_ssr_x".into()];
            j.target = Some("teamBuilder_h8".into());
        }
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &pikachu()).unwrap();
        let ids: Vec<&str> = plans.iter().take(2).map(|p| p.call_id.as_str()).collect();
        assert_eq!(ids, ["detailPage_c3/j0/0", "detailPage_c3/j0/1"]);
        // Same parent-scope inputs, so the row is part of the key.
        assert_eq!(plans[0].inputs, plans[1].inputs);
        assert_ne!(plans[0].key, plans[1].key);
        assert_eq!(plans[1].instance_row(), Some(1));
        let mut map = Map::new();
        merge_result(&mut map, &plans[1], &json!("B"));
        merge_result(&mut map, &plans[0], &json!("A"));
        assert_eq!(map["__own"]["detailPage_c3"]["_ssr_x"], json!(["A", "B"]));

        // With a `props` map each row sends its own props, content-keyed.
        m.components.get_mut("detailPage_c3").unwrap().jobs[0].props =
            Some([("mv".to_string(), "pokemon.moves[idx].name".to_string())].into());
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &pikachu()).unwrap();
        assert_eq!(plans[0].inputs, json!({"mv": "tackle"}));
        assert_eq!(plans[1].inputs, json!({"mv": "growl"}));
        assert_eq!(
            plans[0].key.0,
            inputs::job_key("detailPage_c3", "j0", &json!({"mv": "tackle"}))
        );
    }

    #[test]
    fn star_input_is_every_prop() {
        let mut m = manifest();
        m.components.get_mut("detailPage_c3").unwrap().jobs[0].inputs = vec!["*".into()];
        let mut ctx = pikachu();
        ctx["__own"] = json!({"x": 1});
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &ctx).unwrap();
        assert_eq!(plans[0].inputs, pikachu());
    }

    #[test]
    fn precompute_outputs_pick_keys_and_legacy_spreads() {
        let m = manifest();
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &pikachu()).unwrap();
        let mut map = Map::new();
        merge_result(&mut map, &plans[0], &json!({"_s1": "HP", "_s9": "extra"}));
        assert_eq!(map["__own"]["detailPage_c3"], json!({"_s1": "HP"}));
        assert!(check_value(&plans[0], &json!({"_s2": "x"})).is_err());
        assert!(check_value(&plans[0], &json!("x")).is_err());
        let mut legacy = plans[0].clone();
        legacy.outputs.clear();
        let mut map = Map::new();
        merge_result(&mut map, &legacy, &json!({"_s1": "HP", "_s9": "extra"}));
        assert_eq!(
            map["__own"]["detailPage_c3"],
            json!({"_s1": "HP", "_s9": "extra"})
        );
        assert!(check_value(&legacy, &json!("x")).is_ok());
    }

    #[test]
    fn loader_data_cannot_fill_server_slots() {
        // Server-owned names drop: `__outlet`, `__children`, `__own`, `_props`,
        // `_ssr_*`, and exactly `_s<digits>` / `_id<digits>`. Any other name
        // (`_id`, `_session`, `_s`, `__typename`, `__a_1`) is loader data.
        // Child slots live under `__children` and win over a same-named
        // top-level key in the overlay.
        let mut ctx = Map::new();
        merge_loader_data(
            &mut ctx,
            json!({"__outlet": "x", "_ssr_a": "x", "__a_1": {}, "__children": {}, "__own": {},
                   "_props": {}, "__typename": "Pokemon", "_id": 7, "_s1": "x", "_s12": "x",
                   "_id0": "x", "_id3": "x", "_session": "s", "_s": 1, "_s1a": 2, "_idx": 3,
                   "who": "w"}),
            "r1",
        );
        assert_eq!(
            Value::Object(ctx),
            json!({"__a_1": {}, "__typename": "Pokemon", "_id": 7, "_session": "s", "_s": 1,
                   "_s1a": 2, "_idx": 3, "who": "w"})
        );
    }

    #[test]
    fn location_percent_encodes_non_ascii_and_rejects_controls() {
        assert_eq!(location_header("/café").as_deref(), Some("/caf%C3%A9"));
        assert_eq!(location_header("/a?b=c d").as_deref(), Some("/a?b=c d"));
        for bad in [
            "/x\r\ny", "/x\ny", "/x\u{0}", "/x\u{7f}", "/x\ty", "/x\u{85}",
        ] {
            assert_eq!(location_header(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn chain_results_land_in_the_components_own_map() {
        let m = manifest();
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &pikachu()).unwrap();
        let mut map = Map::new();
        merge_result(&mut map, &plans[0], &json!({"_s1": "HP 35"}));
        assert_eq!(map["__own"]["detailPage_c3"], json!({"_s1": "HP 35"}));
        assert!(map.get("_s1").is_none(), "never top-level");
    }

    #[test]
    fn last_wins_and_case_collisions() {
        let v = last_wins(&[("a", "1"), ("b", "2"), ("a", "3")]);
        assert_eq!(v, [("a", "3"), ("b", "2")]);
        assert!(!ci_collision(&v));
        assert!(ci_collision(&[("session", ""), ("Session", "x")]));
    }

    #[test]
    fn hashed_names_need_six_lowercase_hex() {
        use std::path::Path as P;
        assert!(is_hashed(P::new("client/detailPage_c3-1a2b3c.js")));
        assert!(!is_hashed(P::new("client/runtime-8b1c.js")));
        assert!(!is_hashed(P::new("client/x-1A2B3C.js")));
        assert!(!is_hashed(P::new("client/react-19.2.0.js")));
        // Hex-letter words are not hashes: the suffix needs a digit.
        assert!(!is_hashed(P::new("public/brand-facade.css")));
        assert!(!is_hashed(P::new("public/decade-abcdef.css")));
        assert!(is_hashed(P::new("public/logo-abcde1.svg")));
    }

    #[test]
    fn static_rel_rule() {
        let b = StaticRoot::Brust;
        assert_eq!(safe_rel("client/a-1.js", b), Some("client/a-1.js"));
        assert_eq!(safe_rel("client/a.css", b), Some("client/a.css"));
        for bad in [
            "manifest.json",
            "jobs.js",
            "jinja/x.jinja",
            "client/../manifest.json",
            "client/.x.js",
            "client/x.json",
            "client//x.js",
            "client/sub/x.js",
            "",
        ] {
            assert_eq!(safe_rel(bad, b), None, "{bad}");
        }
        let p = StaticRoot::Public;
        assert_eq!(safe_rel("img/a.png", p), Some("img/a.png"));
        for bad in ["../manifest.json", "", "a/", "/a", "a\\b", ".env", "a b"] {
            assert_eq!(safe_rel(bad, p), None, "{bad}");
        }
    }
}
