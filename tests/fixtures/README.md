# Golden fixtures

`<case>/input.tsx` is compiled by `crates/brust-compiler/tests/fixtures.rs`; every emit
the compiler supports is compared byte-for-byte with `expected.<emit>.<ext>`
(`hir.json` today; later plans add `ir.json`, `jinja`, `server.ts`, `client.js`, `diag.txt`).
A case that is expected to fail has `expected.error.txt` instead.

After an intentional change: `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`,
then review the diff in git before committing.
