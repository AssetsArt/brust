# FRAMEWORK-GAPS — dogfood log (example/docs)

Gaps in brust found while building this docs site. Framework changes are out
of scope for the docs branch — each entry records the gap, the workaround
used here, and where it bit.

## G1 — no public md scan/slug export — relative import

`lib/search-index.ts` needs the md file list (`scanMdDir`) and the heading
slugger that `runtime/md/render.ts` uses for `<h2>/<h3>` ids, but neither is
exported from `brustjs`. Workaround: relative import
`../../../runtime/md/scan.ts` (in-repo example precedent) and a verbatim copy
of `render.ts`'s `slugify` (render.ts:400-406) plus a textRenderer-equivalent
inline-md normalizer, locked by parity tests against real rendered ids
(`lib/search-index.test.ts`). Bit: any future change to the render.ts slugger
silently desyncs index anchors — the task 1.7 integration check is the guard.

## G2 — mdRoutes layout has no first-class loader option

`mdRoutes('content', { layout })` returns the layout parent route, but there is
no `loader:` option — the sidebar/pager loader must be attached by mutating the
returned tree node (`docsTree.loader = async ({ path }) => buildDocsChrome(path)`
in `routes.tsx`). Works (chain loaders merge top-down; the leaf's `__md` head
fields survive because the chrome loader returns only `nav`/`pager`), but the
attachment pattern is undocumented framework surface.

## G3 — no conditional ATTRIBUTE in native templates

The ergonomic active-link form `aria-current={item.active ? 'page' : undefined}`
does not compile: ternaries are rejected in attribute position
(`lower_expr` → `ComplexExpressionNotSupported`, lower.rs:4114 — `Cond` is
unconditional, even in inline mode). Binding a precomputed string
(`aria-current={item.ariaCurrent}` with `'page' | ''`) compiles but renders
`aria-current=""` on every inactive link. Workaround used in `DocsLayout.tsx`:
the supported PER-ITEM TERNARY in the `.map` body child position —
`{item.active ? <a aria-current="page" …> : <a …>}` — which emits
`{% if item.active %}` around two anchor variants and omits the attribute
entirely on inactive items (verified: exactly one `aria-current="page"` per
rendered page). Cost: the anchor markup is duplicated across branches.

## G4 — cond test on an object member conflicts with deeper reads

`{pager.prev && <a href={pager.prev.path}>…}` fails to compile with
``prop `pager` used as both value and collection — type conflict``: the cond
TEST infers `pager.prev` as a scalar (`OwnedString`) while the body's
`pager.prev.path`/`.title` reads infer it as a `Struct`, and `merge_into`
(lower.rs:4756) treats the cross-shape merge as a `PropTypeConflict`.
Workaround: precompute sibling BOOLEAN keys in the loader
(`pager.hasPrev`/`pager.hasNext` in `lib/nav.ts`) and test on those.
