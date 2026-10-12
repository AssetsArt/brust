# Remote A/B: brust-core split (lane 1), Mac Studio (2026-10-12)

**Host:** Mac Studio · Apple M2 Max · 32 GB · 12 cores · darwin/arm64
**Versions:** bun 1.4.4 · oha 1.16.0 · rust nightly-2026-09-15 · brust 2.0.0-alpha.2
**BEFORE:** m4cf base v2 @0f0a136 · seeds 11, 12
**AFTER:** lane/m4cf-core-split @a86d6d4 · seeds 11, 12
**Setup:** app brust only, probes S, D, I, identity + gzip, conn 120, dur 10 s, warm-up 3 s, release addon, measured back to back on the same machine.

## Verdict

**PASS on the stated bar.** Compared as best-of-two AFTER vs best-of-two BEFORE, every S/D/I row is within ±2.1% (largest −2.06%, I identity).

**Worst case listed for the lead:** I gzip is −3.88% (AFTER seed 12 vs BEFORE seed 11). This is one pairing of single runs, not the best-vs-best figure the bar uses. The after-11 run and the after-12 rerun were taken at different host loads (see below), so this single pairing may be noise. Lead to decide whether it counts.

## Table (rps)

| probe | enc | before best | after best | delta | worst-case delta |
|---|---|---:|---:|---:|---:|
| S | identity | 147,877 | 148,849 | +0.66% | +0.14% |
| S | gzip | 148,258 | 148,897 | +0.43% | -0.27% |
| D | identity | 18,962 | 19,021 | +0.31% | -0.11% |
| D | gzip | 18,393 | 18,320 | -0.39% | -0.81% |
| I | identity | 152,803 | 149,649 | -2.06% | -2.38% |
| I | gzip | 152,427 | 150,304 | -1.39% | -3.88% |

All 12 runs (6 rows × 4 runs): 0 errors. Raw per-run values are in the JSON files.

## Load and reruns
- BEFORE load at start: 2.18 / 1.25 / 1.13 (1, 5, 15 min).
- AFTER seed 11 started at load 10.01 / 6.88 / 3.62, after the AFTER build. AFTER seed 12 was refused by the bench load guard (exit 2, load 12.17 > 12 cores) and was rerun after load fell below 10 (exit 0). Its JSON is from the rerun.

## Files
- `before-11.json`, `before-12.json`, `after-11.json`, `after-12.json` (unmodified bench output)
- `README.md` (this file)
