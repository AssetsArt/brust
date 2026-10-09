# bench

Three `oha` probes on v2 `examples/pokedex` and (optionally) on the 0.1.x `example/pokedex`.

```bash
cd packages/brust && bun run build                       # RELEASE addon (not build:debug)
BRUST_RELEASE_ADDON=1 bun run bench                      # v2 only → bar: not measured
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench
```

Prerequisites: `oha` on PATH; the release addon above; for the 0.1.x side its release addon
(`cd $BRUST_01X_DIR/runtime && bun run build`) and its pokedex built
(`bun run runtime/cli/index.ts build example/pokedex/index.ts`). The 0.1.x loaders hit PokeAPI on
the first request per name (the warm-up does that once), so the 0.1.x side needs network.

Knobs: `BENCH_CONN` (120), `BENCH_DUR` (`10s`), `BENCH_WARMUP` (`3s`), `BRUST_WORKERS` (6).
Outputs `RESULTS.json` / `RESULTS.md` (generated, committed; macOS numbers are not Linux numbers).

## Per-stage attribution (`attribution.ts`)

Process CPU per request (`ps` CPU seconds / requests served, plus a per-thread split on macOS) for probes B and C on v2
and 0.1.x, with the host load average recorded per run. For per-stage µs on v2, apply the temporary instrumentation
first and rebuild the release addon; never commit it applied:

```bash
git apply bench/attribution.patch && (cd packages/brust && bun run build)
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x BENCH_CONN=120,1 bun run bench/attribution.ts
git apply -R bench/attribution.patch && (cd packages/brust && bun run build)
```

`BRUST_PERF_CPU=1` adds thread-CPU readings around the synchronous page segments (costs ~1 µs per reading).
`cargo bench -p brust-server --bench render -- loader_parse` times the loader-response parse on its own.
