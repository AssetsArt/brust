//! Host-agnostic configuration types: CORS, actions, `cache.invalidate` arguments and the
//! `/_brust/cache/stats` shape. Moved from `brust-server/src/config.rs`, which keeps `Config`
//! (bind address, dist dir, TLS, tuning) and the native `Server` and re-exports these.
//!
//! `CorsConfig` is verbatim from brust-core `config.rs:27-78` @ d04718f.

use serde::{Deserialize, Serialize};

pub use crate::cache::CacheStats;
use crate::l2::L2Stats;
use crate::manifest::Manifest;

/// Global CORS policy, set once at boot (via `ServeOptions.cors` in the napi
/// binding). `None` (the default) = CORS disabled, byte-identical behavior.
///
/// Origin matching is an exact string match (scheme+host+port) against
/// `origins`; a list CONTAINING `"*"` is treated as wildcard (every origin
/// allowed, `Access-Control-Allow-Origin: *`), so `["*", "https://x.com"]`
/// cannot dodge the credentials+wildcard validation. No wildcard-subdomain
/// matching in v1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorsConfig {
    /// Allowed origins. `["*"]` (or any list containing `"*"`) = any origin.
    pub origins: Vec<String>,
    /// Preflight `Access-Control-Allow-Methods`. `None` → default
    /// `GET,POST,PUT,PATCH,DELETE,OPTIONS`.
    pub methods: Option<Vec<String>>,
    /// Preflight `Access-Control-Allow-Headers`. `None` → echo the request's
    /// `Access-Control-Request-Headers`.
    pub headers: Option<Vec<String>>,
    /// `Access-Control-Expose-Headers` on actual responses. `None` → none.
    pub expose_headers: Option<Vec<String>>,
    /// Emit `Access-Control-Allow-Credentials: true`. INVALID with a wildcard
    /// origin — [`CorsConfig::validate`] rejects the combination at boot.
    pub credentials: bool,
    /// Preflight `Access-Control-Max-Age` seconds. `None` → 600.
    pub max_age_seconds: Option<u32>,
}

impl CorsConfig {
    /// True when the configured origin list contains the literal `"*"`.
    pub fn is_wildcard(&self) -> bool {
        self.origins.iter().any(|o| o == "*")
    }

    /// Boot-time validation (the napi binding mirrors this on the TS side):
    /// `origins` must be non-empty, and `credentials` may not be combined with
    /// a wildcard origin (browsers silently reject that combination — make it
    /// loud at boot instead).
    pub fn validate(&self) -> Result<(), String> {
        if self.origins.is_empty() {
            return Err("cors.origins must be non-empty".to_string());
        }
        if self.credentials && self.is_wildcard() {
            return Err(
                "cors.credentials cannot be combined with a wildcard origin '*' \
                 (browsers reject Access-Control-Allow-Origin: * with credentials); \
                 list explicit origins instead"
                    .to_string(),
            );
        }
        Ok(())
    }
}

/// 0.1.x defaults (E1).
pub const DEFAULT_ACTION_PREFIX: &str = "/_brust/action";
pub const DEFAULT_MAX_ACTION_BODY_BYTES: usize = 1_048_576;
/// F82: default cap on an action response body (the heap-transferred part).
pub const DEFAULT_MAX_ACTION_RESPONSE_BYTES: usize = 8_388_608;
/// F82: upper bound for both `max_body_bytes` and `max_response_bytes`.
pub const MAX_ACTION_BYTES: usize = 67_108_864;
/// F82: a request body of at most this many bytes crosses inline (`text`/`b64`); larger goes by
/// heap transfer. Equals the worker's SAB slot size.
pub const ACTION_INLINE_BODY_BYTES: usize = 262_144;
/// F475: `max_stream_bytes` default (256 MiB) and hard max (4 GiB), `stream_idle_ms` and
/// `stream_total_ms` defaults.
pub const DEFAULT_MAX_STREAM_BYTES: u64 = 268_435_456;
pub const MAX_STREAM_BYTES: u64 = 4_294_967_296;
pub const DEFAULT_STREAM_IDLE_MS: u64 = 30_000;
pub const DEFAULT_STREAM_TOTAL_MS: u64 = 900_000;
/// Paths the actions prefix may not overlap in either direction (R7).
const RESERVED: &[&str] = &["/ping", "/public", "/_brust/client", "/_brust/cache"];

