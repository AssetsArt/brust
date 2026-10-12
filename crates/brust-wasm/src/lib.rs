//! brust v2 on Cloudflare Workers: the workers-rs host over `brust-core` (M4-CF-3).
#![deny(clippy::all)]
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod bridge;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod entry;
