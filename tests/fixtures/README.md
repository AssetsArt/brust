# Golden fixtures

`<case>/input.tsx` is compiled by `crates/brust-compiler/tests/fixtures.rs` under the
repo-relative path `tests/fixtures/<case>/input.tsx`; every emit the compiler supports
is compared byte-for-byte with `expected.<emit>.<ext>`:

| emit | success | failure |
|------|---------|---------|
| `hir` | `expected.hir.json` | `expected.error.txt` |
| `ir` | `expected.ir.json` + `expected.diag.txt` (empty when there are no diagnostics) | `expected.diag.txt` only |

Later plans add `jinja`, `server.ts`, `client.js`. Only `input.tsx` is compiled; sibling
files (`parent-counter/Counter.tsx`) are there for the cases that M1b-2 resolves
across modules.

After an intentional change: `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`,
then review the diff in git before committing. An update also deletes the expectation
of the outcome that no longer happens; without `BRUSTC_UPDATE` such a stale file fails
the run.
