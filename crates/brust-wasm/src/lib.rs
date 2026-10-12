//! brust v2 on Cloudflare Workers: the workers-rs host over `brust-core` (M4-CF-3). The pure
//! modules (`head`, `config`, `capped`) build and test on the host; the JS-touching ones only for
//! wasm32-unknown-unknown. `scripts/build.ts` packages the Worker (`npm/core-cf/worker/`).
#![deny(clippy::all)]
pub mod capped;
pub mod config;
pub mod epoch;
pub mod head;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod bridge;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod entry;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod host;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod log;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod respond;
