# Bumping the pinned Bun rev

Do all steps in one PR. The rev appears in: `Cargo.toml` (8 lines), `bun-codegen/build_options.rs` (`SHA`),
`vendor/bun_react_compiler/BRUST-PATCH.md` (header), `crates/brust-compiler/src/parse/stubs/native.rs` (header).

1. Pick the rev (a commit on `main` that still has `src/sema/standalone/native.rs`). Export `REV=<40 hex>`.
2. Sparse checkout: `git clone --depth 1 --filter=blob:none --sparse https://github.com/oven-sh/bun /tmp/bun-src && git -C /tmp/bun-src fetch --depth 1 origin $REV && git -C /tmp/bun-src checkout $REV && git -C /tmp/bun-src sparse-checkout set src/sema/standalone src/react_compiler scripts/build`
3. `sed -i '' "s/rev = \"[0-9a-f]\{40\}\"/rev = \"$REV\"/" Cargo.toml`; copy `/tmp/bun-src/rust-toolchain.toml` over ours (keep our `components`).
4. `bun scripts/bun-codegen.ts /tmp/bun-src`; set `SHA` in `bun-codegen/build_options.rs` to `$REV`.
5. `cp /tmp/bun-src/src/sema/standalone/native.rs crates/brust-compiler/src/parse/stubs/native.rs` and restore the header line.
6. `rm -rf vendor/bun_react_compiler && cp -R /tmp/bun-src/src/react_compiler vendor/bun_react_compiler`, then re-apply every change listed in `vendor/bun_react_compiler/BRUST-PATCH.md` (the `sed` lines of plan M1a Task 3 Step 3 and the `analyze_fn` block). Update the header.
7. `cargo build --workspace`. For every undefined symbol at link time, add a stub in `crates/brust-compiler/src/parse/stubs/extra.rs` with the signature from Bun's `extern` block (`grep -rn "fn <name>" /tmp/bun-src/src`).
8. `cargo test --workspace --exclude bun_react_compiler`; if only golden files changed for a reason you understand, `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures` and review the diff.
9. Commit as `build: bump Bun to <rev>`; CI must be green before merge.
