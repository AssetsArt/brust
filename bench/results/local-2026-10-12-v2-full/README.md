# Full bench on v2 @daaea0a (beta1 + M4-CF), 2026-10-12 — NOT the committed suite

**Host:** MacBook Pro · Apple M1 Pro · 16 GB · 10 cores · darwin/arm64 (load 5.66 at start, swap in use after a day of builds)

Why it lives here and not in `bench/RESULTS.*`: this run skipped `brust-01x` (`BRUST_01X_DIR` unset), and the committed suite must carry the 0.1.x rows — `scripts/m2-exit` closes ledger F68 on them (`bench/RESULTS.json`, v2 vs 0.1.x). The committed suite stays the 2026-10-11 run.

Verdict that matters: brust I identity landed at 90,331 rps here vs 104,889 on 2026-10-11 while every control row (bun-serve, next) was +2…+4%. A three-variant interleaved A/B of the same trees (BASE 97b944a 101,731 · MID 0f0a136 100,736 · NOW daaea0a 105,061, best-of-3, cold server per run) shows **no code regression** (+3.3%); the dip is a full-run-only host artifact. Next committed suite: a full run with `brust-01x` on a freshly booted host.
