# Remote A/B: beta1 round, Mac Studio (2026-10-12)

**Host:** Mac Studio · Apple M2 Max · 32 GB · 12 cores · darwin/arm64
**Versions:** bun 1.4.4 · oha 1.16.0 · rust nightly-2026-09-15 (rustc 1.100.0-nightly) · elysia 2.0.0-beta.30
**Before:** brust v2 @ db51891f (release prep base), apps brust, bun-serve; probes S, D, I
**After:** brust beta1 @ 25217fcf (F82 merged), apps brust, bun-serve, elysia-bun; probes S, D, I, A1, A2
**Load:** conn 120 (rps probes), workers 12, dur 10 s, warm-up 3 s, identity + gzip. Load average at start: before 2.15 / 3.52 / 2.50, after 6.55 / 5.61 / 3.71.

Temporary evidence only. Not written into `bench/RESULTS.*`.

## S / D / I: before vs after (rps)

| app | probe | enc | before | after | delta |
|---|---|---|---:|---:|---:|
| brust | D | gzip | 18,200 | 18,254 | +0.3% |
| brust | D | identity | 18,948 | 18,824 | -0.7% |
| brust | I | gzip | 149,728 | 152,451 | +1.8% |
| brust | I | identity | 150,137 | 152,707 | +1.7% |
| brust | S | gzip | 147,676 | 148,228 | +0.4% |
| brust | S | identity | 148,322 | 148,842 | +0.4% |
| bun-serve | D | gzip | 5,254 | 5,236 | -0.4% |
| bun-serve | D | identity | 5,230 | 5,207 | -0.4% |
| bun-serve | I | gzip | 64,776 | 64,705 | -0.1% |
| bun-serve | I | identity | 64,615 | 64,460 | -0.2% |
| bun-serve | S | gzip | 42,968 | 43,126 | +0.4% |
| bun-serve | S | identity | 42,854 | 42,881 | +0.1% |

All 24 rows: 0 errors. Largest |delta| is +1.8% (brust I). No S/D/I row is over 5%, so no task challenge.

## A1 / A2 (after only): elysia-brust vs elysia-bun

| app | probe | conn | rps | latency | errors |
|---|---|---:|---:|---|---:|
| brust | A1 | 1 | 17,637 | p50 0.055 ms | 0 |
| brust | A1 | 120 | 146,998 | p50 0.789 ms | 0 |
| elysia-bun | A1 | 1 | 27,085 | p50 0.035 ms | 0 |
| elysia-bun | A1 | 120 | 101,489 | p50 1.202 ms | 0 |
| brust | A2 | 1 | 16,912 | p50 0.057 ms | 0 |
| brust | A2 | 120 | 155,100 | p50 0.705 ms | 0 |
| elysia-bun | A2 | 1 | 25,716 | p50 0.037 ms | 0 |
| elysia-bun | A2 | 120 | 90,644 | p50 1.330 ms | 0 |

At conn 120 elysia-brust is ahead: A1 146,998 vs 101,489 rps (+45%), A2 155,100 vs 90,644 rps (+71%). At conn 1 elysia-brust is about 20 µs slower per request (A1 p50 0.055 vs 0.035 ms, A2 p50 0.057 vs 0.037 ms).

## Notes
- Both runs exit 0. The bench reported "1-proc: reusePort did not balance" for bun-serve and elysia-bun, so their rps is one process, not 12. Compare them only with each other from the same run.
- The bench's own summary marks the bar rows (F68, sanity vs next) as NOT MEASURED. The next app was skipped on this host.
- Raw JSON (`before.json`, `after.json`) is the unmodified bench output.
