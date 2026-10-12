//! brust v2 host-agnostic core: everything a request needs that does not depend on where it runs.
//! `brust-server` is the native host over it (tokio + hyper + the Bun worker pool); `brust-wasm`
//! (Cloudflare Workers, later) is the second.
#![deny(clippy::all)]
pub mod cache;
pub mod inputs;
pub mod manifest;
pub mod protocol;
pub mod render;
pub mod routing;
