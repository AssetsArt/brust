use serde::Deserialize;
use serde::Serialize;

use crate::cache::key_expr::Expr;
use crate::manifest::{BypassSpec, Manifest, RouteCache};

// Compiled, request-ready cache directives for one route. Parsed once at
// install (errors surface as install failure); evaluated per request.
#[derive(Clone, Default)]
pub struct CompiledCache {
    pub prefix: Option<Expr>,
    /// None = never bypass; Some(None) = always; Some(Some(expr)) = conditional.
    pub bypass: Option<Option<Expr>>,
}

pub(crate) fn serialize_as_map<S, K, V>(vec: &[(K, V)], serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
    K: serde::Serialize,
    V: serde::Serialize,
{
    serializer.collect_map(vec.iter().map(|(k, v)| (k, v)))
}

/// Structured view of the incoming HTTP request, owned by the envelope.
/// Parsed once in Rust (cheaper than re-parsing in JS) and embedded in
/// the JSON envelope handed to the worker.
#[derive(Serialize)]
pub struct RequestEnvelope<'a> {
    pub method: &'a str,
    pub url: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub headers: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub cookies: Vec<(&'a str, std::borrow::Cow<'a, str>)>,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub search: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
}

/// The matched route plus the parsed request. v2 has one envelope shape (the
/// 0.1.x action/mcp/sse/ws variants and the `kind` discriminant are gone); its
/// `req` is what a `loader` call receives.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub route_id: u32,
    pub path: &'a str,
    #[serde(serialize_with = "crate::routing::routes::serialize_as_map")]
    pub params: Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
    pub req: RequestEnvelope<'a>,
}

/// Outcome of a match against the radix tree.
pub enum MatchResult<'a> {
    Matched {
        route_id: u32,
        envelope: RouteEnvelope<'a>,
    },
    /// A catch-all (`path: '*'`) was registered for the best-matching prefix.
    /// The caller should render `route_id` and stamp the response HTTP 404.
    NotFound {
        route_id: u32,
        envelope: RouteEnvelope<'a>,
    },
    NoMatch,
}

#[derive(Debug, Default, Deserialize)]
pub struct RouteConfig {
    pub path: String,
    #[serde(default)]
    pub cache: Option<RouteCache>,
    /// Set `true` by the TS flatten step when the route has `path: '*'`.
    /// When true the route is NOT inserted into matchit; instead it is recorded
    /// in `not_found_table` keyed by `not_found_prefix`. The route_id (array
    /// index) is preserved so both sides can look it up via `byRouteId`.
    #[serde(default, rename = "notFound")]
    pub not_found: bool,
    /// The effective prefix for this catch-all: the parent layout's `fullPath`
    /// (root catch-all → `""`). Longest-prefix match selects it on NoMatch.
    #[serde(default, rename = "notFoundPrefix")]
    pub not_found_prefix: String,
}

/// Immutable after `from_manifest` (M3-P P4): request-path reads take no lock.
/// `install_with_config` is `&mut self` and is called by `from_manifest` and
/// tests only.
#[derive(Default)]
pub struct RouteTable {
    router: matchit::Router<u32>,
    cache_configs: Vec<Option<RouteCache>>,
    /// Compiled L1 prefix/bypass expressions, parallel to `cache_configs`.
    /// Index = route_id. Parsed once at install; evaluated per request.
    compiled_caches: Vec<CompiledCache>,
    /// Post-router fallback tier: catch-all routes sorted by prefix length
    /// descending (longest first). On matchit NoMatch, `select_not_found`
    /// scans this table for the best segment-boundary prefix match and returns
    /// the catch-all's `route_id`. Empty when the app declares no catch-alls
    /// (feature is purely additive).
    not_found_table: Vec<(String, u32)>,
}

