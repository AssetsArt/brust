//! `brust-app.js`'s `CONFIG` (contract v1) → `CoreConfig` + the stats gate (host-tested).

use brust_core::cache::local::{WORKERS_JOB_CAPACITY, WORKERS_L1_CAPACITY};
use brust_core::config::{ActionsConfig, CorsConfig, CrossSite, StreamConfig, StreamRoute};
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
    /// F539 `[csp]` (optional under abi 1, like `cache`); absent = no Content-Security-Policy header.
    #[serde(default)]
    csp: Option<CfCsp>,
}

fn on() -> bool {
    true
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CfCsp {
    /// F544: the table is shipped off too (the entry's BRUST_CSP_MODE may turn it on); absent = on (older entries).
    #[serde(default = "on")]
    enabled: bool,
    #[serde(default)]
    report_only: bool,
    #[serde(default)]
    script_src: Vec<String>,
    #[serde(default)]
    script_src_unsafe: bool,
    #[serde(default)]
    style_src: Vec<String>,
    #[serde(default)]
    connect_src: Vec<String>,
    #[serde(default)]
    img_src: Vec<String>,
    #[serde(default)]
    font_src: Vec<String>,
    #[serde(default)]
    frame_ancestors: Vec<String>,
    #[serde(default)]
    report_uri: Option<String>,
    /// F544: `"self"` (default) or `"none"`.
    #[serde(default)]
    default_src: Option<String>,
    #[serde(default)]
    base_uri: Option<String>,
    #[serde(default)]
    form_action: Vec<String>,
    #[serde(default)]
    frame_src: Vec<String>,
    #[serde(default)]
    media_src: Vec<String>,
    #[serde(default)]
    worker_src: Vec<String>,
    #[serde(default)]
    manifest_src: Vec<String>,
    #[serde(default)]
    object_src: Vec<String>,
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
    /// F475: the `[actions] stream` list and its ceiling. Workers ignore the idle/total timeouts and
    /// `max_streams` (the platform bounds the request), so the build does not send them.
    #[serde(default)]
    stream: Vec<String>,
    #[serde(default)]
    max_stream_bytes: Option<u64>,
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
    parse_with_csp_mode(json, None)
}

/// [`parse_all`] with F544's `BRUST_CSP_MODE` (the Worker's binding) over `CONFIG.csp`: `off` = no policy;
/// `report-only` / `enforce` = the table (shipped even when not enabled) or the default policy, in that mode; unset or
/// empty = as built. Any other value refuses to boot.
pub fn parse_with_csp_mode(json: &str, mode: Option<&str>) -> Result<Parsed, String> {
    let mut c: CfConfig = serde_json::from_str(json).map_err(|e| format!("CONFIG: {e}"))?;
    c.csp = match mode {
        None | Some("") => c.csp.filter(|c| c.enabled),
        Some("off") => None,
        Some(m @ ("report-only" | "enforce")) => {
            let mut t = c.csp.unwrap_or_default();
            t.report_only = m == "report-only";
            Some(t)
        }
        Some(o) => {
            return Err(format!(
                "BRUST_CSP_MODE must be one of off, report-only, enforce (got {o:?})"
            ));
        }
    };
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
    let actions = c
        .actions
        .map(|a| -> Result<ActionsConfig, String> {
            let mut stream = StreamConfig::default();
            for e in &a.stream {
                stream
                    .routes
                    .push(StreamRoute::parse(e).map_err(|e| format!("CONFIG: actions.{e}"))?);
            }
            if let Some(n) = a.max_stream_bytes {
                stream.max_bytes = n;
            }
            Ok(ActionsConfig {
                prefix: a.prefix,
                max_body_bytes: a.max_body_bytes,
                max_response_bytes: a.max_response_bytes,
                cross_site: match a.cross_site {
                    CfCrossSite::Reject => CrossSite::Reject,
                    CfCrossSite::Allow => CrossSite::Allow,
                },
                stream,
                ws: Default::default(),
            })
        })
        .transpose()?;
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
        csp: c
            .csp
            .map(|c| -> Result<_, String> {
                use brust_core::csp::SelfOrNone;
                Ok(brust_core::csp::CspConfig {
                    mode: if c.report_only {
                        brust_core::csp::CspMode::ReportOnly
                    } else {
                        brust_core::csp::CspMode::Enforce
                    },
                    script_src: c.script_src,
                    script_src_unsafe: c.script_src_unsafe,
                    style_src: c.style_src,
                    connect_src: c.connect_src,
                    img_src: c.img_src,
                    font_src: c.font_src,
                    frame_ancestors: c.frame_ancestors,
                    report_uri: c.report_uri,
                    default_src: SelfOrNone::parse(c.default_src.as_deref(), "csp.defaultSrc")?,
                    base_uri: SelfOrNone::parse(c.base_uri.as_deref(), "csp.baseUri")?,
                    form_action: c.form_action,
                    frame_src: c.frame_src,
                    media_src: c.media_src,
                    worker_src: c.worker_src,
                    manifest_src: c.manifest_src,
                    object_src: c.object_src,
                    drop_host: false,
                })
            })
            .transpose()?,
        generator: c.generator,
        actions,
        actions_client: None,
        https: true,
        l2,
        dev_token: None,
        // F519: no runtime components on Workers (a build with a slot is refused for this target).
        components_cache_entries: None,
        // The Workers gate is `CONFIG.stats` (a bool, off by default): on is public, as it always was.
        stats: if c.stats {
            brust_core::config::StatsAccess::Public
        } else {
            brust_core::config::StatsAccess::Off
        },
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
        // F507: the core's own gate follows `CONFIG.stats`, so what the Workers gate lets through the core serves
        assert_eq!(c.stats, brust_core::config::StatsAccess::Public);
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
    fn a_stream_list_and_its_ceiling_map_to_the_core_config() {
        let json = OK.replace(
            "\"crossSite\":\"reject\"",
            "\"crossSite\":\"reject\",\"stream\":[\"POST /upload\",\"put /files/*\"],\"maxStreamBytes\":1048576",
        );
        let a = parse(&json).unwrap().0.actions.unwrap();
        assert_eq!(a.stream.max_bytes, 1_048_576);
        let routes: Vec<_> = a
            .stream
            .routes
            .iter()
            .map(|r| (r.method.as_str(), r.path.as_str()))
            .collect();
        assert_eq!(routes, [("POST", "/upload"), ("PUT", "/files/*")]);
        assert!(a.streams("PUT", "/_brust/action/files/a/b"));
        // no list: nothing streams, and the ceiling is the default
        let a = parse(OK).unwrap().0.actions.unwrap();
        assert!(a.stream.routes.is_empty());
        assert_eq!(
            a.stream.max_bytes,
            brust_core::config::DEFAULT_MAX_STREAM_BYTES
        );
    }

    #[test]
    fn a_bad_stream_entry_names_itself() {
        let json = OK.replace(
            "\"crossSite\":\"reject\"",
            "\"crossSite\":\"reject\",\"stream\":[\"GET /x\"]",
        );
        let e = parse(&json).unwrap_err();
        assert!(
            e.contains("GET /x") && e.contains("POST, PUT or PATCH"),
            "{e}"
        );
    }

    #[test]
    fn defaults_are_the_workers_capacities() {
        let (c, stats) = parse(r#"{"abi":1,"edgeCache":"off"}"#).unwrap();
        assert!(!stats);
        assert_eq!(c.stats, brust_core::config::StatsAccess::Off);
        assert_eq!((c.l1_capacity, c.job_cache_capacity), (256, 512));
        assert!(c.cors.is_none() && c.actions.is_none() && c.generator.is_none());
        assert!(c.csp.is_none());
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

    #[test]
    fn a_csp_maps_to_the_core_config() {
        let (c, _) = parse(&with_cache(
            r#","csp":{"reportOnly":true,"styleSrc":["'unsafe-inline'"],"frameAncestors":["'none'"]}}"#,
        ))
        .unwrap();
        let p = c.csp.unwrap();
        assert_eq!(p.mode, brust_core::csp::CspMode::ReportOnly);
        assert_eq!(p.style_src, ["'unsafe-inline'"]);
        assert_eq!(p.frame_ancestors, ["'none'"]);
        assert!(p.script_src.is_empty() && !p.script_src_unsafe);
        let e = parse(&with_cache(r#","csp":{"scriptSrcs":[]}}"#)).unwrap_err();
        assert!(e.contains("scriptSrcs"), "{e}");
        // F544: a table shipped off is no policy; the new keys map
        let (c, _) = parse(&with_cache(
            r#","csp":{"enabled":false,"formAction":["https://pay.example"]}}"#,
        ))
        .unwrap();
        assert!(c.csp.is_none());
        let (c, _) = parse(&with_cache(
            r#","csp":{"enabled":true,"defaultSrc":"none","baseUri":"none","formAction":["https://pay.example"],"frameSrc":["https://v.example"],"objectSrc":["https://o.example"]}}"#,
        ))
        .unwrap();
        let p = c.csp.unwrap();
        assert_eq!(p.default_src, brust_core::csp::SelfOrNone::None);
        assert_eq!(p.base_uri, brust_core::csp::SelfOrNone::None);
        assert_eq!(p.form_action, ["https://pay.example"]);
        assert_eq!(
            (p.frame_src.len(), p.object_src.len(), p.drop_host),
            (1, 1, false)
        );
        let e = parse(&with_cache(r#","csp":{"defaultSrc":"some"}}"#)).unwrap_err();
        assert!(e.contains("csp.defaultSrc"), "{e}");
    }

    #[test]
    fn brust_csp_mode_switches_the_built_policy() {
        use brust_core::csp::CspMode;
        let off_table =
            with_cache(r#","csp":{"enabled":false,"formAction":["https://pay.example"]}}"#);
        let on_table = with_cache(r#","csp":{"enabled":true,"reportOnly":true}}"#);
        let mode = |json: &str, m: Option<&str>| parse_with_csp_mode(json, m).map(|p| p.core.csp);
        // unset / empty: as built
        assert!(mode(&off_table, None).unwrap().is_none());
        assert_eq!(
            mode(&on_table, Some("")).unwrap().unwrap().mode,
            CspMode::ReportOnly
        );
        // off: none, even when built on
        assert!(mode(&on_table, Some("off")).unwrap().is_none());
        // on: the shipped table (even when off), in that mode
        let p = mode(&off_table, Some("enforce")).unwrap().unwrap();
        assert_eq!((p.mode, p.form_action.len()), (CspMode::Enforce, 1));
        assert_eq!(
            mode(&on_table, Some("enforce")).unwrap().unwrap().mode,
            CspMode::Enforce
        );
        // no table at all: the default policy
        assert_eq!(
            mode(OK, Some("report-only")).unwrap().unwrap(),
            brust_core::csp::CspConfig {
                mode: CspMode::ReportOnly,
                ..Default::default()
            }
        );
        // anything else refuses to boot
        let e = mode(OK, Some("strict")).unwrap_err();
        assert!(
            e.contains("BRUST_CSP_MODE") && e.contains("\"strict\""),
            "{e}"
        );
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
