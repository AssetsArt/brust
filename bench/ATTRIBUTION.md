# bench/ATTRIBUTION.md — post-P6 attribution tree (M3-P §5)

Companion to `bench/RESULTS.md` (spec `docs/design/2026-10-10-m3-perf-bench-design.md` §5: "Record the final tree in
`bench/ATTRIBUTION.md`"). This is the tree after every wave-3 lever (P0, P5, P1, P2, P3, P8, F75, P4, P6), measured on
`m3p` @ 2ca941d on 2026-10-11. It is what the P7 plan (`docs/plans/2026-10-11-m3p-e-tail.md`) was chosen from.

## Method

- **Host:** darwin/arm64, 10 cores (8 performance + 2 efficiency), shared with other agents. The bench host lock
  (`/tmp/brust-bench.lock` + blackboard `bench:host-lock`) was held for every run. 1-min load at the start of each
  measured row: 2.6–7.3 (logged per row below).
- **Build:** a release addon of 2ca941d with `bench/attribution.patch` applied in a **scratch copy** of the worktree
  (APFS clone, no `.git`). The worktree was never patched. Bench app `bench/apps/brust`, `brust start --workers 6`
  (the `attribution.ts` default, the same as the pre-P6 runs), `oha -H 'accept-encoding: identity'`, a discarded 3 s
  warm-up, then 10 s measured.
- **Command** (in the scratch copy, under the lock wrapper):
  `BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I,S,M bun bench/attribution.ts`.
  The only change in the copy was the server port (38211 → 38911).
- **Probes:** D `/dex?nocache=1`, I `/team?nocache=1`, S `/types` (an L1 HIT), M `/team?nocache=1&start=<random 7 digits>`
  (every job misses: the island's `renderToString` runs on every request).
- **Stage times** are wall µs per page request, summed per thread by the patch (`/_brust/perf`). At c=120 the wall
  times inside the worker call are mostly queueing (`tsfn bridge` = waiting for a free JS thread), so **shares are read
  at c=1**. c=1 has no queueing, and each stage's wall time is close to its CPU time.
- **Per-request time** = the c=1 end-to-end latency, 1/rps. The part outside the service fn (hyper read/parse/write,
  the loopback kernel path and the client) is counted as **HTTP I/O**.
- **Inherent stages** (§5): the loader's JS handler (`chain loaders`), the island's `renderToString` (`missed jobs`,
  which is non-zero only on M; I's ssr job is a job-cache hit), and HTTP I/O. Everything else is overhead the
  framework adds.
- **CPU cross-check:** macOS `sample` (6 s at 1 ms) on the un-instrumented release build of 2ca941d under oha
  (`--workers 10`, as `bench/run.ts` runs it). Samples are grouped by thread kind and by the deepest matching frame.
  Blocked frames (`__psynch_*`, `kevent`, `__ulock_wait`) count as idle.

## The tree (2ca941d)


### D — c=1: 1831 rps, 498.0 µs CPU/req · c=120: 15432 rps, 598.9 µs CPU/req

| stage | c=1 µs | c=1 % of e2e | c=120 µs | c=120 % of svc | inherent |
|---|---:|---:|---:|---:|:---:|
| end-to-end latency at c=1 (1/rps) | 546.18 | 100.0% | | | |
| &nbsp;outside the service fn: hyper read/parse/write, kernel loopback, client = **HTTP I/O** | 90.82 | 16.6% | | | I |
| &nbsp;service fn (whole request inside hyper) | 455.36 | 83.4% | 1831.70 | 100.0% |  |
| &nbsp;&nbsp;&nbsp;route match + accept-encoding | 0.23 | 0.0% | 0.17 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;L1 decision | 0.51 | 0.1% | 0.59 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;request envelope | 0.08 | 0.0% | 0.10 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;params/path ctx | 0.12 | 0.0% | 0.16 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;loader call_worker (wall) | 138.66 | 25.4% | 1358.76 | 74.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;claim slot | 0.09 | 0.0% | 34.29 | 1.9% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;serialize request | 0.30 | 0.1% | 0.51 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;tsfn bridge round trip (dispatch − JS) | 15.90 | 2.9% | 1151.28 | 62.9% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JS handler (entry → slot written) | 34.03 | 6.2% | 45.27 | 2.5% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.parse | 0.78 | 0.1% | 0.93 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;**chain loaders** | 8.71 | 1.6% | 11.82 | 0.6% | I |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.stringify | 23.34 | 4.3% | 30.43 | 1.7% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;TextEncoder + SAB write | 1.10 | 0.2% | 1.81 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;SAB read + serde_json parse | 87.99 | 16.1% | 125.91 | 6.9% |  |
| &nbsp;&nbsp;&nbsp;merge loader data / planned results | 0.11 | 0.0% | 0.24 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;collect_jobs (tokio) | 0.14 | 0.0% | 0.12 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;job cache lookups (tokio) | 0.03 | 0.0% | 0.04 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;seed child slots / useIds | 0.06 | 0.0% | 0.09 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;merge job values | 0.02 | 0.0% | 0.03 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;render chain | 289.41 | 53.0% | 424.34 | 23.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;scope + get_template | 0.88 | 0.2% | 1.75 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render leaf template | 287.15 | 52.6% | 420.33 | 22.9% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render layout template | 0.99 | 0.2% | 1.68 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;inject_assets | 0.04 | 0.0% | 0.07 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;RenderedBody + response | 0.32 | 0.1% | 0.41 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;unattributed (svc − children) | 25.62 | 4.7% | 46.57 | 2.5% | |

**Inherent share (D, c=1 latency basis): 99.5 / 546.2 µs = 18.2%.**

### I — c=1: 14928 rps, 44.7 µs CPU/req · c=120: 103418 rps, 55.7 µs CPU/req

| stage | c=1 µs | c=1 % of e2e | c=120 µs | c=120 % of svc | inherent |
|---|---:|---:|---:|---:|:---:|
| end-to-end latency at c=1 (1/rps) | 66.99 | 100.0% | | | |
| &nbsp;outside the service fn: hyper read/parse/write, kernel loopback, client = **HTTP I/O** | 38.01 | 56.7% | | | I |
| &nbsp;service fn (whole request inside hyper) | 28.98 | 43.3% | 213.22 | 100.0% |  |
| &nbsp;&nbsp;&nbsp;route match + accept-encoding | 0.23 | 0.3% | 0.19 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;L1 decision | 0.52 | 0.8% | 0.73 | 0.3% |  |
| &nbsp;&nbsp;&nbsp;request envelope | 0.08 | 0.1% | 0.12 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;params/path ctx | 0.18 | 0.3% | 0.30 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;loader call_worker (wall) | 22.58 | 33.7% | 195.92 | 91.9% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;claim slot | 0.13 | 0.2% | 3.12 | 1.5% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;serialize request | 0.30 | 0.5% | 0.55 | 0.3% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;tsfn bridge round trip (dispatch − JS) | 13.67 | 20.4% | 173.04 | 81.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JS handler (entry → slot written) | 7.96 | 11.9% | 12.35 | 5.8% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.parse | 0.76 | 1.1% | 0.78 | 0.4% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;**chain loaders** | 4.02 | 6.0% | 5.62 | 2.6% | I |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;planJobs (Rust plan on the JS thread) | 2.90 | 4.3% | 5.45 | 2.6% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.stringify | 0.09 | 0.1% | 0.18 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;TextEncoder + SAB write | 0.08 | 0.1% | 0.16 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;SAB read + serde_json parse | 0.16 | 0.2% | 0.25 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;merge loader data / planned results | 0.04 | 0.1% | 0.19 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;seed child slots / useIds | 0.11 | 0.2% | 0.23 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;merge job values | 0.19 | 0.3% | 0.68 | 0.3% |  |
| &nbsp;&nbsp;&nbsp;render chain | 3.09 | 4.6% | 9.28 | 4.4% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;scope + get_template | 0.39 | 0.6% | 4.55 | 2.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render leaf template | 1.99 | 3.0% | 3.28 | 1.5% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render layout template | 0.46 | 0.7% | 1.01 | 0.5% |  |
| &nbsp;&nbsp;&nbsp;inject_assets | 0.34 | 0.5% | 0.51 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;RenderedBody + response | 0.35 | 0.5% | 0.41 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;unattributed (svc − children) | 1.26 | 1.9% | 4.64 | 2.2% | |

**Inherent share (I, c=1 latency basis): 42.0 / 67.0 µs = 62.7%.**

### S — c=1: 29188 rps, 12.4 µs CPU/req · c=120: 113994 rps, 24.7 µs CPU/req

| stage | c=1 µs | c=1 % of e2e | c=120 µs | c=120 % of svc | inherent |
|---|---:|---:|---:|---:|:---:|
| end-to-end latency at c=1 (1/rps) | 34.26 | 100.0% | | | |
| &nbsp;outside the service fn: hyper read/parse/write, kernel loopback, client = **HTTP I/O** | 33.18 | 96.8% | | | I |
| &nbsp;service fn (whole request inside hyper) | 1.08 | 3.2% | 1.60 | 100.0% |  |
| &nbsp;&nbsp;&nbsp;route match + accept-encoding | 0.22 | 0.6% | 0.15 | 9.4% |  |
| &nbsp;&nbsp;&nbsp;L1 HIT: decision + get + response | 0.52 | 1.5% | 0.80 | 50.1% |  |
| &nbsp;&nbsp;&nbsp;unattributed (svc − children) | 0.34 | 1.0% | 0.65 | 40.5% | |

**Inherent share (S, c=1 latency basis): 33.2 / 34.3 µs = 96.8%.**

### M — c=1: 12431 rps, 60.6 µs CPU/req · c=120: 90882 rps, 69.0 µs CPU/req

| stage | c=1 µs | c=1 % of e2e | c=120 µs | c=120 % of svc | inherent |
|---|---:|---:|---:|---:|:---:|
| end-to-end latency at c=1 (1/rps) | 80.45 | 100.0% | | | |
| &nbsp;outside the service fn: hyper read/parse/write, kernel loopback, client = **HTTP I/O** | 40.09 | 49.8% | | | I |
| &nbsp;service fn (whole request inside hyper) | 40.36 | 50.2% | 393.49 | 100.0% |  |
| &nbsp;&nbsp;&nbsp;route match + accept-encoding | 0.25 | 0.3% | 0.21 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;L1 decision | 0.64 | 0.8% | 0.93 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;request envelope | 0.10 | 0.1% | 0.12 | 0.0% |  |
| &nbsp;&nbsp;&nbsp;params/path ctx | 0.23 | 0.3% | 0.35 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;loader call_worker (wall) | 32.01 | 39.8% | 362.76 | 92.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;claim slot | 0.13 | 0.2% | 8.36 | 2.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;serialize request | 0.36 | 0.4% | 0.68 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;tsfn bridge round trip (dispatch − JS) | 14.44 | 18.0% | 318.82 | 81.0% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JS handler (entry → slot written) | 15.90 | 19.8% | 27.08 | 6.9% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.parse | 1.26 | 1.6% | 1.52 | 0.4% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;**chain loaders** | 4.13 | 5.1% | 7.03 | 1.8% | I |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;planJobs (Rust plan on the JS thread) | 4.56 | 5.7% | 9.26 | 2.4% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;**missed jobs = island renderToString** | 5.29 | 6.6% | 8.02 | 2.0% | I |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;JSON.stringify | 0.39 | 0.5% | 0.69 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;TextEncoder + SAB write | 0.11 | 0.1% | 0.35 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;SAB read + serde_json parse | 0.78 | 1.0% | 1.29 | 0.3% |  |
| &nbsp;&nbsp;&nbsp;merge loader data / planned results | 0.05 | 0.1% | 0.20 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;seed child slots / useIds | 0.10 | 0.1% | 0.23 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;merge job values | 0.20 | 0.2% | 0.59 | 0.2% |  |
| &nbsp;&nbsp;&nbsp;render chain | 3.24 | 4.0% | 9.46 | 2.4% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;scope + get_template | 0.42 | 0.5% | 4.64 | 1.2% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render leaf template | 2.09 | 2.6% | 3.29 | 0.8% |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;render layout template | 0.48 | 0.6% | 1.06 | 0.3% |  |
| &nbsp;&nbsp;&nbsp;inject_assets | 0.34 | 0.4% | 0.57 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;RenderedBody + response | 0.35 | 0.4% | 0.44 | 0.1% |  |
| &nbsp;&nbsp;&nbsp;unattributed (svc − children) | 2.85 | 3.5% | 17.62 | 4.5% | |

**Inherent share (M, c=1 latency basis): 49.5 / 80.4 µs = 61.5%.**

Load at the start of each row: D c=120 2.62 · D c=1 3.87 · I c=120 4.60 · I c=1 6.26 · S c=120 5.97 · S c=1 6.06 ·
M c=120 5.44 · M c=1 7.28. Bytes per call: D request 233 / response 23,037; I 247 / 16; M 279 / 168.

### Top non-inherent stages (c=1)

| probe | stage | µs/req | share of e2e |
|---|---|---:|---:|
| D | render leaf template (minijinja, 151 rows × ~1.5 badges) | 287.2 | 52.6% |
| D | SAB read + serde_json parse of the 23 KB loader response into `Node` | 88.0 | 16.1% |
| D | JS `JSON.stringify` of the loader result | 23.3 | 4.3% |
| D | tsfn bridge round trip | 15.9 | 2.9% |
| I | tsfn bridge round trip | 13.7 | 20.4% |
| I | planJobs on the JS thread (P6 plan of an all-hit page) | 2.9 | 4.3% |
| I | render chain | 3.1 | 4.6% |
| M | tsfn bridge round trip | 14.4 | 17.9% |
| M | planJobs on the JS thread | 4.6 | 5.7% |

### CPU basis (sampling, c=120, `--workers 10`)

| probe | server CPU/req | HTTP I/O (kernel `writev`/`recvfrom` + hyper) | loaders | render | JS thread total | tokio runtime |
|---|---:|---:|---:|---:|---:|---:|
| D | 597 µs | 2.9% | ~2% | ~51% (+ parse ~14%, alloc ~13%) | 14% | 0.3% |
| I | 55 µs | 42.5% | ~10% | 7.8% | 19.7% | 6.9% |

On I at c=120, 39% of the tokio threads' **wall** samples are blocked in `__psynch_mutexwait` (CPU is not counted).
The waits are on process-global locks taken on every request:
- the tokio timer-wheel lock: hyper's per-request `header_read_timeout` sleep (register + clear) and the loader
  call's `timeout_at` in `call_worker_planned` (register + clear). That is 4 lock operations per request, 8,462
  blocked samples;
- minijinja 3's `Environment::get_template`, which takes a `Mutex` and clones an `Arc` for owned templates, 2 per
  request (1,216);
- the pool's `idle_notify` `Notify` in `claim_or_wait`, which is registered before every claim, even an uncontended
  one, plus `notify_one` on release (836);
- tokio's inject queue, which every wake from a Bun worker thread pushes to (827).

### Inherent share — stop-rule input

| probe | c=1 latency basis | CPU basis (c=120) | ≥ 90%? |
|---|---:|---:|:---:|
| D | 18.2% (99.5 of 546.2 µs) | ~5% | no |
| I | 62.7% (42.0 of 67.0 µs) | ~52% | no |
| M | 61.5% (49.5 of 80.4 µs) | — | no |
| S | 96.8% (33.2 of 34.3 µs; HIT path, svc 1.1 µs) | — | yes (S is not in the rule's D/I set) |

## Comparison with the pre-P6 tree

Pre-P6 = `m3p` @ 42db1d1 (after P3, before P4/P6), same script, same 6 workers, 2026-10-10 (m3p-d `attr-before-bench`).
"P6 lane" = the P6 lane's own after-run, before it merged with P4 (m3p-d `attr-after-bench`). µs per request:

| probe / stage | pre-P6 | P6 lane | 2ca941d |
|---|---:|---:|---:|
| D c=1 rps · CPU/req | 1,802 · 495.9 | 1,807 · 504.0 | 1,831 · 498.0 |
| D c=1 service fn | 456.6 | 461.1 | 455.4 |
| D c=1 render leaf | 290.4 | 291.9 | 287.2 |
| D c=1 SAB read + parse | 88.3 | 87.9 | 88.0 |
| I c=1 rps · CPU/req | 15,110 · 42.8 | 14,446 · 46.8 | 14,928 · 44.7 |
| I c=120 rps · CPU/req | 102,071 · 51.5 | 100,440 · 56.5 | 103,418 · 55.7 |
| I c=1 JS handler total | 5.41 | 8.32 | 7.96 |
| I c=1 planJobs (JS thread) | — | 3.02 | 2.90 |
| I c=1 collect + lookup (tokio) | 0.95 | 0 | 0 |
| I c=120 service fn | 126.6 | 222.7 | 213.2 |
| M c=1 rps · CPU/req | 10,672 · 72.1 | 12,071 · 65.2 | 12,431 · 60.6 |
| M c=1 service fn | 53.4 | 42.6 | 40.4 |
| route match (all probes, c=1) | 0.52–0.59 | 0.48–0.54 | 0.23–0.25 (P4) |

Reading:
- **D is unchanged** by P4 and P6, as expected: D has no jobs, so no plan is offered, and it bypasses L1.
- **On I, P6 adds CPU:** about +2 µs/req at c=1 and +4 µs/req at c=120. The all-hit plan offer moves about 1 µs of
  tokio work onto the JS thread as about 3 µs (`planJobs`: the ctx is written to the slot, parsed again by Rust on the
  JS thread, planned, and an empty miss list is returned) and adds a second `{planned:true}` write. JS-thread time per
  request rises from 5.4 to 8.0 µs. At c=120 that roughly doubles the bridge queueing (97 → 173 µs in the service fn),
  while rps stays inside noise.
- **M gains as designed:** 72.1 → 60.6 µs CPU/req, 53.4 → 40.4 µs service fn, `bun_calls` 2 → 1.
- **P4** shows only as `route match` 0.5 → 0.2 µs here. Its target is S, where the HIT service fn is 1.1 µs.

## F68 A/B (v2 vs 0.1.x), 2026-10-11

`bun bench/run.ts --apps brust,brust-01x --probes D,I --dur 10s --enc identity --seed 100<r>`, 4 rounds back to
back, release addon of 2ca941d. The runner interleaves the two apps within each probe. `bench/RESULTS.*` was reverted
after each round.

| round | order | load (1/5/15) | D v2 / 0.1.x | D Δ | I v2 / 0.1.x | I Δ |
|---|---|---|---|---:|---|---:|
| 1 | 01x:I v2:I 01x:D v2:D | 4.4 4.3 5.5 | 15,155 / 13,874 | +9.2% | 101,579 / 83,006 | +22.4% (0.1.x went first, outlier) |
| 2 | v2:I 01x:I 01x:D v2:D | 5.3 5.7 6.0 | 14,997 / 13,805 | +8.6% | 101,557 / 104,905 | −3.2% |
| 3 | 01x:I v2:I v2:D 01x:D | 5.3 6.5 6.3 | 15,118 / 14,199 | +6.5% | 100,935 / 104,531 | −3.4% |
| 4 | 01x:I v2:I 01x:D v2:D | 5.7 6.7 6.5 | 15,101 / 14,137 | +6.8% | 102,503 / 104,160 | −1.6% |

**Median D +7.7% (range +6.5…+9.2), median I −2.4% (range −3.4…+22.4; three of four rounds negative) → F68 NOT MET
on I.** v2's I rps is very stable (100.9–102.5 k). 0.1.x sits at 104–105 k when it is not the first app of a run.

Why I behaves this way. In a connection sweep (`-c` 60/120/240, interleaved, 2 rounds), both servers are flat:
v2 I is 100–104 k and 0.1.x I is 100–105 k, so I is not latency-bound. The same sweep measured server CPU per request:
v2 **55.3 µs** against 0.1.x **50.0 µs** on I, and v2 24.5 µs against 0.1.x 21.8 µs on S (an L1 HIT whose service fn
is 1.6 µs). This host is near saturation with the server and oha together. The I gap is v2's extra ~5 µs of CPU per
request. About 3 µs of it is the HTTP layer: 0.1.x builds the same hyper `auto::Builder` but has no
`header_read_timeout` timer.

## Stop rule (§5) — NOT MET

1. **≥ 90% inherent: no.** D 18.2% (CPU basis ~5%), I 62.7% (CPU basis ~52%). D is dominated by template render and
   loader-response parse. On I, the largest non-inherent cost is the bridge plus per-request locks and timers.
2. **Two consecutive levers each < 2% on D and I: no.** The levers in landing order, excluding P4 (ruling R-D) and
   F75 (a correctness fix, not a lever), are:
   - P0+P5;
   - P8 (D +43% relative to 0.1.x: −59.9% → −16.8%);
   - P1+P2+P3 (D −16.8% → +14.1% vs 0.1.x, merge note 42db1d1);
   - P6 (lane A/B D +0.9%, I +2.0%; this tree shows P6 adding ~4 µs CPU/req on I).
   Only the last lever is < 2%, so there is one, not two. If P7 also lands < 2% on both D and I, the rule is met
   after P7.

So M3-P continues with P7. Plan: `docs/plans/2026-10-11-m3p-e-tail.md`.

## Scratch evidence (not committed)

The following files are under `/private/tmp/claude-501/-Users-detoro-code-brust/f9f1ca9f-9960-401d-990c-64a7577cb7d5/scratchpad/m3pe/`:
- `attr-head.{txt,json}` — this tree.
- `f68-r1..r4.{md,json,log}` — the F68 rounds.
- `sample-{D,I,M}-c{1,120}.txt` and `tools/cats_cpu.py` — the profiles.
- `csweep.log` — the connection sweep and CPU per request against 0.1.x.
- `ab-*.log` — the P7 prototype A/Bs.
- `proto-tree/crates/brust-jinja/examples/dexh.rs` — the parse/render micro-harness.