impl RouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the table from `manifest.routes` in manifest order, so
    /// `route_id == index into manifest.routes`. Catch-alls are root-level in
    /// M2 (`not_found_prefix = ""`); nested prefixes arrive with the compiler
    /// in M3 and `select_not_found` already handles them.
    pub fn from_manifest(m: &Manifest) -> Result<Self, RouteInstallError> {
        let configs: Vec<RouteConfig> = m
            .routes
            .iter()
            .map(|r| RouteConfig {
                path: r.pattern.clone(),
                cache: r.cache.clone(),
                not_found: r.catch_all,
                not_found_prefix: String::new(),
            })
            .collect();
        let mut table = Self::new();
        table.install_with_config(&configs)?;
        Ok(table)
    }

    /// Index into `manifest.routes` for a matched `route_id` (identity: the
    /// table is installed in manifest order).
    pub fn route_index(&self, route_id: u32) -> usize {
        route_id as usize
    }

    /// Replace the route set + per-route cache configs. Patterns are inserted
    /// in array order; index = route_id.
    pub fn install_with_config(
        &mut self,
        configs: &[RouteConfig],
    ) -> Result<u32, RouteInstallError> {
        let mut router = matchit::Router::new();
        let mut caches: Vec<Option<RouteCache>> = Vec::with_capacity(configs.len());
        let mut compiled: Vec<CompiledCache> = Vec::with_capacity(configs.len());
        let mut nf_table: Vec<(String, u32)> = Vec::new();
        for (idx, c) in configs.iter().enumerate() {
            // Catch-all routes (notFound: true) are NOT inserted into matchit.
            // They are registered in the not-found fallback table keyed by
            // their effective prefix. The parallel Vecs (caches/compiled)
            // still get entries so route_id == array index is preserved on both
            // sides (Rust idx as u32 ↔ TS byRouteId).
            if c.not_found {
                nf_table.push((normalize_route_pattern(&c.not_found_prefix).into_owned(), idx as u32));
                // Still push to the parallel Vecs to keep indices aligned.
                caches.push(c.cache.clone());
                compiled.push(CompiledCache::default());
                continue;
            }
            router
                .insert(normalize_route_pattern(&c.path).into_owned(), idx as u32)
                .map_err(|e| RouteInstallError::Insert {
                    pattern: c.path.clone(),
                    reason: e.to_string(),
                })?;
            let compiled_cache = match &c.cache {
                Some(cc) => {
                    let prefix =
                        match &cc.prefix {
                            Some(s) => Some(Expr::parse(s).map_err(|reason| {
                                RouteInstallError::CacheExpr {
                                    pattern: c.path.clone(),
                                    field: "prefix",
                                    reason,
                                }
                            })?),
                            None => None,
                        };
                    let bypass = match &cc.bypass {
                        None => None,
                        Some(BypassSpec::Always(true)) => Some(None),
                        Some(BypassSpec::Always(false)) => None,
                        Some(BypassSpec::Expr(s)) => {
                            Some(Some(Expr::parse(s).map_err(|reason| {
                                RouteInstallError::CacheExpr {
                                    pattern: c.path.clone(),
                                    field: "bypass",
                                    reason,
                                }
                            })?))
                        }
                    };
                    CompiledCache { prefix, bypass }
                }
                None => CompiledCache::default(),
            };
            caches.push(c.cache.clone());
            compiled.push(compiled_cache);
        }
        // No sort needed: select_not_found uses max_by_key, which finds the
        // longest matching prefix regardless of table order.
        self.router = router;
        self.cache_configs = caches;
        self.compiled_caches = compiled;
        self.not_found_table = nf_table;
        Ok(configs.len() as u32)
    }

    /// Compiled L1 prefix/bypass directives for a route, parallel to
    /// `cache_for`. `None` when the route_id is out of range.
    pub fn compiled_cache_for(&self, route_id: u32) -> Option<&CompiledCache> {
        // A borrow: no lock, no refcount (per-request cache hot path).
        self.compiled_caches.get(route_id as usize)
    }

    pub fn cache_for(&self, route_id: u32) -> Option<RouteCache> {
        self.cache_configs
            .get(route_id as usize)
            .and_then(|c| c.clone())
    }

    /// Match only (M3-P P4): the route id and decoded params, no request parsing. A HIT never goes
    /// further; a MISS/BYPASS calls [`RouteMatch::into_envelope`].
    pub fn match_route<'a>(&'a self, full_path: &'a str) -> Option<RouteMatch<'a>> {
        let path_only = full_path.split_once('?').map_or(full_path, |(p, _)| p);
        // L24: match in the form literals are stored in (browser percent-encoding, uppercase hex). Never a decode.
        match normalize_request_path(path_only) {
            std::borrow::Cow::Borrowed(p) => self.match_normalized(p),
            // A rewritten path is local: the params are copied out of it (only for non-ASCII / lowercase-hex URLs).
            std::borrow::Cow::Owned(p) => self.match_normalized(&p).map(|m| RouteMatch {
                route_id: m.route_id,
                not_found: m.not_found,
                params: m
                    .params
                    .into_iter()
                    .map(|(k, v)| (std::borrow::Cow::Owned(k.into_owned()), std::borrow::Cow::Owned(v.into_owned())))
                    .collect(),
            }),
        }
    }

    fn match_normalized<'p>(&'p self, path_only: &'p str) -> Option<RouteMatch<'p>> {
        match self.router.at(path_only) {
            // Decode at the production site: loaders, clientLoader, L1 param() keys, x-props, native
            // ctx and treaty all consume THIS list, so one decode keeps every consumer consistent.
            Ok(m) => Some(RouteMatch {
                route_id: *m.value,
                not_found: false,
                params: m
                    .params
                    .iter()
                    .map(|(k, v)| (std::borrow::Cow::Borrowed(k), decode_path_param(v)))
                    .collect(),
            }),
            Err(_) => select_not_found(&self.not_found_table, path_only).map(|id| RouteMatch {
                route_id: id,
                not_found: true,
                params: Vec::new(),
            }),
        }
    }

    pub fn match_path<'a>(
        &'a self,
        method: &'a str,
        full_path: &'a str,
        headers: &'a http::HeaderMap,
    ) -> MatchResult<'a> {
        match self.match_route(full_path) {
            Some(m) => {
                let (route_id, nf) = (m.route_id, m.not_found);
                let envelope = m.into_envelope(method, full_path, headers, None);
                if nf {
                    MatchResult::NotFound { route_id, envelope }
                } else {
                    MatchResult::Matched { route_id, envelope }
                }
            }
            None => MatchResult::NoMatch,
        }
    }
}

/// Decoded query pairs (`url_decode`, `+` = space), in order, empty pairs skipped: the envelope's
/// `search` and what `l1_decision` keys and dedupes on — one function so both see the same pairs.
pub type Search<'a> = Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>;

pub fn decode_search(query: &str) -> Search<'_> {
    let mut search = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        match pair.split_once('=') {
            Some((k, v)) => search.push((url_decode(k), url_decode(v))),
            None => search.push((url_decode(pair), std::borrow::Cow::Borrowed(""))),
        }
    }
    search
}

/// A matched route before any request parsing (M3-P P4). The L1 decision needs only this; a
/// MISS/BYPASS turns it into the envelope, so a HIT never builds headers/cookies/search.
pub struct RouteMatch<'a> {
    pub route_id: u32,
    /// A catch-all answered (the caller renders it at 404).
    pub not_found: bool,
    /// Path params, values decoded by `decode_path_param`; names borrow the table.
    pub params: Search<'a>,
}