/// M3-F E1/E3: the actions subtree. `None` in [`Config`] = no actions (byte-identical server).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionsConfig {
    pub prefix: String,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
    pub cross_site: CrossSite,
    /// F475: the routes whose request body streams to the app instead of being buffered.
    pub stream: StreamConfig,
}

/// F475 `[actions] stream = ["POST /upload", "PUT /files/*"]` and its bounds. A listed request's body
/// is not read before the call: the app pulls it (`{ parse: 'none' }`), up to `max_bytes`, with no
/// pause over `idle_ms` and the whole call within `total_ms`; at most `max_streams` at once
/// (`None` = a quarter of the live worker slots, at least 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamConfig {
    pub routes: Vec<StreamRoute>,
    pub max_bytes: u64,
    pub idle_ms: u64,
    pub total_ms: u64,
    pub max_streams: Option<u32>,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            routes: Vec::new(),
            max_bytes: DEFAULT_MAX_STREAM_BYTES,
            idle_ms: DEFAULT_STREAM_IDLE_MS,
            total_ms: DEFAULT_STREAM_TOTAL_MS,
            max_streams: None,
        }
    }
}

/// One `stream` entry, `"<METHOD> <path>"` with the path relative to the prefix. A `:name` segment
/// matches one segment; a final `*` matches one or more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamRoute {
    pub method: String,
    pub path: String,
}

impl StreamRoute {
    /// Parse `"POST /upload"`. Only POST, PUT and PATCH carry a streamed body.
    pub fn parse(entry: &str) -> Result<Self, String> {
        let (m, p) = entry
            .trim()
            .split_once(' ')
            .ok_or_else(|| format!("stream entry {entry:?} must be \"<METHOD> <path>\""))?;
        let (method, path) = (m.to_ascii_uppercase(), p.trim().to_string());
        if !matches!(method.as_str(), "POST" | "PUT" | "PATCH") {
            return Err(format!(
                "stream entry {entry:?}: method must be POST, PUT or PATCH"
            ));
        }
        let segs: Vec<&str> = path.split('/').skip(1).collect();
        let bad_star = segs
            .iter()
            .enumerate()
            .any(|(i, s)| s.contains('*') && (*s != "*" || i + 1 != segs.len()));
        if !path.starts_with('/') || (path != "/" && segs.iter().any(|s| s.is_empty())) || bad_star
        {
            return Err(format!(
                "stream entry {entry:?}: path must start with '/', have no empty segment, and use '*' only as the last segment"
            ));
        }
        Ok(Self { method, path })
    }

    /// Does `method` + `rel` (the request path relative to the prefix, no query) name this route?
    pub fn matches(&self, method: &str, rel: &str) -> bool {
        if !method.eq_ignore_ascii_case(&self.method) {
            return false;
        }
        let mut want = self.path.split('/').skip(1);
        let mut got = rel.split('/').skip(1);
        loop {
            match (want.next(), got.next()) {
                (None, None) => return true,
                (Some("*"), Some(g)) => return !g.is_empty(),
                (Some(w), Some(g)) if w.starts_with(':') => {
                    if g.is_empty() {
                        return false;
                    }
                }
                (Some(w), Some(g)) if w == g => {}
                _ => return false,
            }
        }
    }
}

/// F87 / spec E10: what Rust does with a mutating action request whose browser-declared site is foreign.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CrossSite {
    /// 403 before the body is read, unless `[cors]` allows the `Origin`.
    #[default]
    Reject,
    /// Forward everything (a public API consumed cross-origin).
    Allow,
}

impl Default for ActionsConfig {
    fn default() -> Self {
        Self {
            prefix: DEFAULT_ACTION_PREFIX.into(),
            max_body_bytes: DEFAULT_MAX_ACTION_BODY_BYTES,
            max_response_bytes: DEFAULT_MAX_ACTION_RESPONSE_BYTES,
            cross_site: CrossSite::default(),
            stream: StreamConfig::default(),
        }
    }
}

/// L16 R16.2: the `fetch` credentials the browser client defaults to (`[actions] credentials`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ActionCredentials {
    #[default]
    SameOrigin,
    Include,
    Omit,
}

impl ActionCredentials {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SameOrigin => "same-origin",
            Self::Include => "include",
            Self::Omit => "omit",
        }
    }
}

/// L16 R16.1/R16.2: what the page tells the browser's `client()`: where the actions live. Independent of
/// [`ActionsConfig`]: a page-only build points at a remote app and mounts no local one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionsClient {
    /// Injected only when not the default prefix.
    pub prefix: Option<String>,
    /// An absolute http(s) origin, no path, query or fragment.
    pub base_url: Option<String>,
    pub credentials: ActionCredentials,
}

