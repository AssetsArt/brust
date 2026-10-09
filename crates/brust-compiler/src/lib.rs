//! brust v2 compiler. See docs/design/2026-10-08-react-compiler-design.md.
//! Only `parse` and `analyze` may expose Bun AST types; everything else is plain Rust.
pub mod analyze;
pub mod ir;
pub mod lower;
pub mod parse;
pub mod pipeline;
pub mod summary;
