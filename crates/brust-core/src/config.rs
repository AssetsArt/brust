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

/// 0.1.x `path_under_action_prefix` (brust-core config.rs:358-363): `path` is `p` or lies under it.
pub(crate) fn under(path: &str, p: &str) -> bool {
    path == p || (path.len() > p.len() && path.as_bytes()[p.len()] == b'/' && path.starts_with(p))
}

impl ActionsConfig {
    pub fn is_under(&self, path: &str) -> bool {
        under(path, &self.prefix)
    }

    pub fn is_default_prefix(&self) -> bool {
        self.prefix == DEFAULT_ACTION_PREFIX
    }

    /// R7; `start` prefixes the message with `actions: `.
    pub fn validate(&self, m: &Manifest) -> Result<(), String> {
        let p = self.prefix.as_str();
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
        if let Some(rt) = m.routes.iter().find(|rt| {
            let head = rt.pattern.split('{').next().unwrap_or("");
            under(head.trim_end_matches('/'), p) || under(head, p)
        }) {
            return Err(format!("prefix {p:?} shadows route {:?}", rt.pattern));
        }
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
    fn actions_prefix_may_not_shadow_a_route() {
        let m = fixture_manifest();
        let e = with_prefix("/pokemon").validate(&m).unwrap_err();
        assert!(e.contains(r#"shadows route "/pokemon/{name}""#), "{e}");
        assert_eq!(with_prefix("/poke").validate(&m), Ok(()));
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