impl ActionsClient {
    /// `start` prefixes the message with `actions: `.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(b) = &self.base_url {
            let rest = b
                .strip_prefix("https://")
                .or_else(|| b.strip_prefix("http://"))
                .ok_or_else(|| format!("base_url must be an absolute http(s) origin: {b:?}"))?;
            if rest.is_empty()
                || rest.bytes().any(|c| {
                    matches!(c, b'/' | b'?' | b'#' | b'@' | b'\\') || c <= b' ' || c == 0x7f
                })
            {
                return Err(format!(
                    "base_url must be an origin only (scheme, host, optional port; no path, query, fragment or credentials): {b:?}"
                ));
            }
        }
        Ok(())
    }

    /// The `<script>` tags for the page head: the prefix one (unchanged since M3-F A4), then one for the base
    /// and the credentials default. A JSON string literal with `<`, `>`, `&`, U+2028 and U+2029 escaped.
    pub fn tags(&self) -> Option<String> {
        self.tags_under("")
    }

    /// [`tags`](Self::tags) for an app mounted under `base` (F495): the prefix the client assumes by default is
    /// `<base>/_brust/action`, so that one is not injected either.
    pub fn tags_under(&self, base: &str) -> Option<String> {
        let default = format!("{base}{DEFAULT_ACTION_PREFIX}");
        let mut out = String::new();
        if let Some(p) = self.prefix.as_deref().filter(|p| **p != default) {
            out.push_str(&format!(
                "<script>globalThis.__BRUST_ACTION_PREFIX__=\"{p}\"</script>"
            ));
        }
        let mut stmts = Vec::new();
        if let Some(b) = &self.base_url {
            stmts.push(format!("globalThis.__BRUST_ACTION_BASE__={}", js_string(b)));
        }
        if self.credentials != ActionCredentials::SameOrigin {
            stmts.push(format!(
                "globalThis.__BRUST_ACTION_CREDENTIALS__={}",
                js_string(self.credentials.as_str())
            ));
        }
        if !stmts.is_empty() {
            out.push_str(&format!("<script>{}</script>", stmts.join(";")));
        }
        (!out.is_empty()).then_some(out)
    }
}

