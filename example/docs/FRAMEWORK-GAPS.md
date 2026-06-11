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
