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
use crate::manifest::{Instances, JobKind, JobRecord, Manifest, RouteRecord};
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
        return body::resp(200, "text/plain", &[], b"pong\n".to_vec());
    }
    if path_only == "/_brust/cache/stats" {
        let json = serde_json::to_vec(&s.stats()).unwrap_or_else(|_| b"{}".to_vec());
        return body::resp(200, "application/json", &[], json);
    }
    if let Some(rel) = path_only.strip_prefix("/_brust/") {
        return static_file(&s, StaticRoot::Brust, rel, headers, head).await;
    }
    if let Some(rel) = path_only.strip_prefix("/public/") {
        return static_file(&s, StaticRoot::Public, rel, headers, head).await;
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
        let (p, _) = resp.into_parts();
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

/// `<stem>` ends in `-<hex6+>` (lowercase): a content-hashed file name.
fn is_hashed(file: &std::path::Path) -> bool {
    let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    match stem.rsplit_once('-') {
        Some((_, h)) => h.len() >= 6 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        None => false,
    }
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
    let file = match root {
        StaticRoot::Brust => s.dist_dir.join(rel),
        StaticRoot::Public => s.dist_dir.join("public").join(rel),
    };
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
        && let Some(ctx) = s.l1.get(k)
    {
        meta.cache = CacheOutcome::Hit;
        return finish(s, route, &ctx, 200, Vec::new(), accept_enc, Some("HIT"))
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
        let r = call_worker::<_, LoaderResponse>(&s.pool, s.claim_timeout, CallKind::Loader, &req)
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
                return body::resp(
                    status,
                    "text/plain",
                    &[("Location".into(), location)],
                    Vec::new(),
                );
            }
            Ok(LoaderResponse::Verdict(Verdict::HttpError { status, body })) => {
                return body::resp(status, "text/plain", &[], body.into_bytes());
            }
            Ok(LoaderResponse::Error { error }) => {
                tracing::error!(route = %route.id, %error, "loader threw");
                return body::error_500();
            }
            Err(e @ (CallError::NoWorkers | CallError::Timeout)) => {
                return body::error_503(&e.to_string());
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
    let misses: Vec<usize> = (0..plans.len()).filter(|&i| values[i].is_none()).collect();
    if !misses.is_empty() {
        let req = JobsRequest {
            jobs: misses
                .iter()
                .map(|&i| JobCall {
                    id: plans[i].call_id.clone(),
                    component_id: plans[i].component_id.clone(),
                    kind: plans[i].kind,
                    inputs: plans[i].inputs.clone(),
                })
                .collect(),
        };
        let r =
            call_worker::<_, JobsResponse>(&s.pool, s.claim_timeout, CallKind::Jobs, &req).await;
        if !matches!(r, Err(CallError::NoWorkers | CallError::Timeout)) {
            s.job_calls.fetch_add(1, Ordering::Relaxed);
            meta.bun_calls += 1;
        }
        let resp = match r {
            Ok(r) => r,
            Err(e @ (CallError::NoWorkers | CallError::Timeout)) => {
                return body::error_503(&e.to_string());
            }
            Err(e) => {
                tracing::error!(route = %route.id, error = %e, "jobs call failed");
                return body::error_500();
            }
        };
        // Validate every result before inserting any: one bad job fails the
        // request and nothing is cached.
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for res in resp.results {
            if let Some(error) = res.error {
                let (component_id, job_id) = res.id.split_once('/').unwrap_or((&res.id, ""));
                let job_id = job_id.split('/').next().unwrap_or(job_id);
                tracing::error!(route = %route.id, component_id, job_id, %error, "job threw");
                return body::error_500();
            }
            by_id.insert(res.id, res.value.unwrap_or(Value::Null));
        }
        let mut fresh = Vec::with_capacity(misses.len());
        for &i in &misses {
            let Some(v) = by_id.remove(&plans[i].call_id) else {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, "jobs response has no result for {}", plans[i].call_id);
                return body::error_500();
            };
            fresh.push((i, Arc::new(v)));
        }
        for (i, v) in fresh {
            let p = &plans[i];
            s.jobs.insert(p.key.clone(), Arc::clone(&v), p.ttl, &p.tags);
            values[i] = Some(v);
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
    let resp = match finish(s, route, &ctx, status, extra, accept_enc, hdr) {
        Ok(r) => r,
        Err(e) => return render_failed(route, &e),
    };
    if let Some(k) = cache_key
        && status == 200
        && cacheable
        && let Some(c) = &route.cache
    {
        s.l1.insert(k, ctx, Duration::from_secs(c.ttl_seconds), &c.tags);
    }
    resp
}

fn render_failed(route: &RouteRecord, e: &RenderError) -> Response<ResponseBody> {
    tracing::error!(route = %route.id, error = %e, "render failed");
    body::error_500()
}

/// Leaf-first render with the chain's `useId` overlay, asset tags, optional
/// gzip. Shared by the HIT and MISS paths so a HIT renders byte-identically.
fn finish(
    s: &Server,
    route: &RouteRecord,
    ctx: &Value,
    status: u16,
    mut headers: Vec<(String, String)>,
    accept_enc: Option<&str>,
    cache_hdr: Option<&str>,
) -> Result<Response<ResponseBody>, RenderError> {
    let ids = |id: &str| {
        let slots = s.manifest.components.get(id).map_or(0, |c| c.use_id_slots);
        use_ids(&route.id, id, slots)
    };
    let html = s.renderer.render_chain(&route.chain, ctx, &ids)?;
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

/// Context slots the server owns: templates print them with `| safe`
/// (`__outlet`, `_ssr_*`) or index child results through them (`__<id>_<k>`).
fn is_server_slot(k: &str) -> bool {
    k.starts_with("__") || k.starts_with("_ssr_")
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
/// must see what the loader sees): header/cookie/query lists collapse to the
/// last value per name; a case-insensitive name collision, or a query name
/// repeated after decoding (`sort_query` would merge orders the loader reads
/// differently), bypasses L1.
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
    // Query pairs (undecoded key=value; mirrors the L1 sorted_query).
    let raw_query = full.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut query_pairs: Vec<(&str, &str)> = Vec::new();
    for pair in raw_query.split('&') {
        if pair.is_empty() {
            continue;
        }
        match pair.split_once('=') {
            Some((k, v)) => query_pairs.push((k, v)),
            None => query_pairs.push((pair, "")),
        }
    }
    let header_pairs = last_wins(&header_pairs);
    let cookie_pairs = last_wins(&cookie_pairs);
    let query_pairs = last_wins(&query_pairs);
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Chain {
        component: String,
    },
    Child {
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
    pub target: Target,
}

/// Job cache key: `cache.key` evaluated against the props when set (a string
/// → `"k:"+raw`, any other non-null value → `"k:"+canonical JSON`); unset or
/// `null` → the hashed inputs key.
fn plan_key(cid: &str, j: &JobRecord, props: &Value, projected: &Value) -> Result<JobKey, String> {
    if let Some(expr) = &j.cache.key {
        match Path::parse(expr)?.get(props, None) {
            Value::Null => {}
            Value::String(s) => return Ok(JobKey(format!("k:{s}"))),
            v => {
                let canon = String::from_utf8(inputs::canonical(v)).expect("JSON is UTF-8");
                return Ok(JobKey(format!("k:{canon}")));
            }
        }
    }
    Ok(JobKey(inputs::job_key(cid, &j.id, projected)))
}

fn plan_one(
    out: &mut Vec<JobPlan>,
    cid: &str,
    j: &JobRecord,
    props: &Value,
    target: Target,
    row: Option<usize>,
) -> Result<(), String> {
    let projected = inputs::project(props, &j.inputs, None)?;
    let key = plan_key(cid, j, props, &projected)?;
    let call_id = match row {
        Some(r) => format!("{cid}/{}/{r}", j.id),
        None => format!("{cid}/{}", j.id),
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
        target,
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

/// Every job of the chain in template order: each chain component's own jobs,
/// then its children's (static: one instance; per-row: one per list row).
pub(crate) fn collect_jobs(
    m: &Manifest,
    chain: &[String],
    ctx: &Value,
) -> Result<Vec<JobPlan>, String> {
    let mut out = Vec::new();
    for id in chain {
        let c = &m.components[id];
        for j in &c.jobs {
            plan_one(
                &mut out,
                id,
                j,
                ctx,
                Target::Chain {
                    component: id.clone(),
                },
                None,
            )?;
        }
        let mut ordinal: BTreeMap<&str, u32> = BTreeMap::new();
        for ch in &c.children {
            let k = {
                let e = ordinal.entry(ch.id.as_str()).or_insert(0);
                *e += 1;
                *e
            };
            let child = &m.components[&ch.id];
            match &ch.instances {
                Instances::Static => {
                    let props = inputs::child_props(ctx, &ch.props, None)?;
                    for j in &child.jobs {
                        let t = Target::Child {
                            component: ch.id.clone(),
                            k,
                            row: None,
                        };
                        plan_one(&mut out, &ch.id, j, &props, t, None)?;
                    }
                }
                Instances::PerRow(list) => {
                    for r in 0..row_count(list, ctx)? {
                        let props = inputs::child_props(ctx, &ch.props, Some(r))?;
                        for j in &child.jobs {
                            let t = Target::Child {
                                component: ch.id.clone(),
                                k,
                                row: Some(r),
                            };
                            plan_one(&mut out, &ch.id, j, &props, t, Some(r))?;
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// S7 step 6 for children: `ctx["__<id>_<k>"]` = `{}` (static) or one `{}`
/// per row (per-row, so a row whose child has no jobs still indexes), each
/// carrying its instance's `_idN`. Runs before the L1 store, so a HIT
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
    let mut seeds: Vec<(String, Value)> = Vec::new();
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
                Instances::Static => cell(&format!("{}_{k}", ch.id), slots),
                Instances::PerRow(list) => Value::Array(
                    (0..row_count(list, ctx)?)
                        .map(|r| cell(&format!("{}_{k}-{r}", ch.id), slots))
                        .collect(),
                ),
            };
            seeds.push((format!("__{}_{k}", ch.id), slot));
        }
    }
    if let Value::Object(map) = ctx {
        map.extend(seeds);
    }
    Ok(())
}

/// Writes one job's value into the context slot its target names (S7 step 5).
/// A static child's ssr HTML is also written to the top-level `_ssr_<id>` the
/// parent template's island host prints.
pub(crate) fn merge_result(ctx: &mut Map<String, Value>, plan: &JobPlan, value: &Value) {
    fn spread(obj: &mut Map<String, Value>, value: &Value) {
        if let Some(o) = value.as_object() {
            for (k, v) in o {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    match &plan.target {
        Target::Chain { component } => match plan.kind {
            JobKind::Precompute => spread(ctx, value),
            JobKind::Ssr => {
                ctx.insert(format!("_ssr_{component}"), value.clone());
            }
        },
        Target::Child { component, k, row } => {
            if plan.kind == JobKind::Ssr && row.is_none() {
                ctx.insert(format!("_ssr_{component}"), value.clone());
            }
            let slot = ctx.entry(format!("__{component}_{k}")).or_insert_with(|| {
                if row.is_some() {
                    Value::Array(vec![])
                } else {
                    Value::Object(Map::new())
                }
            });
            let cell = match row {
                Some(r) => {
                    let Some(a) = slot.as_array_mut() else { return };
                    while a.len() <= *r {
                        a.push(Value::Object(Map::new()));
                    }
                    &mut a[*r]
                }
                None => slot,
            };
            let Some(obj) = cell.as_object_mut() else {
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
            ["detailPage_c3/j0", "moveCard_d4/j0/0", "moveCard_d4/j0/1"]
        );
        assert_eq!(plans[0].inputs, json!({"pokemon": {"stats": {"hp": 35}}}));
        assert_eq!(
            plans[0].target,
            Target::Chain {
                component: "detailPage_c3".into()
            }
        );
        assert_eq!(plans[2].inputs, json!({"move": {"name": "growl"}}));
        assert_eq!(
            plans[2].target,
            Target::Child {
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
        assert_eq!(key_of(&m), ["k:tackle", "k:growl"]);
        // Any other non-null value: canonical JSON.
        set(&mut m, Some("props.move"));
        assert_eq!(
            key_of(&m),
            [r#"k:{"name":"tackle"}"#, r#"k:{"name":"growl"}"#]
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
            ctx["__moveCard_d4_1"],
            json!([{"_id1": "brust-r2-moveCard_d4_1-0-1"}, {"_id1": "brust-r2-moveCard_d4_1-1-1"}])
        );
        // A job value merges into the seeded cell without losing its id.
        let plans = collect_jobs(&m, &chain(&["detailPage_c3"]), &ctx).unwrap();
        let Value::Object(map) = &mut ctx else {
            unreachable!()
        };
        merge_result(map, &plans[2], &json!({"_s1": "MOVE growl"}));
        assert_eq!(
            ctx["__moveCard_d4_1"][1],
            json!({"_id1": "brust-r2-moveCard_d4_1-1-1", "_s1": "MOVE growl"})
        );
    }

    #[test]
    fn static_child_ssr_fills_top_level_slot_and_cell() {
        let m = manifest();
        let ctx = json!({"team": ["a"]});
        let plans = collect_jobs(&m, &chain(&["teamPage_g7"]), &ctx).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].call_id, "teamBuilder_h8/ssr");
        let mut map = Map::new();
        merge_result(&mut map, &plans[0], &json!("<ul></ul>"));
        assert_eq!(map["_ssr_teamBuilder_h8"], "<ul></ul>");
        assert_eq!(
            map["__teamBuilder_h8_1"]["_ssr_teamBuilder_h8"],
            "<ul></ul>"
        );
    }

    #[test]
    fn loader_data_cannot_fill_server_slots() {
        let mut ctx = Map::new();
        merge_loader_data(
            &mut ctx,
            json!({"__outlet": "x", "_ssr_a": "x", "__a_1": {}, "_id": 7, "_s1": "kept", "who": "w"}),
            "r1",
        );
        assert_eq!(
            Value::Object(ctx),
            json!({"_id": 7, "_s1": "kept", "who": "w"})
        );
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
