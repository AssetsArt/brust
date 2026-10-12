//! brust v2 host-agnostic core: everything a request needs that does not depend on where it runs.
//! `brust-server` is the native host over it (tokio + hyper + the Bun worker pool); `brust-wasm`
//! (Cloudflare Workers, later) is the second. Spec: `docs/design/2026-10-12-m4-cloudflare-workers-design.md` §3-§4.
//!
//! - **Static dispatch.** The pipeline is generic over `H: host::Host` and monomorphised per host:
//!   no `dyn`, no boxed futures. Build one `core::Core<H>` per server and call `Core::handle` per
//!   request, then `Core::finish` on the response.
//! - **`Send`.** `Host` methods return `impl Future` without a `Send` bound (Workers futures are
//!   `!Send`). A native host keeps its futures `Send` (auto traits leak through a concrete impl);
//!   `brust-server` asserts it at compile time on the spawned per-request future.
//! - **The native seam.** Items only a host needs (`core::Core` fields, `plan`, `body`,
//!   `static_rules`, the pipeline's planning internals, the stamp internals) are `#[doc(hidden)]
//!   pub`: the native-host seam, not an API. Everything else a host does not read is crate-private.
//! - **Features.** `gzip` (default) compresses pages and lets the host compress assets; without it
//!   `compress::gzip` is `None` and every body is identity.
//! - **wasm32-unknown-unknown.** No `Manifest::load` there (lane 3: `from_parts`); `env()` in a
//!   cache expression is a parse error; time comes from `host::Clock` (no `Instant` anywhere in
//!   core: `Instant::now` panics on wasm32-unknown-unknown).
//! - **Dependencies.** No tokio, hyper, moka or crossbeam (CI checks `cargo tree`).
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
pub mod l2;
pub mod manifest;
pub mod pipeline;
#[doc(hidden)]
pub mod plan;
pub mod protocol;
pub mod render;
pub mod routing;
#[doc(hidden)]
pub mod static_rules;
