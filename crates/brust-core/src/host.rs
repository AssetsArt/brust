//! The host seam: what a host (native tokio + hyper + the Bun worker pool; Cloudflare Workers
//! later) provides to the core pipeline.

/// Which static root a request names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StaticRoot {
    /// `/_brust/<rel>` → `dist/<rel>`, restricted to `client/` chunks.
    Brust,
    /// `/public/<rel>` → `dist/public/<rel>`.
    Public,
}

/// Why a host worker call (native: `call_worker`) produced no response.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// No workers registered at all — none will ever appear, so 503 at once.
    #[error("no workers")]
    NoWorkers,
    /// Every worker stayed busy until the claim timeout — 503 last-resort.
    #[error("all workers busy")]
    Timeout,
    /// The bridge enqueue failed; the worker was removed from the pool.
    #[error("worker dead: {0}")]
    Enqueue(String),
    /// The worker's Promise rejected; the worker is still alive.
    #[error("worker rejected: {0}")]
    Rejected(String),
    /// A claimed call did not settle within the call deadline — 504. The
    /// detached remainder still holds the claim until the JS promise settles.
    #[error("call deadline exceeded")]
    Deadline,
    /// Request serialisation, an out-of-bounds length, or unparsable JSON.
    #[error("bad response: {0}")]
    BadResponse(String),
}