/// A JS string literal that is also safe inside `<script>`.
pub(crate) fn js_string(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '<' => o.push_str("\\u003c"),
            '>' => o.push_str("\\u003e"),
            '&' => o.push_str("\\u0026"),
            '\u{2028}' => o.push_str("\\u2028"),
            '\u{2029}' => o.push_str("\\u2029"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// 0.1.x `path_under_action_prefix` (brust-core config.rs:358-363): `path` is `p` or lies under it.
pub(crate) fn under(path: &str, p: &str) -> bool {
    path == p || (path.len() > p.len() && path.as_bytes()[p.len()] == b'/' && path.starts_with(p))
}

impl ActionsConfig {
    pub fn is_under(&self, path: &str) -> bool {
        if self.prefix == "/" {
            // L16 R16.4: the root prefix of an actions-only build answers everything but the server's own paths.
            return path.starts_with('/')
                && path != "/ping"
                && !under(path, "/_brust")
                && !under(path, "/public");
        }
        under(path, &self.prefix)
    }

    /// F475: is a request with this method and path (`path?query` as received, already under the
    /// prefix) on the `stream` list?
    pub fn streams(&self, method: &str, full: &str) -> bool {
        if self.stream.routes.is_empty() {
            return false;
        }
        let path = full.split_once('?').map_or(full, |(p, _)| p);
        let rel = if self.prefix == "/" {
            path
        } else {
            match &path[self.prefix.len().min(path.len())..] {
                "" => "/",
                r => r,
            }
        };
        self.stream.routes.iter().any(|r| r.matches(method, rel))
    }

    pub fn is_default_prefix(&self) -> bool {
        self.prefix == DEFAULT_ACTION_PREFIX
    }

    /// F495: the prefix a build with no `[actions] prefix` uses under `base`.
    pub fn default_prefix_under(base: &str) -> String {
        format!("{base}{DEFAULT_ACTION_PREFIX}")
    }

    /// R7; `start` prefixes the message with `actions: `.
    pub fn validate(&self, m: &Manifest) -> Result<(), String> {
        let p = self.prefix.as_str();
        if p == "/" {
            // L16 R16.4: only an actions-only build (no page routes) may mount at the root.
            if !m.actions_only {
                return Err(
                    "prefix \"/\" is only allowed in an actions-only build (brust build --actions-only)"
                        .into(),
                );
            }
            return self.validate_limits();
        }
        let seg_ok = |s: &str| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
        };
        if !p.starts_with('/') || p.len() < 2 || p.ends_with('/') || !p[1..].split('/').all(seg_ok)
        {
            return Err(format!(
                "prefix must start with '/', must not end with '/', and each segment must be \
                 [A-Za-z0-9._~-] (not '.' or '..'): {p:?}"
            ));
        }
        // F495: the app's own URLs live under `base_path`, and so must the actions.
        let base = m.base_path.as_str();
        if !base.is_empty() && !under(p, base) {
            return Err(format!("prefix {p:?} must lie under base_path {base:?}"));
        }
        if let Some(r) = RESERVED.iter().find(|r| {
            let r = format!("{base}{r}");
            under(p, &r) || under(&r, p)
        }) {
            return Err(format!(
                "prefix {p:?} overlaps the reserved path \"{base}{r}\""
            ));
        }
        // F470: a route under the prefix answers GET/HEAD of its own paths (the pipeline); the prefix itself stays the
        // actions app's mount point, and a `{*rest}` route there would take every GET from it.
        if let Some(rt) = m
            .routes
            .iter()
            .find(|rt| rt.pattern == *p || (under(&rt.pattern, p) && rt.pattern.contains("{*")))
        {
            return Err(format!("prefix {p:?} shadows route {:?}", rt.pattern));
        }
        self.validate_limits()
    }

    fn validate_limits(&self) -> Result<(), String> {
        if !(1..=MAX_ACTION_BYTES).contains(&self.max_body_bytes) {
            return Err(format!("maxBodyBytes must be in 1..={MAX_ACTION_BYTES}"));
        }
        if !(ACTION_INLINE_BODY_BYTES..=MAX_ACTION_BYTES).contains(&self.max_response_bytes) {
            return Err(format!(
                "maxResponseBytes must be in {ACTION_INLINE_BODY_BYTES}..={MAX_ACTION_BYTES}"
            ));
        }
        let st = &self.stream;
        if !(1..=MAX_STREAM_BYTES).contains(&st.max_bytes) {
            return Err(format!("maxStreamBytes must be in 1..={MAX_STREAM_BYTES}"));
        }
        if st.idle_ms == 0 || st.total_ms == 0 {
            return Err("streamIdleMs and streamTotalMs must be at least 1".into());
        }
        if st.max_streams == Some(0) {
            return Err("maxStreams must be at least 1".into());
        }
        Ok(())
    }
}

/// `cache.invalidate({ key?, tags?, path?, method?, prefix? })` (spec §5).
///
/// `prefix` (F493) narrows the page (L1/L2) invalidation to entries whose evaluated, stored key
/// prefix equals it exactly (`""` = routes with no prefix): with `path` that path of that prefix,
/// with `tags` that prefix's tagged pages (the job cache is not touched: job keys carry no prefix),
/// alone every page of that prefix. It cannot be combined with `key` ([`InvalidateArgs::validate`]).
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct InvalidateArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// The refusal text for `prefix` with `key` (the TS `cache.invalidate` throws the same).
pub const PREFIX_WITH_KEY: &str = "cache.invalidate: `prefix` narrows page entries; `key` names a job entry — call them separately";

impl InvalidateArgs {
    /// `prefix` together with `key` is refused (F493): `prefix` narrows page entries, `key` names a
    /// job entry. Hosts call this before [`crate::core::Core::invalidate`].
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.prefix.is_some() && self.key.is_some() {
            return Err(PREFIX_WITH_KEY);
        }
        Ok(())
    }
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct InvalidateResult {
    pub l1_removed: usize,
    pub job_removed: usize,
}

/// Who may read `/_brust/cache/stats` (F507). A request that is not allowed gets what any unknown path gets (404), so
/// the endpoint is not revealed. `Off` is the default of the core and of `brust start`; `brust dev` sets `Public`.
#[derive(Clone, Default, PartialEq, Eq)]
pub enum StatsAccess {
    /// Nobody: the path answers 404.
    #[default]
    Off,
    /// Anybody who reaches the app.
    Public,
    /// A request carrying `Authorization: Bearer <this token>`.
    Token(String),
}

// The token is a secret: never printed with the config.
impl std::fmt::Debug for StatsAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str("Off"),
            Self::Public => f.write_str("Public"),
            Self::Token(_) => f.write_str("Token(<redacted>)"),
        }
    }
}

