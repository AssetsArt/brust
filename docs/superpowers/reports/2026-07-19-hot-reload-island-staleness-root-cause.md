# Hot Reload Island Root Cause

## Claim

The apparent "stale island chunk" repro was not a production island-build bug. The repro seam edited the fixture comment in `components/Counter.tsx`, not the rendered JSX node, so `Bun.build` correctly emitted byte-identical output for the island chunk while the dev server still reported `building → reload → ok`.

When the actual rendered JSX line was edited, the emitted chunk and the HTTP-served chunk both changed as expected.

## Confirmed

### Source, map, build, and HTTP identities

The task path is:

- `tests/dev-hot-reload-reliability.test.ts` skip-case `an island edit refreshes both the emitted and served client chunk`

That skip-case uses:

- `harness.write('components/Counter.tsx', harness.read('components/Counter.tsx').replace('{label}: {n}', ...))`

In the fixture-local `components/Counter.tsx`, the first `{label}: {n}` occurrence is the explanatory comment header, not the rendered JSX body. The visible JSX text is the second occurrence.

The relevant build path is:

- [runtime/index.ts](../../../runtime/index.ts) at the island build call site and dev `no-store` response setup
- [runtime/islands/build.ts](../../../runtime/islands/build.ts) for `buildIslands()` / `buildOne()`
- [runtime/islands/chunk-id.ts](../../../runtime/islands/chunk-id.ts) for the content-addressed chunk basename
- [runtime/dev/client.ts](../../../runtime/dev/client.ts) for `reload -> location.reload()`

`scanIslandChunks()` always maps `components/Counter.tsx` to `Counter_d3b36583`, because the id hashes the cwd-relative source path, not file contents.

### Repeatable runs

I ran three independent comment-only edits and one actual JSX edit. All four produced the same dev frame sequence: `building → reload → ok`.

Comment-only runs stayed byte-identical in the built and served chunk:

| Case | Source hash before | Source hash after | Chunk hash | Served hash | Marker in chunk | Marker in HTTP |
| --- | --- | --- | --- | --- | --- | --- |
| comment #1 | `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12` | `7d271e8884c87644ce1e570e9753f92807b3118c5d3f7551d1617b8fea9006ce` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | no | no |
| comment #2 | `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12` | `d60597b7a2a2da15431a8f802ef62eaa52370dfc84aa4ef52e386a10c74a0693` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | no | no |
| comment #3 | `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12` | `7d271e8884c87644ce1e570e9753f92807b3118c5d3f7551d1617b8fea9006ce` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | `07c6a548762c38d296deb33c53962a2564c576999722c6fbd6c53b550b0ef307` | no | no |

The actual JSX edit changed both outputs:

| Case | Source hash before | Source hash after | Chunk hash | Served hash | Marker in chunk | Marker in HTTP |
| --- | --- | --- | --- | --- | --- | --- |
| JSX line | `c0033f31c548c411e2a070b1d34146ce11acf2636ddfbd52b87a2766991e2b12` | `9e613438b806340ab59c9aa5c525a701062af3c2a61f12874c798392cedce2fc` | `05b1fc02c361e4c96ad6edd80abd9a6a99a6ec78d1fee13186673a0d653a3556` | `05b1fc02c361e4c96ad6edd80abd9a6a99a6ec78d1fee13186673a0d653a3556` | yes | yes |

The chunk map and source manifest stayed stable across both cases:

- `_islands.js`: `Counter_d3b36583 -> /_brust/islands/Counter_d3b36583.js`
- `_island-sources.json`: `Counter_d3b36583 -> components/Counter.tsx`

## Root Cause

The stale-chunk repro was a false positive caused by editing the fixture comment header instead of the rendered JSX node. Bun strips that comment from the bundle, so the island output and HTTP response remain unchanged by design.

This is not a cache issue:

- `buildIslands()` removes and recreates the islands output dir before each rebuild.
- The dev client handles reloads by full page reload, not cached chunk reuse.
- The dev server serves island artifacts with `Cache-Control: no-store`.

## Falsified Alternatives

- "The island chunk filename map is stale." Falsified. The map entry remained `Counter_d3b36583 -> /_brust/islands/Counter_d3b36583.js`, which is expected because the id is path-based.
- "The HTTP layer is serving an old cached chunk." Falsified. The served hash exactly matched the emitted hash in every run, and the response header was `no-store`.
- "The build pipeline is not reacting to the file edit." Falsified. `building → reload → ok` arrived on every run, and a real JSX edit changed both emitted and served bytes.

## Exact Boundary

No production island code change is warranted from this evidence.

The fix boundary is the characterization seam in `tests/dev-hot-reload-reliability.test.ts`:

- keep the regression scoped to the rendered JSX line, not the comment header
- if the test is meant to prove island rebuild freshness, mutate the JSX text node that survives the transform

## Formal Challenge

A formal challenge is filed on this task record: the original RED seam is invalid because `replace('{label}: {n}', ...)` matches the explanatory comment before the rendered JSX. The only valid follow-up is a test-only semantic JSX mutation; there is no production task here.

## Gate

If this investigation is turned into a test repair, the gate should be:

- `test -f tests/dev-hot-reload-reliability.test.ts`
- `bun test tests/dev-hot-reload-reliability.test.ts --test-name-pattern 'island edit refreshes'`
