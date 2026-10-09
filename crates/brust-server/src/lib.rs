//! brust v2 server. No Bun, no napi: the worker is a `RenderDispatch` trait object.
#![deny(clippy::all)]
pub mod cache;
pub mod config;
pub mod dispatch;
pub mod http;
pub mod inputs;
pub mod manifest;
pub mod pool;
pub mod protocol;
pub mod routing;
pub mod server;
