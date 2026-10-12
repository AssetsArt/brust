//! `brust-app.js`'s `CONFIG` (contract v1) → `CoreConfig` + the stats gate (host-tested).

use brust_core::cache::local::{WORKERS_JOB_CAPACITY, WORKERS_L1_CAPACITY};
use brust_core::config::{ActionsConfig, CorsConfig, CrossSite};
use brust_core::core::CoreConfig;
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
        l2: None,
    };
    Ok((core, c.stats))
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
}
