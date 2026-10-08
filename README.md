# brust v2

Write React. Get a native page: HTML rendered by Rust from a compiled template, interactivity
as a small react-free chunk, React only where the compiler proves it is needed.

- Design: `docs/design/2026-10-08-react-compiler-design.md`
- Plans: `docs/plans/`
- Build: Rust `nightly-2026-09-15` (see `rust-toolchain.toml`) + Bun 1.4.x. `cargo test --workspace --exclude bun_react_compiler`.
- CLI: `cargo run -p brust-compiler-cli -- <file.tsx> --emit parse|hir`

This branch (`v2`) is an orphan rewrite; 0.1.x lives on `main`.
