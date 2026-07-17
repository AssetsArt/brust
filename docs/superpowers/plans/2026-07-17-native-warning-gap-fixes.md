# Fix numeric Lucide names and parenthesized static JSX

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Remove three incorrect native-inline fallback warnings through two bounded fixes:

1. Resolve Lucide icon exports whose PascalCase names contain a letter-to-digit boundary, including `FileCheck2` and `Repeat2`.
2. Flatten parenthesized JSX selected by bounded static logical/conditional evaluation so it reaches normal JSX lowering rather than the complex-expression fallback.

Components that call React hooks remain intentionally outside native inlining and continue to warn plus SSR-fallback.

## TDD seams

Work vertically, red before green.

### Slice A — numeric Lucide export names

Primary observable seams:

- exported `extractLucideIcons(file)` in `runtime/cli/native-routes-emit.ts`;
- the existing native-route emit/CLI test path that consumes extracted icon data.

Add a failing test fixture importing `FileCheck2`, `Repeat2`, and `Printer` from `lucide-react`. Assert all three keys are extracted, the two numeric names render static SVG rather than entering component-source lookup, and the resulting native component has no SSR manifest entry. Use literal expected SVG/icon markers; do not reproduce the filename conversion algorithm in the assertion.

Then make the smallest normalization change that inserts the missing letter-to-digit word boundary while preserving existing acronym/alias behavior. Keep `followLucideAlias` as the owner of canonical alias resolution.

### Slice B — parenthesized static JSX child

Primary observable seam:

- `compile_full` in the Rust compiler, compiling an imported component through normal native inline dispatch.

Add a failing test with a static array containing true and false booleans and a nested map child shaped as `item.featured && (<span>x</span>)`. Assert compilation has no warnings or component manifest, emits the span exactly for the true item, and omits it for the false item. Include a conditional-expression variant if the same residual wrapper is reachable there.

Then minimally unwrap/flatten parenthesized JSX after static selection using the same child semantics already centralized by `append_expr_children`. Do not broaden general expression lowering or execute JavaScript.

## Constraints

- Keep the bounded static-evaluation budgets and all-or-nothing private-helper behavior unchanged.
- Preserve existing hook, `ref`, event-handler, ISR, explicit-native cycle, and local SSR fallback contracts.
- Preserve runtime prop-map passthrough.
- Do not include consumer project names, paths, or source in Brust fixtures, comments, plans, tests, gate labels, or commits.
- No debug logging or external filesystem reads in committed tests.

## Gates

Run on the final lane SHA:

1. `cargo fmt --all --check`
2. `cargo test -p jsx-rust-compiler`
3. `cargo clippy -p jsx-rust-compiler --all-targets -- -D warnings`
4. `cd runtime && bun run build`
5. focused runtime/CLI test containing numeric Lucide coverage
6. focused Rust compiler test containing parenthesized JSX coverage
7. `bun run ci`
8. `bun test runtime/`
9. `bun test`

## Escalation contract

Implementation details within the two seams belong to the implementer. Any need to change hook fallback semantics, import arbitrary bare-package component source, widen general expression lowering, change warning policy, or weaken static-evaluation limits is a design conflict and must be filed as a task challenge to Aoki.