impl StatsAccess {
    /// `mode` is `"off"`, `"public"` or `"token"` (what `[server] stats` says); `token` is the resolved secret and
    /// belongs to `"token"` only.
    pub fn parse(mode: &str, token: Option<String>) -> Result<Self, String> {
        match (mode, token) {
            ("off", None) => Ok(Self::Off),
            ("public", None) => Ok(Self::Public),
            ("token", Some(t)) if !t.is_empty() => Ok(Self::Token(t)),
            ("token", _) => Err("stats = \"token\" needs a non-empty token".into()),
            ("off" | "public", Some(_)) => Err(format!(
                "a stats token belongs to stats = \"token\", not \"{mode}\""
            )),
            _ => Err(format!(
                "stats must be \"off\", \"public\" or \"token\" (got \"{mode}\")"
            )),
        }
    }

    /// Whether a request with these headers may read the stats.
    pub fn allows(&self, headers: &http::HeaderMap) -> bool {
        match self {
            Self::Off => false,
            Self::Public => true,
            Self::Token(t) => bearer(headers).is_some_and(|got| ct_eq(got, t.as_bytes())),
        }
    }
}

/// The token of an `Authorization: Bearer <token>` header (the scheme is case-insensitive).
fn bearer(headers: &http::HeaderMap) -> Option<&[u8]> {
    let v = headers.get(http::header::AUTHORIZATION)?.as_bytes();
    let (scheme, rest) = (v.get(..7)?, v.get(7..)?);
    scheme.eq_ignore_ascii_case(b"bearer ").then_some(rest)
}

/// Equality that takes the same time for every input of the same length (and never stops at the first difference).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    std::hint::black_box(diff) == 0
}

