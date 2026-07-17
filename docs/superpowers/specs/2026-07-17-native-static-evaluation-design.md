# Native static evaluation for ordinary component markup

**Date:** 2026-07-17  
**Status:** accepted  
**Driver:** Ordinary static components should compile to zero-React native markup

## Problem

An imported component inlines only when every JSX expression is already a
runtime loader path or an expression supported by the inline lowerer. Ordinary
presentational React components frequently keep display data in module-level
literal `const` arrays and render it with `.map()`. The reported representative
components soft-fall back with the misleading diagnostic `unsupported prop`
even though their call sites require no dynamic props.

The first shared failure is not a prop. A module identifier such as
`ITEMS` reaches `lower_expr`, which only knows component props and active map
bindings, and becomes `UnresolvedIdent`. After that is removed, the examples
also exercise direct literal-array maps, tuple/object destructuring, a callback
index, a callback-local `const`, nested maps, optional object fields, static
decimal numbers, symbolic icon identifiers, and pure helper components declared
in the same file.

Inlining only the exported function is not sufficient. A controlled probe that
removed the static maps let the outer component inline, but still emitted React
SSR factories for two private same-file helpers. The feature is complete only
when the inlined subtree contains no React slots for these pure helpers.

## Decision

Add a bounded compile-time static-expansion module before native inline lowering.
Its interface is deliberately small:

```rust
expand_inline_body(module, root_name, function) -> Result<Cow<BlockStmt>, StaticEvalError>
```

The module owns module/local constant resolution, static `.map()` expansion,
lexically safe AST substitution, expression folding, pure same-file helper
inlining, cycle detection, and expansion budgets. `lower_component_inline`
remains the adapter from the expanded AST to the existing IR/Jinja lowerer.
Callers do not learn the evaluator's internal value model.

This seam gives one place to maintain JavaScript-like static semantics and keeps
the existing runtime-data `.map()` implementation unchanged.

## Supported static subset

- Module-level and local `const` graphs made from strings, booleans, null or
  undefined, finite numbers, arrays without holes/spreads, and plain objects
  without spreads, computed keys, accessors, or methods.
- Imported identifiers may be carried as symbolic values and substituted into a
  JSX element name (the existing lucide registry still owns SVG generation).
- Static property access by identifier/string/integer, missing optional object
  fields as undefined, and array/string `.length`.
- Unary `!`, unary `-`, arithmetic needed by index expressions, string/number
  `+`, comparisons, equality, `&&`, `||`, `??`, and conditional expressions.
- `.map()` over a statically resolved array. Callback parameters may be a plain
  identifier, array/object destructuring, and an optional second plain index
  identifier. Bodies may be an expression or a block containing leading simple
  `const` declarations followed by one return. Nested static maps are expanded
  recursively.
- Pure, unexported top-level same-file function declarations used as JSX helpers.
  Destructured props, defaults, bare boolean attrs, explicit attrs, and children
  are substituted before recursively expanding the helper. A helper must satisfy
  the existing inlinability analyzer and supported return shapes; otherwise the
  entire imported native component soft-falls back to React. Function-valued
  consts are deliberately outside this first exception.
- Static decimal numbers remain numeric through attribute/lucide lowering;
  native attribute compilation must not reject `2.5` or `2.25`.

Lexical substitution must not rewrite property names, JSX attribute names, or a
binding shadowed by a nested function/callback.

## Dynamic and failure semantics

A `.map()` whose source is a runtime component prop is not a static-evaluation
candidate and flows unchanged to the existing Jinja-loop lowerer. Existing
runtime behavior and output stay byte-compatible.

Imported components in a native route are attempted automatically, including at
the route root and recursively inside an inlined component. A failed automatic
attempt emits the same component-and-reason compile warning style as an explicit
`native` attempt and falls back locally to the existing SSR slot. Imported SSR
identities are resolvable from the merged transitive import map, so this local
fallback is safe and preserves hybrid native/React composition.

An unexported top-level function declaration in the currently expanded source
module has no importable SSR identity and is therefore different: it is treated
as a private implementation detail of the containing imported component. If it
cannot be expanded, the containing component falls back; the compiler must never
emit a same-file helper SSR slot. This remains an all-or-nothing private-helper
rule.

The explicit `<Comp native />` spelling remains supported. It preserves the
historical hard-cycle behavior and may explicitly ignore `isr` after warning on
a successful inline. An implicit component carrying `isr` warns, skips inline,
and preserves SSR cache semantics. An all-implicit import cycle warns and locally
falls back instead of failing the build. Route source bodies themselves do not
gain root-wide static evaluation; only imported-component inline lowering uses
this static-expansion module.

If a source resolves to a declared static `const` but uses an unsupported static
construct, expansion fails closed and the outer imported native component uses
the existing all-or-nothing soft fallback. The compiler never partially expands
a component and never executes arbitrary JavaScript.

Limits are fixed compiler invariants: at most 1,024 expanded map items/helper
calls across one native component, recursion depth 32, and 256 static bindings.
Limit or cycle failures use a precise `static evaluation: …` reason.

All stage-6 inline lowering failures print their real `ErrorKind` instead of the
catch-all `unsupported prop`. Stage-2 call-site spread/substitution failures keep
the existing `unsupported prop` wording because it is accurate there.

## Rejected alternatives

- **Teach the Jinja IR module-level JavaScript values.** This adds static arrays,
  object destructuring, callback indexes, dynamic JSX tags, and optional-field
  semantics to the runtime template interface. Compile-time expansion has a
  smaller interface and no request-time cost.
- **Extend each lowerer branch independently.** Adding module lookup to
  `lower_expr`, special index support to `.map()`, and one-off icon/helper paths
  spreads one semantic problem through `lower.rs` and still fails nested cases.
- **Evaluate source with Bun/Node at build time.** Arbitrary execution is
  non-deterministic, unsafe for source builds, and breaks the standalone native
  compiler contract.
- **Accept React SSR slots for private same-file helpers.** Those helpers have no
  importable factory identity, so the slots would be unresolved. Imported child
  components are different and may safely fall back locally through the merged
  import map.

## Acceptance

- The in-repo representative fixture inlines without warnings or
  component-manifest entries when built with the local Brust CLI/addon.
- Its private same-file helpers also leave no SSR factory entries.
- An unsupported in-repo control component warns and retains its existing SSR
  entry even without a `native` marker.
- Runtime-prop maps, hook/side-effect fallback, islands, behavior components,
  lucide SVGs, and existing native routes remain green.
