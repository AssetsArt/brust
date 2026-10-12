//! brust v2 on Cloudflare Workers: the workers-rs host over `brust-core` (M4-CF-3).
#![deny(clippy::all)]
pub mod capped;
pub mod config;
pub mod head;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod bridge;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod entry;
