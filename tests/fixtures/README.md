# Golden fixtures

`<case>/input.tsx` is compiled by `crates/brust-compiler/tests/fixtures.rs` under the
repo-relative path `tests/fixtures/<case>/input.tsx`; every emit the compiler supports
is compared byte-for-byte with `expected.<emit>.<ext>`:

| emit | success | failure |
|------|---------|---------|
| `hir` | `expected.hir.json` | `expected.error.txt` |
| `ir` | `expected.ir.json` + `expected.diag.txt` (empty when there are no diagnostics) | `expected.diag.txt` only |

`ir` is the full analysis (structural read plus the M1b-2 passes: placement, jobs,
captures, children, `cache()`, tier). Child components are compiled from sibling files,
resolved from the repo root: `parent-counter/Counter.tsx` (a linked native child),
`react-child/Reviews.tsx` (a React island with an `ssr` job), `import-cycle/A.tsx`
(imports the case back), `jsx-shapes/Badge.tsx`. Only `input.tsx` gets expectation
files; a child's IR is checked through its parent (`children`, `child_links`, `jobs`).
The lowered artifacts (M1c) are compared the same way: `expected.jinja`,
`expected.server.ts` (only when the component has a precompute job) and
`expected.client.js` (only when it is not static); each child component it compiled
gets `expected.<Stem>.<ext>` (`parent-counter/expected.Counter.client.js`). A case whose
IR carries an Error is never lowered, so it has none of them.

`sample-props*.json` feed the dual-evaluation harness (`crates/brust-compiler/tests/dual_eval.rs`):
the job runs under bun, the template renders with minijinja from the sample props plus the
job's slots, and every directive's initial client value must equal what was painted. Module
stubs the fixtures import (`product-card/money.ts`) are copied next to the generated files.

After an intentional change: `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`,
then review the diff in git before committing. An update also deletes the expectation
of the outcome that no longer happens; without `BRUSTC_UPDATE` such a stale file fails
the run.
