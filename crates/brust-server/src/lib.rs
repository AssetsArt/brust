//! brust v2 server: the native host over `brust-core` (tokio + hyper, the worker pool, `dist/` on
//! disk, the moka caches). No Bun, no napi: the worker is a `RenderDispatch` trait object. Every
//! path that resolved here before the core split still does (`tests/public_api.rs`).
#![deny(clippy::all)]
mod actions;
pub mod cache;
pub mod config;
pub mod dispatch;
mod host;
pub mod http;
mod pipeline;
pub mod pool;
pub mod server;

pub use brust_core::{inputs, l2, manifest, protocol, render, routing};

/// Internals timed by `benches/render.rs`; not an API.
#[doc(hidden)]
pub mod bench {
    pub use brust_core::pipeline::plan_stage::{Planned, Planner};
    pub use brust_core::pipeline::{
        cached_body, next_hint, props_view, render_chain_html, render_chain_into,
    };
}

pub use actions::{put_fetch_reply, take_fetch_body};
pub use config::{
    ACTION_INLINE_BODY_BYTES, ActionCredentials, ActionsClient, ActionsConfig, Config, CorsConfig,
    CrossSite, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES,
    DEFAULT_MAX_ACTION_RESPONSE_BYTES, InvalidateArgs, InvalidateResult, MAX_ACTION_BYTES, Server,
    Stats,
};
pub use dispatch::{CallKind, DispatchError, RenderDispatch};
pub use pipeline::{PLAN_DECLINED, plan_in_call, plan_in_call_buf};
pub use server::{Tuning, start};
