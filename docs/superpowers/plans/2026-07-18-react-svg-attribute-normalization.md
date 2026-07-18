# React-compatible SVG attribute normalization

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Native-inline components containing standard SVG JSX attributes must lower without a `not inlined: unknown attribute rename` fallback. The fix must cover the React SVG attribute surface as a class, not add a `viewBox` exception, while preserving rejection of genuinely unknown camelCase attributes.

## Confirmed failure and oracle

- `viewBox`, `strokeWidth`, and `preserveAspectRatio` each deterministically fail in `lower_attr` with `UnknownAttributeRename`.
- Pinned `react-dom@19.2.6` is the serialization oracle:
  - preserve-case examples: `viewBox`, `preserveAspectRatio`, `gradientUnits`;
  - alias examples: `strokeWidth -> stroke-width`, `colorInterpolationFilters -> color-interpolation-filters`;
  - namespaced examples: `xlinkHref -> xlink:href`, `xmlSpace -> xml:space`, `xmlnsXlink -> xmlns:xlink`.
- Diagnosis ledger: Conclave task `svg-jsx-attribute-normalization-diagnosis`.

## Decisions

1. Add `crates/jsx-rust-compiler/src/dom_attrs.rs` as the single data-owning module for JSX-to-serialized attribute names.
2. Store a sorted, duplicate-free static table of `(canonical JSX prop, serialized attribute)` pairs. It must contain:
   - the ten existing HTML aliases currently in `rename_attr`;
   - every canonical camelCase SVG prop in ReactDOM 19.2.6's `possibleStandardNames` SVG section;
   - every SVG alias in ReactDOM's attribute-alias map;
   - the `xlink*`, `xml*`, and `xmlnsXlink` namespaced cases handled specially by ReactDOM.
   Lowercase names, `data-*`, and `aria-*` remain passthrough and do not need table entries.
3. Expose a narrow interface such as `serialized_standard_attr(name: &str) -> Option<&'static str>`. Use binary search over the sorted table (or an equivalently single-source generated match); do not duplicate the mapping between production and tests.
4. `lower_attr` keeps its existing precedence exactly: `key` drop, `ref` reject, `on[A-Z]` reject, known standard mapping, unknown-uppercase reject, lowercase passthrough.
5. Do not add element/namespace state to `lower_element`/`lower_child`. React's canonical prop-to-serialized-name mapping is global, and no supported mapping changes by host tag. A canonical whitelist also preserves typo detection. This rejects the more complex namespace-threading alternative.
6. Do not blindly camelCase-to-kebab-case and do not allow arbitrary uppercase names: SVG has preserve-case and colon-qualified exceptions.
7. Amend `docs/superpowers/specs/2026-05-28-jsx-rust-compiler-phase-a1-design.md` section 4.5 so the durable spec no longer claims the original ten-entry table is complete.

## File boundary

- `crates/jsx-rust-compiler/src/dom_attrs.rs` (new mapping module and its table integrity tests)
- `crates/jsx-rust-compiler/src/lib.rs` (module declaration only)
- `crates/jsx-rust-compiler/src/lower.rs` (consume the module; focused lowering and native-inline regressions)
- `docs/superpowers/specs/2026-05-28-jsx-rust-compiler-phase-a1-design.md` (attribute contract)

## Required regressions

1. Direct SVG lowering succeeds and records exact serialized names for all classes in one fixture:
   - preserve: `viewBox`, `preserveAspectRatio`, `gradientUnits`;
   - hyphenate: `strokeWidth`, `strokeLinecap`, `strokeLinejoin`, `fillRule`, `clipPath`, `colorInterpolationFilters`;
   - namespace: `xlinkHref`, `xmlSpace`, `xmlnsXlink`.
2. Include less-common canonical preserve-case props (`attributeName`, `baseFrequency`, `filterUnits`, `stdDeviation`) so the fix cannot be a common-icons-only list.
3. Imported native component containing SVG auto-inlines with no warning and no `SsrComponent` fallback; inspect the lowered tree for the exact SVG attribute names.
4. `fooBar` still produces `UnknownAttributeRename`.
5. Existing `onClick`, `ref`, `key`, `className`, and `htmlFor` precedence tests remain green.
6. Mapping-module integrity test asserts the table is strictly sorted and contains no duplicate canonical names.

## Verification

Run in this order and record each as a task gate:

```bash
cargo fmt --all --check
cargo test -p jsx-rust-compiler --lib --locked
cargo clippy -p jsx-rust-compiler --all-targets --locked -- -D warnings
cargo build -p jsx-rust-compiler --locked
cd runtime && bun run build:debug && cd ..
bun test tests/native-inline.test.ts
bun run ci
```

Expected: every command exits 0; the focused regressions prove exact serialized names, no native-inline warning/fallback, and retained unknown-camelCase rejection.

## Risk ledger

- A partial SVG list recreates the bug under another prop. Guard with the complete ReactDOM 19.2.6 canonical SVG surface and rare-case tests.
- Incorrect preserve/alias classification silently changes rendered SVG. Compare mapping entries to the pinned ReactDOM serializer, especially namespaced cases.
- Widening all camelCase would hide typos. The fallback uppercase rejection is load-bearing and must remain.
- `dangerouslySetInnerHTML` is consumed before generic normalization and must not be added as a serializable table entry.
