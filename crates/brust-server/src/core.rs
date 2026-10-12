//! `Core<H>`: the host-agnostic server state — routes, manifest, job plans, renderer, the two
//! caches on one invalidation clock, the counters and the CORS / actions / generator policy — built
//! by [`Core::new`] from a loaded manifest, minus everything that binds or spawns. A host owns one
//! `Core` and hands each request to the pipeline with it.
//!
//! Fields are the native-host seam (`doc(hidden)` once this moves into brust-core), not an API.
use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use brust_core::cache::StripedCounter;
use brust_core::cache::stamp::InvalClock;
use brust_core::config::{ActionsConfig, CorsConfig, InvalidateArgs, InvalidateResult, Stats};
use brust_core::cors::ResolvedCors;
use brust_core::host::{Host, JobStore, PageCache};
use brust_core::manifest::{Loaded, Manifest};
use brust_core::render::Renderer;
use brust_core::routing::RouteTable;
use http::{HeaderMap, HeaderName, HeaderValue};

/// What [`Core::new`] needs besides the host and the manifest. Fixed for the core's lifetime.
#[derive(Clone, Debug, Default)]
pub struct CoreConfig {
    pub l1_capacity: u64,
    pub job_cache_capacity: u64,
    pub cors: Option<CorsConfig>,
    /// `X-Powered-By` value; `None` = header not stamped.
    pub generator: Option<String>,
    /// M3-F: the actions subtree; `None` = no actions.
    pub actions: Option<ActionsConfig>,
    /// The host serves HTTPS: the scheme `cache.prefix`/`bypass` expressions see.
    pub https: bool,
}

/// The shared core state, one per server.
pub struct Core<H: Host> {
    pub(crate) host: H,
    pub(crate) routes: RouteTable,
    pub(crate) manifest: Manifest,
    /// Boot-time job-planning templates of `manifest`.
    pub(crate) plans: crate::pipeline::PlanIndex,
    pub(crate) renderer: Renderer,
    pub(crate) l1: H::L1,
    pub(crate) jobs: H::Jobs,
    /// The invalidation clock `l1` and `jobs` are built on (F89): one read stamp per page.
    pub(crate) clock: Arc<InvalClock>,
    /// M3-P P7: striped (one cache line per stripe) — bumped on every loader page.
    pub(crate) loader_calls: StripedCounter,
    pub(crate) job_calls: AtomicU64,
    /// M3-P P7: striped, like `loader_calls`.
    pub(crate) worker_calls: StripedCounter,
    pub(crate) timed_out_calls: AtomicU64,
    /// (component, slot) pairs already warned about as missing from a job result.
    pub(crate) missing_slots: Mutex<HashSet<(String, String)>>,
    pub(crate) cors: Option<CorsConfig>,
    /// `cors` resolved into prebuilt header values once at `new` (per server,
    /// not a process global: several servers may live in one process).
    pub(crate) cors_resolved: Option<ResolvedCors>,
    /// M3-F: the validated actions subtree; `None` = no actions.
    pub(crate) actions: Option<ActionsConfig>,
    /// A4: `<script>globalThis.__BRUST_ACTION_PREFIX__="…"</script>`, prebuilt at `new` for a
    /// non-default prefix only.
    pub(crate) action_prefix_tag: Option<Box<str>>,
    /// Last document length per manifest route (+ slack): the capacity of the
    /// next render's buffer (M3-P P3). A size, never bytes.
    pub(crate) render_hints: Vec<AtomicUsize>,
    /// M3-P P7 (R1): per route (manifest index), consecutive planned calls whose jobs all hit;
    /// at `pipeline::OFFER_STOP` the route stops offering the plan until a miss resets it.
    pub(crate) plan_offer: Box<[AtomicU32]>,
    /// `X-Powered-By`, stamped on every response by [`Core::finish`].
    pub(crate) powered_by: Option<HeaderValue>,
    /// The scheme the L1 key expressions see is `https`.
    pub(crate) https: bool,
}

