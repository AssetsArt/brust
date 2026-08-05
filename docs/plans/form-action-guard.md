# Plan: guard function-valued `<form action={…}>` on native routes

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro, Lead) · authority: in-loop
implementer: assigned via conclave task `form-action-guard`
escalation: design/spec conflicts → `conclave task challenge`; Detoro rules.
integration order: THIS LANE MERGES FIRST, before `declaration-shapes` (shared
files: lower.rs, lib.rs, scripts/react-coverage.ts, docs/react-coverage.md).

## Problem (docs/react-coverage.md row e-form-action-fn; reproduced by review)

A prop-valued lowercase `<form action={submit}>` inlines with WRONG semantics:
the function is stringified into the attribute (`action="{{ (submit) | e }}"`)
with zero warnings, so the form posts to garbage. It slips through because
`action` is the one React-19 function-valued attribute that is also a legal
lowercase HTML attribute name — so it misses both the `on*` handler guard
(`is_event_handler`, lower.rs:4703) and the uppercase rename check
(`UnknownAttributeRename`, lower.rs:4375-4378 via dom_attrs.rs:7). All the
neighbours already fail loudly (every `on*`, `formAction`, locally-declared fn).

## Ruled policy (do not re-litigate; challenge with evidence if wrong)

On tag `form`, attribute `action` must be FULLY STATIC. Accept:
`action="/path"`, `action={"/path"}`, and `Cond` whose present branches are all
static (`action={ok ? "/a" : "/b"}`). Reject everything else — including
`action={data.url}` — because the compiler has NO type information at that
point (Scope has no type table; annotations are parsed but never read), so a
dynamic URL is indistinguishable from a function. Strictness is the ruling: no
repo/example code uses a dynamic `action` today, and the error text must name
the fixes: use a literal `action="/path"` (brust action route), or move the
form into an `<Island>`. `formaction` (the lowercase submit-button attribute)
is OUT of scope — only `<form action>`.

## Implementation (Explore-verified pointers, main @ 9333940)

1. New `ErrorKind` variant next to `EventHandlerNotSupported`
   (crates/jsx-rust-compiler/src/lib.rs:580-581), e.g.
   `FormActionNotSupported` with text naming the two fixes above.
   Do NOT add it to the hard-error allowlist at lower.rs:3362-3369 — that way
   it is automatically a hard build error in a route file and a
   warn+SSR-fallback inside an inlined component (no new machinery).
2. Guard site: `lower_element`'s attr loop, lower.rs:1507-1520 — `tag` is
   already bound at :1485. Either pass `&tag` into `lower_attr` (single call
   site, lower.rs:1518) or post-check the returned `JsxAttr` in the loop.
   Static-ness is read off the lowered `AttrValue` (ir.rs:246-265):
   allow `Static`/`StaticNum` and `Expr(StaticText|StaticNum)`, and `Cond`
   whose branches are those; reject other `Expr`.
   NOTE: there are 5 attr-lowering loops (lower.rs:4362, :1059, :2587, :2703,
   :2808) but `<form>` is a HOST element — the host path is the required one.
   Add a test proving a component PROP named `action` on a component tag is
   NOT affected (only the host `<form>` tag).
3. Battery update in scripts/react-coverage.ts row `e-form-action-fn`
   (:792-803): after the guard it must become `expected:
   'fallback-by-design'`, drop the `semanticGap` marker, add `expectedRoute:
   'broken'` (route position = hard build error). Regenerate
   docs/react-coverage.md via `bun scripts/react-coverage.ts` (rebuild the
   addon first: `cd runtime && bun run build:debug` — the script exits 1 if
   stale, trust it).

## Tests

Model on (all lower.rs inline mod tests): `rejects_onclick_handler` :7431
(host reject template), `implicit_unresolved_source_warns_and_falls_back`
:9674 (warn+fallback template), `lower_with_src` helper :9557.
Required cases:
- `<form action="/x">` still emits `action="/x"` (positive; consider a golden
  case in crates/jsx-rust-compiler/tests/golden_emit_jinja.rs).
- `<form action={fn}>` in a route file → hard error, new ErrorKind.
- Same inside an inlined component (via lower_with_src) → warning contains the
  new reason + component falls back (ssr_component_names populated).
- `action={ok ? "/a" : "/b"}` still inlines.
- `action` as a PROP on a capitalized component tag unaffected.
- `<a action=…>`-style non-form tags unaffected (attribute passthrough intact).

## Gates (mirror ci.yml exactly)

1. `cargo fmt --all --check`
2. `cargo test -p jsx-rust-compiler`
3. `cd runtime && bun run build:debug` then `bun scripts/react-coverage.ts`
   twice + `git diff --exit-code docs/react-coverage.md` after the second run
   (regenerated report committed on the first).
4. `bun test tests/react-coverage.test.ts` and `bun test
   tests/native-inline.test.ts` (separately).
5. `bun run ci`.

## Risk ledger

- The report regeneration WILL conflict with the declaration-shapes lane —
  resolution at integration is REGENERATION on the merged tree, never a hand
  merge; do not try to pre-resolve.
- Keep the guard tag-scoped: a blanket `action` rejection would break
  arbitrary custom elements/attributes that legitimately take strings.
