//! Every path `brust_server::` resolved before the brust-core split still resolves (m4cf-core-split
//! T2). A path that moves must keep compiling from here; nothing runs.
#![allow(unused_imports)]

mod root {
    pub use brust_server::{
        ACTION_INLINE_BODY_BYTES, ActionsConfig, CallKind, Config, CorsConfig, CrossSite,
        DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES, DEFAULT_MAX_ACTION_RESPONSE_BYTES,
        DispatchError, InvalidateArgs, InvalidateResult, MAX_ACTION_BYTES, PLAN_DECLINED,
        RenderDispatch, Server, Stats, Tuning, plan_in_call, put_fetch_reply, start,
        take_fetch_body,
    };
}

mod bench {
    pub use brust_server::bench::{
        Planned, Planner, cached_body, next_hint, props_view, render_chain_html, render_chain_into,
    };
}

mod job_cache {
    pub use brust_server::cache::job_cache::{JobCache, JobKey};
}

mod key_expr {
    pub use brust_server::cache::key_expr::{EvalCtx, Expr, ParseError};
}

mod l1 {
    pub use brust_server::cache::l1::{
        CacheKey, CacheStats, L1Cache, ReadStamp, RenderedBody, build_cache_key,
    };
}

mod stamp {
    pub use brust_server::cache::stamp::{InvalClock, ReadStamp};
}

mod config {
    pub use brust_server::config::{CacheStats, TlsConfig};
}

mod dispatch {
    pub use brust_server::dispatch::{
        CallError, FetchCell, call_worker, call_worker_fetch, call_worker_planned, claim_or_wait,
        decode_fetch_frame,
    };
}

mod compress {
    pub use brust_server::http::compress::{accepts_gzip, gzip, is_compressible, maybe_compress};
}

mod inputs {
    pub use brust_server::inputs::{
        Path, Projection, PropsMap, Seg, canonical, child_props, job_key, project,
    };
}

mod manifest {
    pub use brust_server::manifest::{
        ALL_PROPS, Assets, BypassSpec, ChildRecord, ComponentRecord, Instances, JobCache, JobKind,
        JobRecord, Loaded, Manifest, ManifestError, RouteCache, RouteRecord, Tier,
    };
}

mod pool {
    pub use brust_server::pool::{ClaimResult, PlanBox, RenderClaim, WorkerPool};
}

mod protocol {
    pub use brust_server::protocol::{
        FetchBody, FetchMeta, FetchRequest, FetchResponse, JobCall, JobResult, JobsRequest,
        JobsResponse, LoaderRequest, LoaderResponse, Verdict,
    };
}

mod render {
    pub use brust_server::render::{
        Overlay, RenderError, Renderer, inject_assets, inject_assets_into,
        inject_document_assets_into, inject_page_assets_into, store_scripts_into, use_ids,
    };
}

mod routing {
    pub use brust_server::routing::{
        MatchResult, RequestEnvelope, RouteConfig, RouteEnvelope, RouteInstallError, RouteMatch,
        RouteTable,
    };
}

mod routes {
    pub use brust_server::routing::routes::{CompiledCache, Search, decode_search};
}

mod coarse_timer {
    pub use brust_server::server::coarse_timer::CoarseTimer;
}

mod tls {
    pub use brust_server::server::tls::{TlsConfig, TlsMinVersion, build_acceptor};
}

#[test]
fn public_api_paths_resolve() {}
