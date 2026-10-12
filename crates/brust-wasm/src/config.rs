//! `brust-app.js`'s `CONFIG` (contract v1) → `CoreConfig` + the stats gate (host-tested).

use brust_core::cache::local::{WORKERS_JOB_CAPACITY, WORKERS_L1_CAPACITY};
use brust_core::config::{ActionsConfig, CorsConfig, CrossSite};
use brust_core::core::CoreConfig;
use brust_core::l2::L2Config;
use serde::Deserialize;

/// `CONFIG` v1. Unknown keys refuse to boot: a new key means `abi` 2.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CfConfig {
    abi: u32,
    #[serde(default)]
    generator: Option<String>,
    #[serde(default)]
    l1_capacity: Option<u64>,
    #[serde(default)]
    job_cache_capacity: Option<u64>,
    #[serde(default)]
    stats: bool,
    edge_cache: String,
    #[serde(default)]
    cors: Option<CfCors>,
    #[serde(default)]
    actions: Option<CfActions>,
    /// The cache adapter (optional under abi 1, cache-adapter R13).
    #[serde(default)]
    cache: Option<CfCache>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CfCache {
    adapter: String,
    get_timeout_ms: u64,
    max_body_bytes: usize,
    namespace: String,
    build_id: String,
    epoch_interval_ms: u64,
}

/// The pull-broadcast cadence (`[cache] epoch_interval_ms`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochCfg {
    pub interval_ms: u64,
}

