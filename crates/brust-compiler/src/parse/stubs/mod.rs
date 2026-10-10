//! Native symbols Bun's C/C++ side normally provides. Compiled in by default
//! (feature `bun-stubs`); a host that links the real Bun turns the feature off.
#![allow(
    unsafe_op_in_unsafe_fn,
    dead_code,
    non_snake_case,
    clippy::missing_safety_doc
)]
pub(super) mod extra;
pub(super) mod native;
#[cfg(bun_sema_mimalloc)]
pub(super) mod real_mimalloc;
