//! Shared integration-test helpers (`mod common;` in each test binary). Each
//! binary compiles this module on its own and uses a different subset, so
//! unused items are expected per binary.
#![allow(dead_code)]

pub mod fake_bun;

pub use fake_bun::{FakeBun, FakeBunHandle};
