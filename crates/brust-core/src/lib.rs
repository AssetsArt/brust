//! `brust-core` — the pure-Rust core of the brust HTTP server.
//!
//! This crate carries ZERO napi. It owns the hand-rolled HTTP server, routing,
//! caching, render orchestration (behind the [`render::RenderDispatch`] trait),
//! realtime transports (SSE/WS), and the minijinja templating layer. The
//! `brust` crate is a thin napi binding that constructs an [`AppState`],
//! supplies a concrete `RenderDispatch` impl, and calls into [`server::start`].

#![deny(clippy::all)]

pub mod cache;
pub mod config;
pub mod http;
pub mod realtime;
pub mod render;
pub mod routing;
pub mod server;
pub mod template;

// ----- public core API surface used by the napi binding -----

pub use config::{AppState, CorsConfig};
pub use render::dispatch::{RenderDispatch, RenderError};
pub use render::pool::{RenderChunk, WorkerPool};
pub use render::stream::check_chunk_dispatch;
pub use server::Tuning;
pub use server::start;
