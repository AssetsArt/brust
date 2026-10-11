//! brust v2 server. No Bun, no napi: the worker is a `RenderDispatch` trait object.
#![deny(clippy::all)]
mod actions;
pub mod cache;
pub mod config;
pub mod dispatch;
pub mod http;
pub mod inputs;
pub mod manifest;
mod pipeline;
pub mod pool;
pub mod protocol;
pub mod render;
pub mod routing;
pub mod server;

/// Internals timed by `benches/render.rs`; not an API.
#[doc(hidden)]
pub mod bench {
    pub use crate::pipeline::plan_stage::{Planned, Planner};
    pub use crate::pipeline::{
        cached_body, next_hint, props_view, render_chain_html, render_chain_into,
    };
}

pub use config::{
    ActionsConfig, Config, CorsConfig, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES,
    InvalidateArgs, InvalidateResult, Server, Stats,
};
pub use dispatch::{CallKind, DispatchError, RenderDispatch};
pub use pipeline::{PLAN_DECLINED, plan_in_call};
pub use server::{Tuning, start};