impl<'a> RouteMatch<'a> {
    /// Exactly the envelope `match_path` returns. `search`: the decoded query when the caller already
    /// has it (`l1_decision`), else decoded here.
    pub fn into_envelope(
        self,
        method: &'a str,
        full_path: &'a str,
        headers: &'a http::HeaderMap,
        search: Option<Search<'a>>,
    ) -> RouteEnvelope<'a> {
        let query = full_path.split_once('?').map_or("", |(_, q)| q);
        RouteEnvelope {
            route_id: self.route_id,
            path: full_path,
            params: self.params,
            req: build_request_envelope(method, full_path, query, headers, search),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RouteInstallError {
    #[error("invalid route pattern {pattern:?}: {reason}")]
    Insert { pattern: String, reason: String },
    #[error("route {pattern:?}: invalid cache.{field} expression: {reason}")]
    CacheExpr {
        pattern: String,
        field: &'static str,
        reason: String,
    },
}

#[doc(hidden)]
pub fn build_request_envelope<'a>(
    method: &'a str,
    full_path: &'a str,
    query: &'a str,
    request_headers: &'a http::HeaderMap,
    search: Option<Search<'a>>,
) -> RequestEnvelope<'a> {
    // Iterate the hyper HeaderMap directly. The pre-refactor path rebuilt a raw
    // header block from THIS SAME HeaderMap (`reconstruct_raw_headers`) and then
    // httparse-parsed it, so the iteration order here matches the old envelope
    // byte-for-byte: HeaderMap::iter() yields lowercase names (HeaderName is
    // canonical-lowercase) and repeats an entry once per stored value, exactly
    // what the rebuilt-then-reparsed block produced.
    let mut headers = Vec::new();
    let mut cookies = Vec::new();
    for (name, value) in request_headers.iter() {
        let name_str = name.as_str();
        if name_str.is_empty() {
            continue;
        }
        // HeaderValue may carry non-UTF-8 bytes; match the old
        // `from_utf8(...).unwrap_or("")` fallback.
        let value_str = std::str::from_utf8(value.as_bytes()).unwrap_or("");
        if name == http::header::COOKIE {
            for pair in value_str.split(';') {
                let trimmed = pair.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    cookies.push((k.trim(), std::borrow::Cow::Borrowed(v.trim())));
                }
            }
        }
        // HeaderName is always lowercase, so no per-name case normalization is
        // needed (the old code lowercased only when an uppercase char appeared).
        headers.push((
            std::borrow::Cow::Borrowed(name_str),
            std::borrow::Cow::Borrowed(value_str),
        ));
    }

    let search = search.unwrap_or_else(|| decode_search(query));

    RequestEnvelope {
        method,
        url: full_path,
        headers,
        cookies,
        search,
    }
}

/// L24: a byte a browser percent-encodes in a URL path (and so a route literal is stored as): non-ASCII
/// (UTF-8 bytes), controls, space, and `"` `<` `>` `` ` ``.
const fn needs_encode(b: u8) -> bool {
    b >= 0x80 || b <= 0x20 || b == 0x7f || matches!(b, b'"' | b'<' | b'>' | b'`')
}

/// L24: the one path normalisation every surface shares (router, L1 keys, `invalidate({path})`, the
/// action-prefix check): bytes a browser would encode become `%XX` (UTF-8, uppercase hex), and the hex digits
/// of an existing `%xx` are uppercased. NEVER decodes: `%2F` stays a literal-slash escape inside a param
/// (`decode_path_param` runs after the match). With `braces`, `{param}` / `{*rest}` segments of a ROUTE PATTERN
/// are copied verbatim. Borrowed when nothing changes (the hot path of an ASCII URL).
fn normalize(s: &str, braces: bool) -> std::borrow::Cow<'_, str> {
    let b = s.as_bytes();
    let dirty = {
        let mut d = false;
        let mut i = 0;
        let mut depth = 0u32;
        while i < b.len() {
            let c = b[i];
            if braces && c == b'{' {
                depth += 1;
            } else if braces && c == b'}' {
                depth = depth.saturating_sub(1);
            } else if depth == 0 {
                if needs_encode(c) {
                    d = true;
                    break;
                }
                if c == b'%'
                    && i + 2 < b.len()
                    && b[i + 1].is_ascii_hexdigit()
                    && b[i + 2].is_ascii_hexdigit()
                    && (b[i + 1].is_ascii_lowercase() || b[i + 2].is_ascii_lowercase())
                {
                    d = true;
                    break;
                }
            }
            i += 1;
        }
        d
    };
    if !dirty {
        return std::borrow::Cow::Borrowed(s);
    }
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = Vec::with_capacity(b.len() + 16);
    let mut i = 0;
    let mut depth = 0u32;
    while i < b.len() {
        let c = b[i];
        if braces && c == b'{' {
            depth += 1;
            out.push(c);
        } else if braces && c == b'}' {
            depth = depth.saturating_sub(1);
            out.push(c);
        } else if depth > 0 {
            out.push(c);
        } else if c == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            out.extend_from_slice(&[b'%', b[i + 1].to_ascii_uppercase(), b[i + 2].to_ascii_uppercase()]);
            i += 3;
            continue;
        } else if needs_encode(c) {
            out.extend_from_slice(&[b'%', HEX[(c >> 4) as usize], HEX[(c & 15) as usize]]);
        } else {
            out.push(c);
        }
        i += 1;
    }
    // Only ASCII was added around whole UTF-8 sequences, so this is valid UTF-8 by construction.
    std::borrow::Cow::Owned(String::from_utf8(out).unwrap_or_default())
}

