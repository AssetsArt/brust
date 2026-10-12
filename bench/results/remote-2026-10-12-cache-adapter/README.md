# Remote A/B: cache adapter lane A, no adapter configured (2026-10-12)

**Host:** Mac Studio · Apple M2 Max · 32 GB · 12 cores · darwin/arm64
**Versions:** bun 1.4.4 · oha 1.16.0 · rust nightly-2026-09-15 · brust 2.0.0-alpha.2
**BEFORE:** m4cf @98968df (lane 6 merged, lane A not) · seeds 11, 12
**AFTER:** m4cf @26f0d7e (lane A merged) · seeds 11, 12
**Setup:** app brust only, NO `[cache] adapter` configured, probes S, D, I, identity + gzip, conn 120, dur 10 s, warm-up 3 s, release addon. `cargo clean -p brust-core -p brust-server -p brust-napi` before the AFTER build.

## Verdict

**PASS on the bar.** Compared best-of-two vs best-of-two, every S/D/I row is within ±0.65% (largest −0.65%, I identity).

**Worst single pairing** is I identity at −2.05%. The bar is best-of-two, so this is listed for information only and is inside 3% anyway.

## Table (rps)

| probe | enc | before best | after best | delta | worst-case delta |
|---|---|---:|---:|---:|---:|
| S | identity | 148,066 | 147,970 | -0.06% | -0.31% |
| S | gzip | 147,581 | 147,373 | -0.14% | -0.14% |
| D | identity | 18,961 | 18,938 | -0.12% | -0.29% |
| D | gzip | 18,388 | 18,384 | -0.02% | -0.33% |
| I | identity | 151,695 | 150,708 | -0.65% | -2.05% |
| I | gzip | 151,105 | 151,936 | +0.55% | -1.13% |

All 24 measurement rows (6 per run, 4 runs): 0 errors. Raw per-run values are in the JSON files.

## Files
- `before-11.json`, `before-12.json`, `after-11.json`, `after-12.json` (unmodified bench output)
- `README.md` (this file)
