//! brust v2 host-agnostic core: everything a request needs that does not depend on where it runs.
//! `brust-server` is the native host over it (tokio + hyper + the Bun worker pool); `brust-wasm`
//! (Cloudflare Workers, later) is the second.
#![deny(clippy::all)]
#[doc(hidden)]
pub mod actions;
#[doc(hidden)]
pub mod body;
pub mod cache;
pub mod compress;
pub mod config;
#[doc(hidden)]
pub mod core;
mod cors;
pub mod host;
pub mod inputs;
pub mod manifest;
pub mod pipeline;
#[doc(hidden)]
pub mod plan;
pub mod protocol;
pub mod render;
pub mod routing;
#[doc(hidden)]
pub mod static_rules;
