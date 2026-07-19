# Hot Reload Island Staleness Diagnosis

Conclusion: I could not confirm a stale emitted island chunk on the current head. Two clean-copy differentials from committed `tests/fixtures/app` both rebuilt the island chunk on edit, and a fresh-process boot from the same edited source produced the same chunk bytes. The dev response for that chunk is `Cache-Control: no-store`, so the earlier stale-artifact observation is not reproducible from clean source state.

## Fail Path

The hypothesized path was:

`components/Counter.tsx` edit -> watcher -> coordinator -> `buildIslands()` -> `_islands.js` / island chunk rewrite -> browser reload -> page sees new island code.

On this head, that path completes successfully:

- the watcher emits `hotreload .../components/Counter.tsx`
- the coordinator reports `→ ok`
- the chunk file on disk changes to include the new rendered marker
- the chunk response is served with `cache-control: no-store`

So the reported failure mode, "building -> reload -> ok while the emitted client chunk remains stale", was not reproduced here.

## Hash Ledger

Fresh control source from the committed fixture:

- `tests/fixtures/app/components/Counter.tsx`
- sha256: `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12`

Clean-copy A pre-edit source:

- `tests/fixtures/hot-reload-island-clean-c/components/Counter.tsx`
- sha256: `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12`

Clean-copy A hot-reload source after edit:

- `tests/fixtures/hot-reload-island-clean-c/components/Counter.tsx`
- sha256: `3a5eb8667f53864a585f45639e215a889aaaf8f735f8062f40e22c67abe890d1`

Clean-copy A emitted artifacts after hot reload:

- `tests/fixtures/hot-reload-island-clean-c/.brust/islands/Counter_d3b36583.js`
- sha256: `863e52d88899681640a242c86166595b8400d8c6685b4c048b692446071e9e33`
- contains `island-clean-c-1`

- `tests/fixtures/hot-reload-island-clean-c/.brust/islands/_islands.js`
- sha256: `77a70f3c962dcf44b933a0208af787a989fc58e2c3d8d937a0a5875fa8d9a650`
- maps `Counter_d3b36583` and `Counter` to `/_brust/islands/Counter_d3b36583.js`

- `tests/fixtures/hot-reload-island-clean-c/.brust/islands/_island-sources.json`
- sha256: `d23fe30fd2ecb59e35b32ce5137213385832d9f243eceb28fd583375fd756333`
- records `Counter_d3b36583 -> components/Counter.tsx`

Fresh-process control for copy A:

- `tests/fixtures/hot-reload-island-clean-c/.brust/islands/Counter_d3b36583.js`
- sha256: `863e52d88899681640a242c86166595b8400d8c6685b4c048b692446071e9e33`
- identical to the hot-reload artifact from the same edited source

Clean-copy B pre-edit source:

- `tests/fixtures/hot-reload-island-clean-d/components/Counter.tsx`
- sha256: `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12`

Clean-copy B hot-reload source after edit:

- `tests/fixtures/hot-reload-island-clean-d/components/Counter.tsx`
- sha256: `de00913ba7e1ad3f2c3cab5daa9cc9353e70a25a26e9ef6c6967c6014e5dcfec`

Clean-copy B emitted artifacts after hot reload:

- `tests/fixtures/hot-reload-island-clean-d/.brust/islands/Counter_d3b36583.js`
- sha256: `4627fafe71584a616ec0f502961006f1d50ef92528efb3ed9defca6b55e29f8e`
- contains `island-clean-d-1`

Fresh-process control for copy B:

- `tests/fixtures/hot-reload-island-clean-d/.brust/islands/Counter_d3b36583.js`
- sha256: `4627fafe71584a616ec0f502961006f1d50ef92528efb3ed9defca6b55e29f8e`
- identical to the hot-reload artifact from the same edited source

Live HTTP header for the rebuilt chunk:

- `GET /_brust/islands/Counter_d3b36583.js`
- `cache-control: no-store`

## Ranked Hypotheses

1. Browser cache reused a stable island URL.
- Prediction: the chunk response would be cacheable, so a reload could legitimately reuse old bytes.
- Disproof: the live dev server returns `cache-control: no-store` for `/_brust/islands/Counter_d3b36583.js`, so the browser is instructed not to reuse the chunk.

2. `buildIslands()` did not rewrite the chunk.
- Prediction: the on-disk `Counter_*.js` would keep the old marker after the edit.
- Disproof: after editing `components/Counter.tsx`, the rebuilt chunk contains `island-repro-marker`, so the file on disk was rewritten successfully.

3. The URL map or source manifest stayed stale even though the chunk changed.
- Prediction: `_islands.js` or `_island-sources.json` would keep pointing at the old source/state.
- Disproof: `_islands.js` still resolves the same path by design, and `_island-sources.json` records the current source path for `Counter_d3b36583`. The live data matches the current build state.

4. The stale symptom only exists on a browser-driven page load, not in the server/build path.
- Prediction: a browser reload test would be needed to reproduce the mismatch.
- Status: not confirmed. The clean-copy differential shows the server/build path rewrites the chunk correctly from clean source, and the fresh-process control matches the hot-reload artifact byte-for-byte.

## Disproof Results

- `bun test runtime/islands/build.test.ts` passed.
- The island-serving integration check in `tests/integration.test.ts` passed, including `island chunk + bootstrap served at /_brust/islands/<file>`.
- Clean-copy A and B both started from the committed source hash `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12` with no `.brust` directory.
- Both copies rebuilt the island chunk on edit, and the fresh-process control for each copy produced identical chunk bytes to the hot-reload artifact.
- The chunk response is `no-store`, so the dev path does not leave island bytes cacheable.

## Source Trace

- `runtime/index.ts:864-869`
- `runtime/index.ts:715-723`
- `runtime/islands/build.ts:140-204`
- `runtime/islands/chunk-id.ts:4-16`
- `runtime/dev/client.ts:15-18`

Those lines are the complete server-side chain for this diagnosis:

- dev mode explicitly opts into `no-store` for unhashed static assets
- hot reload always re-runs `buildIslands()` for render-affecting edits
- island chunk names are path-addressed, not content-addressed
- the browser dev client turns `reload` into `location.reload()`

## Regression-Test Seam

The existing suite proves chunk serving and static island bootstrap, but it does not prove the browser-visible hot-reload path from a live page through a reload and back into the hydrated island text.

Smallest correct seam:

- boot a dev server in a browser-capable harness
- load a route with an island
- edit the island source
- wait for the `reload` frame and the full page reload
- assert the rendered island text changes in the browser DOM

That seam is missing here. Without it, a stale-browser report can be mistaken for a server/build problem, which is exactly the ambiguity this investigation initially hit.
