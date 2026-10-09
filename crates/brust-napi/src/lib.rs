//! napi-rs binding of `brust-server` and `brust-compiler` for Bun.
#![deny(clippy::all)]

mod compile;
mod dispatch;
mod server;

pub use compile::*;
pub use server::*;

use std::sync::Once;
use tracing_subscriber::EnvFilter;

/// Installs the stderr tracing subscriber once (env filter, default `brust=info`).
pub(crate) fn init_tracing() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("brust=info")),
            )
            .with_target(false)
            .with_writer(std::io::stderr)
            .try_init();
    });
}
