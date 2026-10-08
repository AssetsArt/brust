# M1a follow-ups (risk ledger carried into M1b)

Source: Mellow's REVIEW-PASS on `m1a-foundation-core` @6c0723f (task note d8ffd4c3). None of
these block M1a; each must be either fixed or consciously accepted in the M1b plan.

| # | Where | Finding | Proposed fix | Owner plan |
|---|---|---|---|---|
| F1 | `crates/brust-compiler/src/analyze/hir.rs` (`analyze_fn` call) | Valid input that *parses* can still abort the process: the vendored React Compiler recurses without a stack guard. Probe: `return a+a+…` with 6000 terms, or a 6000-deep `<div>`; `--emit parse` exits 0, `--emit hir` dies with SIGABRT on the 8 MiB main thread (≈4× lower threshold on 2 MiB test/worker threads). | Run parse+analyze on a dedicated big-stack thread (`std::thread::Builder::stack_size`; `ensure_stack_limit` already scales) **and/or** an iterative AST depth pre-check that returns `HirError::Unsupported`. Add a regression test with the 6000-deep input either way. | M1b (host design task) |
| F2 | `crates/brust-compiler/src/parse/mod.rs:243` | `pub(crate) fn ast() -> &Ast<'static>` lets crate-internal safe code copy out `'static` borrows (e.g. `ImportRecord.path.text`) that dangle after `Parsed` drops; `AstHost` bakes the same `'static` in. | Return `&Ast<'_>` if `Ast` is covariant, or a `with_ast(|ast: &Ast<'_>| …)` accessor, **before** M1b codegen builds on it. | M1b (first task) |
| F3 | `crates/brust-compiler/src/parse/mod.rs:99-163` | Self-reference via `&'static` taken from a `Box` that is then moved into `Parsed` is UB under Miri Stacked/Tree Borrows (Box retag asserts uniqueness). No miscompile today. | Hold the buffers as `Box::into_raw` `NonNull` freed in a manual `Drop`, or `aliasable::boxed::AliasableBox`. | M1b |
| F4 | `crates/brust-compiler/src/analyze/hir.rs:176` | Each `analyze_hir` call allocates into a fresh borrowing allocator; fine per compile, worth a look when the compiler runs as a long-lived host (M2 napi). | Reuse/reset the allocator per compile in the host crate. | M2 |

Verified-good properties the reviewer confirmed (do not regress): `Parsed` is `!Send + !Sync`
(thread-local AST state cannot cross threads); `set_stack_size` stores an absolute limit so
first-call depth does not matter; `collect_scopes` is exhaustive over `ReactiveTerminal`;
vendor diff is exactly `BRUST-PATCH.md` items 1–7.