impl<H: Host> Core<H> {
    /// Build the routes, renderer and job plans of `loaded` and validate the CORS / actions
    /// policy. Every failure is an `Err` with the prefix `start` reports: `"routes: …"`,
    /// `"render: …"`, `"manifest: …"`, `"cors: …"`, `"actions: …"`.
    pub fn new(host: H, loaded: Loaded, cfg: CoreConfig) -> Result<Self, String> {
        let routes =
            RouteTable::from_manifest(&loaded.manifest).map_err(|e| format!("routes: {e}"))?;
        let renderer =
            Renderer::from_templates(&loaded.templates).map_err(|e| format!("render: {e}"))?;
        let plans = crate::pipeline::PlanIndex::new(&loaded.manifest)
            .map_err(|e| format!("manifest: {e}"))?;
        if let Some(c) = &cfg.cors {
            c.validate().map_err(|e| format!("cors: {e}"))?;
        }
        if let Some(a) = &cfg.actions {
            a.validate(&loaded.manifest)
                .map_err(|e| format!("actions: {e}"))?;
        }
        // One invalidation clock for both caches: `page()` stamps it once per request (F89).
        let clock = Arc::new(InvalClock::default());
        Ok(Core {
            host,
            routes,
            render_hints: (0..loaded.manifest.routes.len())
                .map(|_| AtomicUsize::new(0))
                .collect(),
            plan_offer: (0..loaded.manifest.routes.len())
                .map(|_| AtomicU32::new(0))
                .collect(),
            manifest: loaded.manifest,
            plans,
            renderer,
            l1: H::L1::with_clock(cfg.l1_capacity, Arc::clone(&clock)),
            jobs: H::Jobs::with_clock(cfg.job_cache_capacity, Arc::clone(&clock)),
            clock,
            loader_calls: StripedCounter::new(),
            job_calls: AtomicU64::new(0),
            worker_calls: StripedCounter::new(),
            timed_out_calls: AtomicU64::new(0),
            missing_slots: Default::default(),
            cors_resolved: cfg.cors.as_ref().map(ResolvedCors::from_config),
            cors: cfg.cors,
            // A4 verbatim; a validated prefix holds only [A-Za-z0-9._~/-], so no escaping.
            action_prefix_tag: cfg
                .actions
                .as_ref()
                .filter(|a| !a.is_default_prefix())
                .map(|a| {
                    format!(
                        "<script>globalThis.__BRUST_ACTION_PREFIX__=\"{}\"</script>",
                        a.prefix
                    )
                    .into_boxed_str()
                }),
            actions: cfg.actions,
            powered_by: powered_by(cfg.generator.as_deref()),
            https: cfg.https,
        })
    }

    /// `key` → every job entry stored under that `cache({key})` value, in any
    /// component (entries are namespaced `k:<componentId>/<jobId>/<key>`, found
    /// through the job cache's user-key index); `tags` → both caches; `path` (+
    /// `method`, default `GET`) → L1 entries for that path, any query/prefix.
    /// L1 pages built from an invalidated job value are NOT evicted by `key`.
    /// A job value computed by a call that began before the invalidation is not
    /// cached, and its page is not stored in L1 (F89).
    pub fn invalidate(&self, args: InvalidateArgs) -> InvalidateResult {
        let mut r = InvalidateResult::default();
        if let Some(k) = &args.key {
            r.job_removed += self.jobs.invalidate_user_key(k);
        }
        if !args.tags.is_empty() {
            r.l1_removed += self.l1.invalidate_tags(&args.tags);
            r.job_removed += self.jobs.invalidate_tags(&args.tags);
        }
        if let Some(p) = &args.path {
            let m = args.method.as_deref().unwrap_or("GET");
            r.l1_removed += self.l1.invalidate_path(m, p);
        }
        r
    }

    pub fn stats(&self) -> Stats {
        Stats {
            l1: self.l1.stats(),
            job: self.jobs.stats(),
            loader_calls: self.loader_calls.get(),
            job_calls: self.job_calls.load(Ordering::Relaxed),
            worker_calls: self.worker_calls.get(),
            timed_out_calls: self.timed_out_calls.load(Ordering::Relaxed),
            missing_slots: self.missing_slots.lock().map_or(0, |m| m.len() as u64),
        }
    }

    /// The configured CORS policy, if any. `None` = disabled.
    pub fn cors(&self) -> Option<&CorsConfig> {
        self.cors.as_ref()
    }

    /// CORS is configured: the host must hand [`Core::finish`] the request's `Origin`.
    #[inline]
    pub fn cors_enabled(&self) -> bool {
        self.cors_resolved.is_some()
    }

    /// The response chokepoint every path passes (static assets, error helpers, L1 HITs,
    /// rendered pages, actions): `X-Powered-By` insert-if-absent (headers the pipeline set win;
    /// L1 holds a body, never a response, so stamping a HIT can never duplicate), then the CORS
    /// stamp for the request's `origin`. CORS is stamped HERE and ONLY here (cors.rs:9-14).
    #[inline]
    pub fn finish(&self, origin: Option<&HeaderValue>, h: &mut HeaderMap) {
        if let Some(v) = &self.powered_by {
            h.entry(HeaderName::from_static("x-powered-by"))
                .or_insert_with(|| v.clone());
        }
        if let Some(c) = &self.cors_resolved {
            c.stamp_response(h, origin);
        }
    }
}

/// X-Powered-By as a static HeaderValue (the string leaked once per server, M3-P P7), so stamping a
/// response clones no refcounted `Bytes`. An invalid value disables the header with a warning.
fn powered_by(generator: Option<&str>) -> Option<HeaderValue> {
    generator.and_then(|s| match HeaderValue::from_str(s) {
        Ok(_) => Some(HeaderValue::from_static(Box::leak(
            s.to_owned().into_boxed_str(),
        ))),
        Err(e) => {
            tracing::warn!(value = %s, error = %e, "generator string rejected by HeaderValue — X-Powered-By disabled");
            None
        }
    })
}
