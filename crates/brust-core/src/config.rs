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
/// Paths the actions prefix may not overlap in either direction (R7).
const RESERVED: &[&str] = &["/ping", "/public", "/_brust/client", "/_brust/cache"];

/// M3-F E1/E3: the actions subtree. `None` in [`Config`] = no actions (byte-identical server).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionsConfig {
    pub prefix: String,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
    pub cross_site: CrossSite,
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
        let mut out = String::new();
        if let Some(p) = self
            .prefix
            .as_deref()
            .filter(|p| *p != DEFAULT_ACTION_PREFIX)
        {
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
fn js_string(s: &str) -> String {
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

    pub fn is_default_prefix(&self) -> bool {
        self.prefix == DEFAULT_ACTION_PREFIX
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
        if let Some(r) = RESERVED.iter().find(|r| under(p, r) || under(r, p)) {
            return Err(format!("prefix {p:?} overlaps the reserved path {r:?}"));
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
        Ok(())
    }
}

/// `cache.invalidate({ key?, tags?, path?, method? })` (spec §5).
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
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct InvalidateResult {
    pub l1_removed: usize,
    pub job_removed: usize,
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
}
