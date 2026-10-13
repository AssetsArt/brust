//! The dev trace (L14, R14.1): what one page request did, for `brust dev`'s tools. Collected only when the
//! core was started with a dev token AND the request carries it (`x-brust-dev-token`, sent only by the dev
//! proxy); answered as `x-brust-dev: base64(json)` after the L1 store, so it is never cached. In production
//! (`dev_token == None`) the whole cost is one `Option` check per request.
use std::collections::BTreeMap;

use serde::Serialize;

/// Request header carrying the token (the dev proxy adds it to every upstream request).
pub const REQUEST_TOKEN_HEADER: &str = "x-brust-dev-token";
/// Response header carrying the trace.
pub const RESPONSE_HEADER: &str = "x-brust-dev";
/// A header must stay small: at most this many jobs are listed, the rest only counted.
const MAX_JOBS: usize = 40;

#[derive(Debug, Default, Serialize)]
pub struct Trace {
    pub route: Option<TraceRoute>,
    pub status: u16,
    /// `HIT`, `HIT-L2`, `MISS`, `BYPASS` or `-`.
    pub cache: String,
    pub loader_ms: Option<f64>,
    pub jobs: Vec<TraceJob>,
    /// Jobs beyond [`MAX_JOBS`] (counted, not listed).
    pub jobs_more: usize,
    pub render_ms: Option<f64>,
    pub render_error: Option<String>,
    pub bun_calls: u8,
    /// The components the page is made of: the chain, the react children its jobs target, its native children.
    pub rendered: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TraceRoute {
    pub id: String,
    pub pattern: String,
    pub chain: Vec<String>,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct TraceJob {
    pub call_id: String,
    pub kind: &'static str,
    pub component_id: String,
    pub user_key: Option<String>,
    pub tags: Vec<String>,
    /// Served from the job cache (no worker call).
    pub hit: bool,
}

impl Trace {
    /// `jobs` capped at [`MAX_JOBS`].
    pub fn set_jobs(&mut self, mut jobs: Vec<TraceJob>) {
        self.jobs_more = jobs.len().saturating_sub(MAX_JOBS);
        jobs.truncate(MAX_JOBS);
        self.jobs = jobs;
    }

    /// The `x-brust-dev` value: base64 of the JSON (ASCII-safe, whatever the params hold).
    pub fn header_value(&self) -> Option<http::HeaderValue> {
        let json = serde_json::to_vec(self).ok()?;
        http::HeaderValue::from_str(&base64(&json)).ok()
    }
}

/// Standard base64 with padding (no dependency: the core stays free of crates it can do without).
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn the_header_value_round_trips_non_ascii_params() {
        let mut t = Trace::default();
        t.route = Some(TraceRoute {
            id: "r1".into(),
            pattern: "/ข่าว/{id}".into(),
            chain: vec!["a".into()],
            params: BTreeMap::from([("id".into(), "สวัส".into())]),
        });
        let v = t.header_value().unwrap();
        assert!(v.to_str().unwrap().is_ascii());
    }

    #[test]
    fn jobs_are_capped_and_the_rest_counted() {
        let mut t = Trace::default();
        t.set_jobs(
            (0..MAX_JOBS + 5)
                .map(|i| TraceJob {
                    call_id: format!("c/{i}"),
                    kind: "precompute",
                    component_id: "c".into(),
                    user_key: None,
                    tags: vec![],
                    hit: false,
                })
                .collect(),
        );
        assert_eq!((t.jobs.len(), t.jobs_more), (MAX_JOBS, 5));
    }
}
