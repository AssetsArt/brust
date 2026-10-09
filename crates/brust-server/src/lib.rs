//! brust v2 server. No Bun, no napi: the worker is a `RenderDispatch` trait object.
#![deny(clippy::all)]
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

pub use config::{Config, CorsConfig, InvalidateArgs, InvalidateResult, Server, Stats};
pub use dispatch::{CallKind, DispatchError, RenderDispatch};
pub use server::{Tuning, start};