/// `/_brust/cache/stats` (spec §7).
#[derive(Debug, Serialize)]
pub struct Stats {
    pub l1: CacheStats,
    pub job: CacheStats,
    pub loader_calls: u64,
    /// Job batches the worker ran: a `jobs` call, or the misses of a planned loader call (M3-P P6).
    pub job_calls: u64,
    /// Worker round trips (M3-P P6): the sum of every request's `bun_calls`.
    pub worker_calls: u64,
    /// Worker calls answered 504 by the call deadline.
    pub timed_out_calls: u64,
    /// Distinct (component, slot) pairs whose job result lacked a declared output (an older
    /// `dist/jobs.js`); the slot renders empty and is warned once.
    pub missing_slots: u64,
    /// The cache adapter's counters; absent (and the JSON byte-identical) without an adapter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l2: Option<L2Stats>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_manifest() -> Manifest {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../brust-server/tests/fixtures/dist");
        Manifest::load(&dist).expect("fixture manifest").manifest
    }

    #[test]
    fn client_tags_escape_and_validate() {
        let c = ActionsClient {
            prefix: Some("/api".into()),
            base_url: Some("https://api.example.com:8443".into()),
            credentials: ActionCredentials::Include,
        };
        assert!(c.validate().is_ok());
        assert_eq!(
            c.tags().unwrap(),
            "<script>globalThis.__BRUST_ACTION_PREFIX__=\"/api\"</script><script>globalThis.__BRUST_ACTION_BASE__=\"https://api.example.com:8443\";globalThis.__BRUST_ACTION_CREDENTIALS__=\"include\"</script>"
        );
        assert_eq!(ActionsClient::default().tags(), None);
        let d = ActionsClient {
            prefix: Some(DEFAULT_ACTION_PREFIX.into()),
            ..Default::default()
        };
        assert_eq!(
            d.tags(),
            None,
            "the default prefix and same-origin inject nothing"
        );
        // the escape table
        assert_eq!(
            js_string("a<b>&\"\\\u{2028}\u{2029}\n"),
            "\"a\\u003cb\\u003e\\u0026\\\"\\\\\\u2028\\u2029\\u000a\""
        );
        for bad in [
            "x.com",
            "https://",
            "http://a/b",
            "http://a?x",
            "http://a#x",
            "http://u@a",
            "http://a b",
            "ws://a",
        ] {
            let c = ActionsClient {
                base_url: Some(bad.into()),
                ..Default::default()
            };
            assert!(c.validate().is_err(), "{bad}");
        }
    }

    /// F495: the default prefix the client assumes moves under the base path, so it is the one not injected.
    #[test]
    fn the_client_prefix_script_follows_the_base_path() {
        let under = ActionsClient {
            prefix: Some("/portal/_brust/action".into()),
            ..Default::default()
        };
        assert_eq!(
            under.tags_under("/portal"),
            None,
            "the default under the base"
        );
        assert!(
            under
                .tags_under("")
                .unwrap()
                .contains("/portal/_brust/action")
        );
        let own = ActionsClient {
            prefix: Some("/portal/api".into()),
            ..Default::default()
        };
        assert_eq!(
            own.tags_under("/portal").unwrap(),
            "<script>globalThis.__BRUST_ACTION_PREFIX__=\"/portal/api\"</script>"
        );
        assert_eq!(
            ActionsConfig::default_prefix_under("/portal"),
            "/portal/_brust/action"
        );
    }

    #[test]
    fn the_actions_prefix_must_lie_under_the_base_path_and_keep_off_its_reserved_paths() {
        let mut m = fixture_manifest();
        m.base_path = "/portal".into();
        assert!(with_prefix("/portal/_brust/action").validate(&m).is_ok());
        assert!(with_prefix("/portal/api").validate(&m).is_ok());
        let e = with_prefix("/api").validate(&m).unwrap_err();
        assert!(e.contains("must lie under base_path"), "{e}");
        for p in ["/portal/ping", "/portal/public", "/portal/_brust/cache"] {
            let e = with_prefix(p).validate(&m).unwrap_err();
            assert!(e.contains("overlaps the reserved path"), "{p}: {e}");
        }
        // the root app's reserved paths are free under a base (they are another app's)
        assert!(with_prefix("/portal/x").validate(&m).is_ok());
    }

    #[test]
    fn root_prefix_matches_everything_but_the_servers_own_paths() {
        let a = with_prefix("/");
        for p in ["/", "/team", "/a/b/c"] {
            assert!(a.is_under(p), "{p}");
        }
        for p in [
            "/ping",
            "/_brust/cache/stats",
            "/_brust/client/x.js",
            "/public/a.css",
        ] {
            assert!(!a.is_under(p), "{p}");
        }
    }

    fn with_prefix(p: &str) -> ActionsConfig {
        ActionsConfig {
            prefix: p.into(),
            ..Default::default()
        }
    }

    /// 0.1.x brust `lib.rs:645-655`, extended.
    #[test]
    fn prefix_match_is_segment_safe() {
        let a = ActionsConfig::default();
        for p in [
            "/_brust/action",
            "/_brust/action/notes",
            "/_brust/action/notes/5",
        ] {
            assert!(a.is_under(p), "{p} should be under the prefix");
        }
        for p in [
            "/_brust/actionXYZ",
            "/_brust/act",
            "/other",
            "/_brust/action2/x",
        ] {
            assert!(!a.is_under(p), "{p} should not be under the prefix");
        }
    }

    #[test]
    fn actions_validation_table() {
        let m = fixture_manifest();
        for p in ["/_brust/action", "/api", "/api/v1", "/a.b~c-d_e"] {
            assert_eq!(with_prefix(p).validate(&m), Ok(()), "{p:?}");
        }
        for p in [
            "", "api", "/", "/api/", "/a//b", "/a/./b", "/a/../b", "/a b", "/a?x", "/a%2Fb",
        ] {
            let e = with_prefix(p).validate(&m).expect_err(p);
            assert!(e.contains(&format!("{p:?}")), "{p:?}: {e}");
        }
        for p in [
            "/ping",
            "/public",
            "/public/x",
            "/_brust",
            "/_brust/client",
            "/_brust/client/x",
            "/_brust/cache",
            "/_brust/cache/stats",
        ] {
            let e = with_prefix(p).validate(&m).expect_err(p);
            assert!(e.contains("reserved"), "{p:?}: {e}");
        }
        let zero = ActionsConfig {
            max_body_bytes: 0,
            ..Default::default()
        };
        assert!(zero.validate(&m).is_err());
        let body = |n: usize| ActionsConfig {
            max_body_bytes: n,
            ..Default::default()
        };
        assert_eq!(body(67_108_864).validate(&m), Ok(()));
        let e = body(67_108_865).validate(&m).expect_err("body over cap");
        assert!(e.contains("maxBodyBytes"), "{e}");
        let resp = |n: usize| ActionsConfig {
            max_response_bytes: n,
            ..Default::default()
        };
        for n in [262_144, 8_388_608, 67_108_864] {
            assert_eq!(resp(n).validate(&m), Ok(()), "{n}");
        }
        for n in [262_143, 67_108_865] {
            let e = resp(n).validate(&m).expect_err("resp bounds");
            assert!(e.contains("maxResponseBytes"), "{e}");
        }
    }

    #[test]
    fn stream_routes_parse_and_match() {
        let r = |e: &str| StreamRoute::parse(e).unwrap();
        assert_eq!(
            r("post /upload"),
            StreamRoute {
                method: "POST".into(),
                path: "/upload".into()
            }
        );
        for bad in [
            "GET /x",
            "POST",
            "POST upload",
            "POST /a//b",
            "POST /a/*/b",
            "POST /a*",
            "POST /a/",
        ] {
            assert!(StreamRoute::parse(bad).is_err(), "{bad:?}");
        }
        assert!(r("POST /upload").matches("post", "/upload"));
        assert!(!r("POST /upload").matches("PUT", "/upload"));
        assert!(!r("POST /upload").matches("POST", "/upload/x"));
        assert!(r("PUT /files/*").matches("PUT", "/files/a"));
        assert!(r("PUT /files/*").matches("PUT", "/files/a/b"));
        assert!(!r("PUT /files/*").matches("PUT", "/files"));
        assert!(!r("PUT /files/*").matches("PUT", "/files/"));
        assert!(r("PATCH /a/:id/b").matches("PATCH", "/a/7/b"));
        assert!(!r("PATCH /a/:id/b").matches("PATCH", "/a//b"));
        assert!(r("POST /").matches("POST", "/"));
    }

    #[test]
    fn streams_matches_relative_to_the_prefix_without_the_query() {
        let mut a = with_prefix("/api");
        a.stream.routes = vec![StreamRoute::parse("POST /upload").unwrap()];
        assert!(a.streams("POST", "/api/upload?x=1"));
        assert!(!a.streams("POST", "/api/uploadx"));
        assert!(!a.streams("POST", "/api"));
        let mut root = with_prefix("/");
        root.stream.routes = vec![StreamRoute::parse("POST /").unwrap()];
        assert!(root.streams("POST", "/"));
        let mut at = with_prefix("/api");
        at.stream.routes = vec![StreamRoute::parse("POST /").unwrap()];
        assert!(at.streams("POST", "/api"));
        assert!(!ActionsConfig::default().streams("POST", "/_brust/action/x"));
    }

    #[test]
    fn stream_limits_are_validated() {
        let m = fixture_manifest();
        let with = |f: fn(&mut StreamConfig)| {
            let mut a = ActionsConfig::default();
            f(&mut a.stream);
            a.validate(&m)
        };
        assert_eq!(with(|s| s.max_bytes = MAX_STREAM_BYTES), Ok(()));
        assert!(
            with(|s| s.max_bytes = MAX_STREAM_BYTES + 1)
                .unwrap_err()
                .contains("maxStreamBytes")
        );
        assert!(with(|s| s.max_bytes = 0).is_err());
        assert!(with(|s| s.idle_ms = 0).is_err());
        assert!(with(|s| s.total_ms = 0).is_err());
        assert!(with(|s| s.max_streams = Some(0)).is_err());
        assert_eq!(with(|s| s.max_streams = Some(1)), Ok(()));
    }

    #[test]
    fn actions_prefix_may_not_be_a_route_or_hold_a_rest_route() {
        let m = fixture_manifest();
        // F470: a route under the prefix is fine (it answers GET there); the prefix itself is not
        assert_eq!(with_prefix("/pokemon").validate(&m), Ok(()));
        let e = with_prefix("/tenant").validate(&m).unwrap_err();
        assert!(e.contains(r#"shadows route "/tenant""#), "{e}");
        assert_eq!(with_prefix("/poke").validate(&m), Ok(()));
        let mut rest = fixture_manifest();
        rest.routes[1].pattern = "/pokemon/{*rest}".into();
        let e = with_prefix("/pokemon").validate(&rest).unwrap_err();
        assert!(e.contains(r#"shadows route "/pokemon/{*rest}""#), "{e}");
    }

    /// R3: `/_brust/cache/stats` keeps its exact shape — every key, in order — after the move.
    #[test]
    fn stats_json_shape_is_stable() {
        let c = |base: u64| CacheStats {
            hits: base,
            misses: base + 1,
            len: (base + 2) as usize,
            capacity: (base + 3) as usize,
        };
        let s = Stats {
            l1: c(1),
            job: c(11),
            loader_calls: 5,
            job_calls: 6,
            worker_calls: 7,
            timed_out_calls: 8,
            missing_slots: 9,
            l2: None,
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"l1":{"hits":1,"misses":2,"len":3,"capacity":4},"job":{"hits":11,"misses":12,"len":13,"capacity":14},"loader_calls":5,"job_calls":6,"worker_calls":7,"timed_out_calls":8,"missing_slots":9}"#
        );
    }

    #[test]
    fn stats_access_parses_the_three_modes_and_refuses_the_rest() {
        assert_eq!(StatsAccess::parse("off", None), Ok(StatsAccess::Off));
        assert_eq!(StatsAccess::parse("public", None), Ok(StatsAccess::Public));
        assert_eq!(
            StatsAccess::parse("token", Some("s3".into())),
            Ok(StatsAccess::Token("s3".into()))
        );
        for (mode, token) in [
            ("token", None),
            ("token", Some("")),
            ("off", Some("x")),
            ("public", Some("x")),
            ("maybe", None),
        ] {
            assert!(
                StatsAccess::parse(mode, token.map(String::from)).is_err(),
                "{mode} {token:?}"
            );
        }
        assert_eq!(StatsAccess::default(), StatsAccess::Off);
    }

    #[test]
    fn stats_access_allows_by_mode_and_the_bearer_token() {
        let with = |v: Option<&str>| {
            let mut h = http::HeaderMap::new();
            if let Some(v) = v {
                h.insert(http::header::AUTHORIZATION, v.parse().unwrap());
            }
            h
        };
        assert!(!StatsAccess::Off.allows(&with(Some("Bearer s3"))));
        assert!(StatsAccess::Public.allows(&with(None)));
        let t = StatsAccess::Token("s3cret".into());
        assert!(t.allows(&with(Some("Bearer s3cret"))));
        assert!(t.allows(&with(Some("bearer s3cret"))));
        for bad in [
            None,
            Some("Bearer s3cre"),
            Some("Bearer s3cretX"),
            Some("Bearer "),
            Some("Bearer"),
            Some("Basic s3cret"),
            Some("s3cret"),
        ] {
            assert!(!t.allows(&with(bad)), "{bad:?}");
        }
        assert_eq!(format!("{t:?}"), "Token(<redacted>)");
    }

    #[test]
    fn stats_with_l2_appends_the_object() {
        let c = CacheStats {
            hits: 0,
            misses: 0,
            len: 0,
            capacity: 0,
        };
        let s = Stats {
            l1: c.clone(),
            job: c,
            loader_calls: 0,
            job_calls: 0,
            worker_calls: 0,
            timed_out_calls: 0,
            missing_slots: 0,
            l2: Some(crate::l2::L2Counters::default().snapshot("custom")),
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(
            j.ends_with(r#","missing_slots":0,"l2":{"adapter":"custom","hits":0,"misses":0,"timeouts":0,"errors":0,"rejected_floor":0,"sets":0,"set_refused":0,"set_dropped":0,"set_oversize":0,"published":0,"publish_errors":0,"received":0,"skipped_own":0,"resets":0,"epoch_polls":0,"poll_errors":0}}"#),
            "{j}"
        );
    }

    #[test]
    fn invalidate_args_serialize_skips_empty() {
        let a = InvalidateArgs {
            tags: vec!["a".into()],
            path: Some("/x".into()),
            ..Default::default()
        };
        let j = serde_json::to_string(&a).unwrap();
        assert_eq!(j, r#"{"tags":["a"],"path":"/x"}"#);
        assert_eq!(serde_json::from_str::<InvalidateArgs>(&j).unwrap(), a);
    }

    #[test]
    fn invalidate_args_prefix_round_trips_and_refuses_key() {
        let a = InvalidateArgs {
            path: Some("/x".into()),
            prefix: Some(String::new()),
            ..Default::default()
        };
        let j = serde_json::to_string(&a).unwrap();
        assert_eq!(j, r#"{"path":"/x","prefix":""}"#);
        assert_eq!(serde_json::from_str::<InvalidateArgs>(&j).unwrap(), a);
        assert_eq!(a.validate(), Ok(()));
        let both = InvalidateArgs {
            key: Some("k".into()),
            prefix: Some("a.test".into()),
            ..Default::default()
        };
        assert_eq!(both.validate(), Err(PREFIX_WITH_KEY));
    }
}