/// L24: a request path (no query) in the form route literals are stored in. See [`normalize`].
pub fn normalize_request_path(path: &str) -> std::borrow::Cow<'_, str> {
    normalize(path, false)
}

/// L24: a route pattern with its literal segments percent-encoded the way browsers send them.
pub fn normalize_route_pattern(pattern: &str) -> std::borrow::Cow<'_, str> {
    normalize(pattern, true)
}

/// Percent-decode ONE matched path-param value (spec:
/// docs/superpowers/specs/2026-06-12-decode-params-design.md).
/// Full RFC-3986 decode including `%2F`; `+` stays literal (space-as-plus is
/// a query convention — url_decode above is NOT reusable here). Fallback is
/// per-VALUE: any malformed `%` sequence or invalid post-decode UTF-8 returns
/// the WHOLE raw capture, mirroring the client matchFallback's
/// `try { decodeURIComponent } catch { raw }` so server and client always
/// produce the same value. (percent_decode_str alone decodes per-SEQUENCE on
/// malformed input — hence the explicit pre-validation scan.)
pub(crate) fn decode_path_param(raw: &str) -> std::borrow::Cow<'_, str> {
    // Fast path + pre-validation in one scan: every '%' must be followed by
    // two hex digits, else the whole value ships raw.
    let bytes = raw.as_bytes();
    let mut has_pct = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            has_pct = true;
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return std::borrow::Cow::Borrowed(raw);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    if !has_pct {
        return std::borrow::Cow::Borrowed(raw);
    }
    match percent_encoding::percent_decode_str(raw).decode_utf8() {
        Ok(decoded) => decoded,
        Err(_) => std::borrow::Cow::Borrowed(raw),
    }
}

/// Minimal percent-decode for query-string keys/values. Decodes %xx and treats
/// `+` as space. Unrecognised escapes pass through unchanged.
fn url_decode(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('+') && !s.contains('%') {
        return std::borrow::Cow::Borrowed(s);
    }
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
    std::borrow::Cow::Owned(String::from_utf8(out).unwrap_or_default())
}

