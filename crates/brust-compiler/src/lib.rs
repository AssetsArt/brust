//! brust v2 compiler.
//! Only `parse` and `analyze` may expose Bun AST types; everything else is plain Rust.
// The Bun stubs (parse/stubs/native.rs, copied verbatim) define their SIMD kernels with weak linkage.
#![cfg_attr(feature = "bun-stubs", feature(linkage))]
pub mod analyze;
pub mod ir;
pub mod lower;
pub mod parse;
pub mod pipeline;
pub mod summary;