/// Everything `CONFIG` sets.
pub struct Parsed {
    pub core: CoreConfig,
    /// `/_brust/cache/stats` is served.
    pub stats: bool,
    /// A cache adapter is configured: its poll cadence.
    pub epoch: Option<EpochCfg>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CfCors {
    origins: Vec<String>,
    #[serde(default)]
    methods: Option<Vec<String>>,
    #[serde(default)]
    headers: Option<Vec<String>>,
    #[serde(default)]
    expose_headers: Option<Vec<String>>,
    #[serde(default)]
    credentials: bool,
    #[serde(default)]
    max_age_seconds: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CfActions {
    prefix: String,
    max_body_bytes: usize,
    max_response_bytes: usize,
    cross_site: CfCrossSite,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CfCrossSite {
    Reject,
    Allow,
}

/// `CONFIG`'s JSON → the core's config (`https` is always true on Workers) and whether
/// `/_brust/cache/stats` is served. The error names the offending field.
pub fn parse(json: &str) -> Result<(CoreConfig, bool), String> {
    parse_all(json).map(|p| (p.core, p.stats))
}

/// [`parse`] plus the cache adapter's epoch cadence.
pub fn parse_all(json: &str) -> Result<Parsed, String> {
    let c: CfConfig = serde_json::from_str(json).map_err(|e| format!("CONFIG: {e}"))?;
    if c.abi != 1 {
        return Err(format!("CONFIG: abi {} unsupported (want 1)", c.abi));
    }
    if c.edge_cache != "off" {
        return Err(format!(
            "CONFIG: edgeCache {:?} unsupported (only \"off\"; the edge cache is M4-CF-7)",
            c.edge_cache
        ));
    }
    let (l2, epoch) = match c.cache {
        None => (None, None),
        Some(k) => {
            if !(1..=1000).contains(&k.get_timeout_ms) {
                return Err(format!(
                    "CONFIG: cache.getTimeoutMs {} must be in 1..=1000",
                    k.get_timeout_ms
                ));
            }
            if !(250..=60_000).contains(&k.epoch_interval_ms) {
                return Err(format!(
                    "CONFIG: cache.epochIntervalMs {} must be in 250..=60000",
                    k.epoch_interval_ms
                ));
            }
            if k.max_body_bytes == 0 {
                return Err("CONFIG: cache.maxBodyBytes must be > 0".into());
            }
            (
                Some(L2Config {
                    adapter: k.adapter,
                    get_timeout: std::time::Duration::from_millis(k.get_timeout_ms),
                    max_body_bytes: k.max_body_bytes,
                    namespace: k.namespace,
                    build_id: k.build_id,
                }),
                Some(EpochCfg {
                    interval_ms: k.epoch_interval_ms,
                }),
            )
        }
    };
    let core = CoreConfig {
        l1_capacity: c.l1_capacity.unwrap_or(WORKERS_L1_CAPACITY),
        job_cache_capacity: c.job_cache_capacity.unwrap_or(WORKERS_JOB_CAPACITY),
        cors: c.cors.map(|c| CorsConfig {
            origins: c.origins,
            methods: c.methods,
            headers: c.headers,
            expose_headers: c.expose_headers,
            credentials: c.credentials,
            max_age_seconds: c.max_age_seconds,
        }),
        generator: c.generator,
        actions: c.actions.map(|a| ActionsConfig {
            prefix: a.prefix,
            max_body_bytes: a.max_body_bytes,
            max_response_bytes: a.max_response_bytes,
            cross_site: match a.cross_site {
                CfCrossSite::Reject => CrossSite::Reject,
                CfCrossSite::Allow => CrossSite::Allow,
            },
        }),
        https: true,
        l2,
    };
    Ok(Parsed {
        core,
        stats: c.stats,
        epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{"abi":1,"generator":"brust/x","l1Capacity":256,"jobCacheCapacity":512,"stats":true,"edgeCache":"off","cors":{"origins":["https://ok.example"],"credentials":false},"actions":{"prefix":"/_brust/action","maxBodyBytes":1024,"maxResponseBytes":8388608,"crossSite":"reject"}}"#;

    #[test]
    fn a_full_config_maps_to_core_config() {
        let (c, stats) = parse(OK).unwrap();
        assert!(stats);
        assert_eq!(
            (c.l1_capacity, c.job_cache_capacity, c.https),
            (256, 512, true)
        );
        assert_eq!(c.generator.as_deref(), Some("brust/x"));
        assert_eq!(c.cors.unwrap().origins, ["https://ok.example"]);
        let a = c.actions.unwrap();
        assert_eq!(
            (a.prefix.as_str(), a.max_body_bytes),
            ("/_brust/action", 1024)
        );
        assert_eq!(a.cross_site, CrossSite::Reject);
    }

    #[test]
    fn defaults_are_the_workers_capacities() {
        let (c, stats) = parse(r#"{"abi":1,"edgeCache":"off"}"#).unwrap();
        assert!(!stats);
        assert_eq!((c.l1_capacity, c.job_cache_capacity), (256, 512));
        assert!(c.cors.is_none() && c.actions.is_none() && c.generator.is_none());
    }

    #[test]
    fn bad_configs_name_the_field() {
        let e = parse(&OK.replace("\"reject\"", "\"maybe\"")).unwrap_err();
        assert!(e.contains("maybe"), "{e}");
        let e = parse(&OK.replace("\"abi\":1", "\"abi\":2")).unwrap_err();
        assert!(e.contains("abi"), "{e}");
        let e = parse(&OK.replace("\"off\"", "\"workers-cache\"")).unwrap_err();
        assert!(e.contains("edgeCache") && e.contains("M4-CF-7"), "{e}");
        let e = parse(&OK.replace("\"stats\"", "\"statz\"")).unwrap_err();
        assert!(e.contains("statz"), "{e}");
    }

    const CACHE: &str = r#","cache":{"adapter":"custom","getTimeoutMs":100,"maxBodyBytes":1048576,"namespace":"ns","buildId":"0123456789abcdef","epochIntervalMs":250}}"#;

    fn with_cache(cache: &str) -> String {
        format!("{}{}", &OK[..OK.len() - 1], cache)
    }

    #[test]
    fn no_cache_is_no_l2() {
        let p = parse_all(OK).unwrap();
        assert!(p.core.l2.is_none() && p.epoch.is_none());
    }

    #[test]
    fn a_cache_maps_to_l2_and_epoch() {
        let p = parse_all(&with_cache(CACHE)).unwrap();
        let l2 = p.core.l2.unwrap();
        assert_eq!(
            (
                l2.adapter.as_str(),
                l2.get_timeout.as_millis(),
                l2.max_body_bytes
            ),
            ("custom", 100, 1_048_576)
        );
        assert_eq!(
            (l2.namespace.as_str(), l2.build_id.as_str()),
            ("ns", "0123456789abcdef")
        );
        assert_eq!(p.epoch, Some(EpochCfg { interval_ms: 250 }));
    }

    #[test]
    fn a_bad_cache_names_the_field() {
        let e = parse_all(&with_cache(
            &CACHE.replace("\"getTimeoutMs\":100", "\"getTimeoutMs\":0"),
        ))
        .err()
        .unwrap();
        assert!(e.contains("getTimeoutMs"), "{e}");
        let e = parse_all(&with_cache(
            &CACHE.replace("\"epochIntervalMs\":250", "\"epochIntervalMs\":10"),
        ))
        .err()
        .unwrap();
        assert!(e.contains("epochIntervalMs"), "{e}");
        let e = parse_all(&with_cache(
            &CACHE.replace("\"namespace\"", "\"nameSpace\""),
        ))
        .err()
        .unwrap();
        assert!(e.contains("nameSpace"), "{e}");
    }
}