/// Longest segment-boundary prefix match against the not-found table.
///
/// A prefix `p` matches `path` when:
/// - `p` is empty (root catch-all, matches everything), OR
/// - `path == p` (exact), OR
/// - `path` starts with `p/` (proper sub-path, not e.g. "/docsy" for "/docs").
///
/// Returns the `route_id` of the entry with the longest matching prefix, or
/// `None` when the table is empty or nothing matches.
///
/// Note on ties: two DISTINCT prefixes of equal length can never both match a
/// single path (a path cannot start with both `/foo/` and `/bar/`), so at most
/// one surviving entry exists per length — `max_by_key`'s tie-break is never
/// actually exercised, and install-time dedupe already forbids identical
/// prefixes. The check is allocation-free (no `format!`) since it runs on every
/// matchit miss.
fn select_not_found(table: &[(String, u32)], path: &str) -> Option<u32> {
    fn prefix_matches(p: &str, path: &str) -> bool {
        p.is_empty()
            || path == p
            // proper sub-path: `path` is `p` followed by a `/` boundary, so
            // "/docs" matches "/docs/x" but NOT "/docsy".
            || (path.len() > p.len() && path.starts_with(p) && path.as_bytes()[p.len()] == b'/')
    }
    table
        .iter()
        .filter(|(p, _)| prefix_matches(p, path))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, id)| *id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an `http::HeaderMap` from `(name, value)` pairs, appending repeats
    /// (so multi-Cookie tests keep both values). Names are parsed as-is;
    /// HeaderName lowercases them, matching the wire→HeaderMap path hyper takes.
    fn hm(pairs: &[(&str, &str)]) -> http::HeaderMap {
        let mut map = http::HeaderMap::new();
        for (k, v) in pairs {
            let name = http::header::HeaderName::from_bytes(k.as_bytes()).unwrap();
            map.append(name, http::HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn decode_path_param_basic_and_multibyte() {
        use std::borrow::Cow;
        assert_eq!(decode_path_param("sa%20wad-dee"), "sa wad-dee");
        // Thai: สวัสดี
        assert_eq!(
            decode_path_param("%E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B5"),
            "สวัสดี"
        );
        assert_eq!(decode_path_param("a%2Fb"), "a/b"); // full decode incl. %2F
        assert_eq!(decode_path_param("a+b"), "a+b"); // + is literal in paths
        assert!(matches!(
            decode_path_param("plain-slug"),
            Cow::Borrowed("plain-slug")
        ));
    }

    #[test]
    fn decode_path_param_per_value_raw_fallback() {
        use std::borrow::Cow;
        // Malformed % → WHOLE value raw (pre-validation), mirroring
        // decodeURIComponent's per-value throw — NOT the crate's per-sequence
        // behavior (a%ZZ%41 must NOT become a%ZZA).
        assert!(matches!(
            decode_path_param("a%ZZ%41"),
            Cow::Borrowed("a%ZZ%41")
        ));
        assert!(matches!(decode_path_param("100%"), Cow::Borrowed("100%")));
        assert!(matches!(decode_path_param("%Z"), Cow::Borrowed("%Z")));
        // %FF%41 passes the hex pre-scan (both sequences are valid hex) and
        // falls back at the UTF-8 validation stage instead — still per-VALUE:
        // the valid %41 must NOT decode while %FF poisons the whole value.
        assert!(matches!(
            decode_path_param("%FF%41"),
            Cow::Borrowed("%FF%41")
        ));
        assert!(matches!(
            decode_path_param("%ED%A0%80"),
            Cow::Borrowed("%ED%A0%80")
        ));
    }

    #[test]
    fn match_path_params_arrive_decoded_incl_catch_all() {
        let mut table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/post/{slug}".into(),
                    cache: None,
                    ..Default::default()
                },
                RouteConfig {
                    path: "/files/{*rest}".into(),
                    cache: None,
                    ..Default::default()
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/post/sa%20wad-dee", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "sa wad-dee");
            }
            _ => panic!("no match"),
        }
        match table.match_path("GET", "/files/a%2Fb/c", &headers) {
            MatchResult::Matched { envelope, .. } => {
                assert_eq!(envelope.params[0].1.as_ref(), "a/b/c");
            }
            _ => panic!("no match"),
        }
    }

    #[test]
    fn url_decode_passes_through_ascii() {
        assert_eq!(url_decode("abc"), "abc");
        assert_eq!(url_decode(""), "");
    }

    #[test]
    fn url_decode_plus_to_space() {
        assert_eq!(url_decode("a+b"), "a b");
    }

    #[test]
    fn url_decode_percent_hex_both_cases() {
        assert_eq!(url_decode("%41"), "A");
        assert_eq!(url_decode("%4f"), "O");
        assert_eq!(url_decode("%4F"), "O");
    }

    #[test]
    fn url_decode_multibyte_utf8() {
        assert_eq!(url_decode("%E2%9C%93"), "\u{2713}");
    }

    #[test]
    fn url_decode_trailing_percent_passes_through() {
        assert_eq!(url_decode("%"), "%");
        assert_eq!(url_decode("a%"), "a%");
    }

    #[test]
    fn url_decode_short_escape_passes_through() {
        // Only 1 trailing nibble — bounds check fails, falls through literally.
        assert_eq!(url_decode("%4"), "%4");
    }

    #[test]
    fn url_decode_invalid_hex_passes_through() {
        assert_eq!(url_decode("%ZZ"), "%ZZ");
        assert_eq!(url_decode("%G1"), "%G1");
    }

    #[test]
    fn url_decode_invalid_utf8_collapses_to_empty() {
        // %FF%FE is not valid UTF-8 — current contract collapses to "".
        assert_eq!(url_decode("%FF%FE"), "");
    }

    #[test]
    fn envelope_parses_cookies_from_single_header() {
        let headers = hm(&[("Host", "x"), ("Cookie", "user=alice; sid=xyz")]);
        let env = build_request_envelope("GET", "/x", "", &headers, None);
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "user")
                .map(|(_, v)| v.as_ref()),
            Some("alice")
        );
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "sid")
                .map(|(_, v)| v.as_ref()),
            Some("xyz")
        );
    }

    #[test]
    fn envelope_merges_cookies_across_multiple_cookie_headers() {
        // RFC 6265 S5.4 allows a single Cookie header per request, but
        // some proxies fold/split. Both cookies should appear in the map.
        let headers = hm(&[("Host", "x"), ("Cookie", "a=1"), ("Cookie", "b=2")]);
        let env = build_request_envelope("GET", "/x", "", &headers, None);
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "a")
                .map(|(_, v)| v.as_ref()),
            Some("1")
        );
        assert_eq!(
            env.cookies
                .iter()
                .find(|(k, _)| *k == "b")
                .map(|(_, v)| v.as_ref()),
            Some("2")
        );
    }

    #[test]
    fn envelope_parses_search_with_key_only_and_empty_value() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope(
            "GET",
            "/x?name=brust&flag&empty=",
            "name=brust&flag&empty=",
            &headers,
            None,
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "name")
                .map(|(_, v)| v.as_ref()),
            Some("brust")
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "flag")
                .map(|(_, v)| v.as_ref()),
            Some("")
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "empty")
                .map(|(_, v)| v.as_ref()),
            Some("")
        );
    }

    #[test]
    fn envelope_parses_search_with_percent_and_plus() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope(
            "GET",
            "/x?greet=hello+world&unicode=%E2%9C%93",
            "greet=hello+world&unicode=%E2%9C%93",
            &headers,
            None,
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "greet")
                .map(|(_, v)| v.as_ref()),
            Some("hello world"),
        );
        assert_eq!(
            env.search
                .iter()
                .find(|(k, _)| *k == "unicode")
                .map(|(_, v)| v.as_ref()),
            Some("\u{2713}"),
        );
    }

    #[test]
    fn envelope_empty_request_safe() {
        let headers = http::HeaderMap::new();
        let env = build_request_envelope("GET", "/x", "", &headers, None);
        assert_eq!(env.method, "GET");
        assert_eq!(env.url, "/x");
        assert!(env.headers.is_empty());
        assert!(env.cookies.is_empty());
        assert!(env.search.is_empty());
    }

    #[test]
    fn route_envelope_serializes_route_id_and_path() {
        let mut table = RouteTable::new();
        let cfg = RouteConfig {
            path: "/foo".into(),
            cache: None,
            ..Default::default()
        };
        table.install_with_config(&[cfg]).unwrap();
        let headers = hm(&[("Host", "x")]);
        let result = table.match_path("GET", "/foo", &headers);
        match result {
            MatchResult::Matched { envelope, .. } => {
                let envelope_json = serde_json::to_string(&envelope).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
                assert!(parsed.get("kind").is_none(), "v2 envelope has no kind");
                assert_eq!(parsed["route_id"], 0);
                assert_eq!(parsed["path"], "/foo");
            }
            MatchResult::NotFound { .. } | MatchResult::NoMatch => {
                panic!("expected match for /foo")
            }
        }
    }

    // ---- not-found fallback tier tests ----

    #[test]
    fn select_not_found_longest_segment_prefix() {
        let t = vec![(String::new(), 9u32), ("/docs".into(), 3u32)];
        assert_eq!(select_not_found(&t, "/docs/missing"), Some(3));
        assert_eq!(select_not_found(&t, "/other"), Some(9)); // root last-resort
        assert_eq!(select_not_found(&t, "/docs"), Some(3)); // exact prefix
        assert_eq!(select_not_found(&t, "/docsearch"), Some(9)); // NOT /docs (boundary)
    }

    #[test]
    fn select_not_found_empty_table_is_none() {
        assert_eq!(select_not_found(&[], "/x"), None);
    }

    #[test]
    fn select_not_found_root_only_matches_everything() {
        let t = vec![(String::new(), 0u32)];
        assert_eq!(select_not_found(&t, "/anything/at/all"), Some(0));
        assert_eq!(select_not_found(&t, "/"), Some(0));
    }

    #[test]
    fn select_not_found_no_root_no_match_returns_none() {
        let t = vec![("/docs".into(), 3u32)];
        assert_eq!(select_not_found(&t, "/other"), None);
    }

    #[test]
    fn match_path_returns_not_found_when_catchall_registered() {
        let mut table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/home".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(), // sentinel fullPath for catch-all
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(), // root prefix
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/unmatched", &headers) {
            MatchResult::NotFound { route_id, .. } => {
                assert_eq!(route_id, 1, "catch-all has route_id = 1 (index 1)");
            }
            MatchResult::Matched { .. } => panic!("expected NotFound, got Matched"),
            MatchResult::NoMatch => panic!("expected NotFound, got NoMatch"),
        }
    }

    #[test]
    fn match_path_returns_no_match_when_table_empty() {
        let mut table = RouteTable::new();
        table
            .install_with_config(&[RouteConfig {
                path: "/home".into(),
                cache: None,
                not_found: false,
                not_found_prefix: String::new(),
            }])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/unmatched", &headers) {
            MatchResult::NoMatch => {} // expected
            MatchResult::NotFound { .. } => panic!("expected NoMatch, got NotFound"),
            MatchResult::Matched { .. } => panic!("expected NoMatch, got Matched"),
        }
    }

    #[test]
    fn match_path_real_route_still_matches_when_catchall_installed() {
        let mut table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/home".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(),
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/home", &headers) {
            MatchResult::Matched { route_id, .. } => {
                assert_eq!(route_id, 0);
            }
            _other => panic!(
                "expected Matched for /home, got something else: route_id would be in other variant"
            ),
        }
    }

    #[test]
    fn install_not_found_config_from_json() {
        // Simulate the JSON payload the TS side sends for a catch-all route.
        let json = r#"[
            {"path":"/"},
            {"path":"","notFound":true,"notFoundPrefix":""}
        ]"#;
        let configs: Vec<RouteConfig> = serde_json::from_str(json).unwrap();
        assert!(configs[1].not_found, "not_found should be true");
        assert_eq!(configs[1].not_found_prefix, "");

        let mut table = RouteTable::new();
        table.install_with_config(&configs).unwrap();

        // Catch-all must NOT be in matchit — /home should not match /
        let headers = http::HeaderMap::new();
        // "/" is a real route (route_id 0)
        match table.match_path("GET", "/", &headers) {
            MatchResult::Matched { route_id, .. } => assert_eq!(route_id, 0),
            _other => panic!("expected Matched for /"),
        }
        // "/missing" should hit the catch-all (route_id 1)
        match table.match_path("GET", "/missing", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 1),
            _other => panic!("expected NotFound for /missing"),
        }
        // the catch-all envelope carries its own route_id and no params
        match table.match_path("GET", "/anything", &headers) {
            MatchResult::NotFound { envelope, .. } => {
                assert_eq!(envelope.route_id, 1);
                assert!(envelope.params.is_empty());
            }
            _other => panic!("expected NotFound for /anything"),
        }
    }

    #[test]
    fn install_nested_catchall_prefix_selection() {
        // /docs catch-all (route_id 2) should win over root (route_id 3) for /docs/missing
        let mut table = RouteTable::new();
        table
            .install_with_config(&[
                RouteConfig {
                    path: "/".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: "/docs/intro".into(),
                    cache: None,
                    not_found: false,
                    not_found_prefix: String::new(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: "/docs".into(),
                },
                RouteConfig {
                    path: String::new(),
                    cache: None,
                    not_found: true,
                    not_found_prefix: String::new(),
                },
            ])
            .unwrap();
        let headers = http::HeaderMap::new();
        // /docs/missing → docs catch-all (route_id 2)
        match table.match_path("GET", "/docs/missing", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 2),
            _other => panic!("expected NotFound with docs catch-all for /docs/missing"),
        }
        // /other → root catch-all (route_id 3)
        match table.match_path("GET", "/other", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 3),
            _other => panic!("expected NotFound with global catch-all for /other"),
        }
        // /docsearch → root (segment boundary respected)
        match table.match_path("GET", "/docsearch", &headers) {
            MatchResult::NotFound { route_id, .. } => assert_eq!(route_id, 3),
            _other => panic!("expected global catch-all for /docsearch (boundary)"),
        }
    }

    #[test]
    fn install_rejects_bad_prefix_expr() {
        let mut table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/bad".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: Some("or(cookie(x)".into()),
                bypass: None,
                tags: vec![],
            }),
            ..Default::default()
        }];
        let err = table.install_with_config(&cfgs).unwrap_err();
        assert!(
            matches!(
                err,
                RouteInstallError::CacheExpr {
                    field: "prefix",
                    ..
                }
            ),
            "expected CacheExpr error for malformed prefix, got {err:?}"
        );
    }

    #[test]
    fn install_rejects_bad_bypass_expr() {
        let mut table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/bad".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: None,
                bypass: Some(crate::manifest::BypassSpec::Expr("uuid(v4)".into())),
                tags: vec![],
            }),
            ..Default::default()
        }];
        let err = table.install_with_config(&cfgs).unwrap_err();
        assert!(
            matches!(
                err,
                RouteInstallError::CacheExpr {
                    field: "bypass",
                    ..
                }
            ),
            "expected CacheExpr error for non-deterministic bypass, got {err:?}"
        );
    }

    #[test]
    fn compiled_cache_for_parses_prefix_and_bypass() {
        let mut table = RouteTable::new();
        let cfgs = vec![RouteConfig {
            path: "/p".into(),
            cache: Some(crate::manifest::RouteCache {
                ttl_seconds: 60,
                prefix: Some("cookie(tenant)".into()),
                bypass: Some(crate::manifest::BypassSpec::Always(true)),
                tags: vec![],
            }),
            ..Default::default()
        }];
        table.install_with_config(&cfgs).unwrap();
        let cc = table.compiled_cache_for(0).expect("compiled cache present");
        assert!(cc.prefix.is_some());
        assert!(matches!(cc.bypass, Some(None)), "Always(true) ⇒ Some(None)");
    }

    #[test]
    fn from_manifest_installs_catch_all_outside_matchit() {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        let loaded = crate::manifest::Manifest::load(&dist).unwrap();
        let table = RouteTable::from_manifest(&loaded.manifest).unwrap();
        let headers = http::HeaderMap::new();
        match table.match_path("GET", "/nope", &headers) {
            MatchResult::NotFound { route_id, .. } => {
                assert_eq!(route_id, 3);
                assert_eq!(table.route_index(route_id), 3);
            }
            _other => panic!("expected NotFound for /nope"),
        }
        match table.match_path("GET", "/pokemon/pikachu", &headers) {
            MatchResult::Matched { route_id, envelope } => {
                assert_eq!(route_id, 1);
                assert_eq!(envelope.params[0].0.as_ref(), "name");
                assert_eq!(envelope.params[0].1.as_ref(), "pikachu");
            }
            _other => panic!("expected Matched for /pokemon/pikachu"),
        }
        let cc = table.compiled_cache_for(2).expect("r3 compiled cache");
        assert!(cc.prefix.is_some() && matches!(cc.bypass, Some(Some(_))));
        assert_eq!(
            table.cache_for(1).map(|c| c.tags),
            Some(vec!["pokemon".to_string()])
        );
    }

    fn cfg(path: &str, not_found: bool) -> RouteConfig {
        RouteConfig {
            path: path.into(),
            cache: None,
            not_found,
            not_found_prefix: String::new(),
        }
    }

    #[test]
    fn match_route_into_envelope_equals_match_path() {
        let mut table = RouteTable::new();
        table
            .install_with_config(&[cfg("/post/{slug}", false), cfg("", true)])
            .unwrap();
        let headers = hm(&[
            ("Host", "x"),
            ("Cookie", "a=1; b=2"),
            ("Cookie", "c=3"),
            ("X-Y", "z"),
        ]);
        for full in ["/post/sa%20wad?q=%41+b&k", "/nope?x=1", "/post/plain"] {
            let expected = match table.match_path("GET", full, &headers) {
                MatchResult::Matched { envelope, .. } | MatchResult::NotFound { envelope, .. } => {
                    serde_json::to_string(&envelope).unwrap()
                }
                MatchResult::NoMatch => panic!("no match for {full}"),
            };
            let query = full.split_once('?').map_or("", |(_, q)| q);
            let lazy = table
                .match_route(full)
                .unwrap()
                .into_envelope("GET", full, &headers, None);
            assert_eq!(serde_json::to_string(&lazy).unwrap(), expected, "{full}");
            let handed = table.match_route(full).unwrap().into_envelope(
                "GET",
                full,
                &headers,
                Some(decode_search(query)),
            );
            assert_eq!(serde_json::to_string(&handed).unwrap(), expected, "{full}");
        }
    }

    #[test]
    fn match_route_reports_catch_all_and_no_match() {
        let mut table = RouteTable::new();
        table.install_with_config(&[cfg("/a", false)]).unwrap();
        assert!(table.match_route("/zzz").is_none());
        let mut table = RouteTable::new();
        table
            .install_with_config(&[cfg("/a", false), cfg("", true)])
            .unwrap();
        let m = table.match_route("/zzz?x=1").unwrap();
        assert_eq!((m.route_id, m.not_found, m.params.len()), (1, true, 0));
        let m = table.match_route("/a").unwrap();
        assert_eq!((m.route_id, m.not_found), (0, false));
    }

    #[test]
    fn decode_search_is_the_envelope_search() {
        let q = "a=%41&b+c=1&&d";
        let headers = http::HeaderMap::new();
        let env = build_request_envelope("GET", "/x?a=%41&b+c=1&&d", q, &headers, None);
        assert_eq!(decode_search(q), env.search);
        assert!(decode_search("").is_empty());
    }

    // ---- L24: non-ASCII literal segments ----

    const NEWS: &str = "/ข่าว";
    const NEWS_ENC: &str = "/%E0%B8%82%E0%B9%88%E0%B8%B2%E0%B8%A7";

    fn table(paths: &[&str]) -> RouteTable {
        let configs: Vec<RouteConfig> = paths.iter().map(|p| cfg(p, false)).collect();
        let mut t = RouteTable::new();
        t.install_with_config(&configs).unwrap();
        t
    }

    fn route_of(t: &RouteTable, path: &str) -> Option<(u32, Vec<(String, String)>)> {
        t.match_route(path).map(|m| {
            (
                m.route_id,
                m.params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            )
        })
    }

    #[test]
    fn normalize_encodes_what_a_browser_encodes_and_never_decodes() {
        assert_eq!(normalize_request_path(NEWS), NEWS_ENC);
        assert_eq!(normalize_request_path("/a b"), "/a%20b");
        assert_eq!(normalize_request_path("/%e0%b8%82"), "/%E0%B8%82");
        // mixed: raw UTF-8 beside an existing escape
        assert_eq!(normalize_request_path("/ข/%e0"), "/%E0%B8%82/%E0");
        // ASCII and uppercase hex are untouched (and borrowed: no allocation on the hot path)
        for p in ["/", "/items/42", "/a%2Fb", "/%E0%B8%82", "/a~b-c_d.e"] {
            assert!(matches!(normalize_request_path(p), std::borrow::Cow::Borrowed(_)), "{p}");
            assert_eq!(normalize_request_path(p), p);
        }
        // %2F stays an escape (never turned into a slash); a lone or malformed % is left alone
        assert_eq!(normalize_request_path("/a%2fb"), "/a%2Fb");
        assert_eq!(normalize_request_path("/100%"), "/100%");
        assert_eq!(normalize_request_path("/%zz/ข"), "/%zz/%E0%B8%82");
    }

    #[test]
    fn normalize_route_pattern_keeps_params_verbatim() {
        assert_eq!(normalize_route_pattern("/ข่าว/{id}"), format!("{NEWS_ENC}/{{id}}"));
        assert_eq!(normalize_route_pattern("/docs/ภาษาไทย/{*rest}"), "/docs/%E0%B8%A0%E0%B8%B2%E0%B8%A9%E0%B8%B2%E0%B9%84%E0%B8%97%E0%B8%A2/{*rest}");
        assert_eq!(normalize_route_pattern("/items/{id}"), "/items/{id}");
    }

    #[test]
    fn thai_literal_route_matches_encoded_lowercase_hex_and_raw_utf8() {
        let t = table(&["/", NEWS]);
        for p in [NEWS_ENC, "/%e0%b8%82%e0%b9%88%e0%b8%b2%e0%b8%a7", NEWS, "/%e0%B8%82%E0%b9%88%E0%B8%b2%E0%B8%A7"] {
            assert_eq!(route_of(&t, p).map(|r| r.0), Some(1), "{p}");
        }
        // a query does not disturb it
        assert_eq!(route_of(&t, &format!("{NEWS_ENC}?q=1")).map(|r| r.0), Some(1));
        // and a neighbour does not match
        assert_eq!(route_of(&t, "/%E0%B8%82").map(|r| r.0), None);
    }

    #[test]
    fn thai_pattern_written_already_encoded_still_matches_everything() {
        let t = table(&[&NEWS_ENC.to_lowercase()]);
        assert_eq!(route_of(&t, NEWS).map(|r| r.0), Some(0));
        assert_eq!(route_of(&t, NEWS_ENC).map(|r| r.0), Some(0));
    }

    #[test]
    fn mixed_literal_and_param_decode_the_param_only() {
        let t = table(&["/ข่าว/{id}", "/docs/{name}/ภาษาไทย"]);
        let (id, params) = route_of(&t, &format!("{NEWS_ENC}/%E0%B8%AA%E0%B8%A7%E0%B8%B1%E0%B8%AA")).unwrap();
        assert_eq!((id, params), (0, vec![("id".into(), "สวัส".into())]));
        // raw UTF-8 in the param position decodes to the same value
        let (_, params) = route_of(&t, "/ข่าว/สวัส").unwrap();
        assert_eq!(params, vec![("id".to_string(), "สวัส".to_string())]);
        // %2F inside a param is a literal slash in the VALUE, not a segment boundary
        let (id, params) = route_of(&t, &format!("{NEWS_ENC}/a%2fb")).unwrap();
        assert_eq!((id, params), (0, vec![("id".into(), "a/b".into())]));
        assert_eq!(route_of(&t, &format!("{NEWS_ENC}/a/b")), None);
        let (id, params) = route_of(&t, "/docs/x%20y/%E0%B8%A0%E0%B8%B2%E0%B8%A9%E0%B8%B2%E0%B9%84%E0%B8%97%E0%B8%A2").unwrap();
        assert_eq!((id, params), (1, vec![("name".into(), "x y".into())]));
    }

    #[test]
    fn catch_all_prefix_in_thai_is_normalised_too() {
        let configs = vec![
            cfg("/", false),
            RouteConfig {
                path: "*".into(),
                cache: None,
                not_found: true,
                not_found_prefix: "/ข่าว".into(),
            },
        ];
        let mut t = RouteTable::new();
        t.install_with_config(&configs).unwrap();
        let m = t.match_route("/%E0%B8%82%E0%B9%88%E0%B8%B2%E0%B8%A7/nope").unwrap();
        assert!(m.not_found);
        assert_eq!(m.route_id, 1);
        assert!(t.match_route("/ข่าว/nope").unwrap().not_found);
    }

    #[test]
    fn cache_keys_share_one_entry_per_spelling() {
        use crate::cache::build_cache_key;
        let a = build_cache_key("GET", NEWS_ENC, String::new());
        let b = build_cache_key("GET", &NEWS_ENC.replace("%E0", "%e0"), String::new());
        let c = build_cache_key("GET", &format!("{NEWS}?b=2&a=1"), String::new());
        assert_eq!(a, b);
        assert_eq!(c.path, NEWS_ENC);
        assert_eq!(c.sorted_query, "a=1&b=2");
    }
}
