# DRAFT — M2 server spec amendments for M3-P P6 (lane `m3p-d-single-roundtrip`)

Status: DRAFT for the lead (2026-10-10). Not part of any spec until the lead rules and pastes the
blocks into `docs/design/2026-10-09-m2-server-design.md` (docs commit straight to the branch). The
blocks follow the M2 amendment style (bold lead-in with date and ruling, then prose / bullets).

Two variants. **Variant R** (recommended; what `docs/plans/2026-10-10-m3p-d-single-roundtrip.md`
implements, ruling R1) keeps job keys in Rust and plans inside the worker call. **Variant L** is
§3 of `docs/design/2026-10-10-m3-perf-bench-design.md` as written (keys in the worker). Paste ONE.
Evidence for the choice: plan section "Evidence the lane starts from" (E1-E9) and Appendix A.

Insertion points (line numbers at m3p @ 42db1d1):

| block | after line | anchor text |
|---|---|---|
| S1 amendment | 49 | "lives in Rust and `render` runs on tokio." (end of the S1 paragraph, before "**Rejected:**") |
| S6 amendment | 234 | "…so the cache key is computed without Bun. `use_id_slots` is …" paragraph (end of S6) |
| S7 amendment | 268 | step 7 of S7 (before "**S8 — `Outlet` …**" at 270) |
| §7 amendment | 367 | the last bullet of §7 ("Logs: …, Bun calls made (0/1/2), and duration.") |

Also note for the lead: §0 Goal (line 11: "calls Bun at most twice per page (route loader, then one
batched call for the component jobs that missed the cache)") stays historically true for M2; the S1
amendment supersedes it from M3-P on. No other section mentions the call count.

---

## Variant R (recommended)

### S1 amendment

**S1 amendment (2026-10-10, M3-P P6, lane `m3p-d-single-roundtrip`; ruled by the lead on the m3p-d plan):**
the `loader` call carries a **plan offer**. Its request gains `"plan": true` (omitted when false)
when the route's chain has at least one job (a chain component's own job or an inlined child's).
A worker that takes the offer, after an `ok` chain, writes the loader response into its SAB slot
and calls the sync addon export `planJobs(slot, len)` from its own JS thread; the answer is the
`JobsRequest` JSON of the jobs that missed the job cache, `""` when every job hit, or `"!"`
(declined). It then runs only those jobs and answers `{ planned: true, results: [{ id, value | error }] }`
in the same slot — one round trip for the page. On `"!"` it returns the loader response already in
the slot, and Rust plans after the call exactly as before (the `jobs` call stays, as the fallback
and for routes without a loader). Taking the offer is optional: a worker that ignores `plan` gets
the two-call flow. The call table becomes:

| call | when | request (inline JSON string) | response (worker SAB slot) |
|---|---|---|---|
| `loader` | the leaf route chain has at least one loader and L1 missed | `{ routeId, params, path, req, plan? }` | `{ ok: true, data, headers? } \| { verdict: … } \| { error } \| { planned: true, results }` |
| `jobs` | a route without a loader has a job miss, or the worker declined / ignored the plan offer and a job missed | `{ jobs: [{ id, componentId, kind, inputs, target?, row? }] }` | `{ results: [{ id, value \| error }] }` |

`planJobs` runs Rust on the Bun worker thread: it reads the slot bytes the worker just wrote on that
same thread (the response direction — the SAB still never carries a request), parses them into the
context, runs the same planning and job-cache lookup as S7 step 5, pins the hit values, and leaves
the result in the claimed slot's plan cell, which the request takes after the call and which the
claim's release always clears. It never throws; every failure declines.

### S6 amendment

**S6 amendment (2026-10-10, M3-P P6; ruled by the lead on the m3p-d plan):** the job key is
unchanged — `(componentId, jobId, blake3(canonical JSON of inputs))` computed by
`brust-server`'s `inputs::job_key`, or the namespaced `cache({key})` user key — and stays the only
implementation. Since P6 it is also computed on a Bun worker thread (inside `planJobs`, same Rust
function, same job cache), never in JavaScript. A committed fixture of 20 keys
(`crates/brust-server/tests/fixtures/job-keys-20.json`) pins the key bytes; changing them needs an
amendment here (no cache is persisted, so a change needs no migration, only the ruling).

### S7 amendment

**S7 amendment (2026-10-10, M3-P P6; ruled by the lead on the m3p-d plan):** steps 4 and 5 run in
ONE worker call when the route has a loader and jobs and the worker takes the plan offer (S1
amendment): the worker runs the loaders; Rust, on the worker's thread, merges the data into the
context, evaluates every job's inputs and key, looks up the job cache and pins the hits (step 5's
rules unchanged: template order, per-row instances, in-page dedupe of identical keys, no
cross-request coalescing); the worker runs the misses; after the call Rust validates the results,
stores them with their ttl, tags and user key (so `cache.invalidate` by tag, key or path keeps
working), fans them out to plans sharing a key, then continues with step 6 unchanged. A value pinned
at planning time renders even if an invalidation lands before the render, exactly as a hit pinned
before the M2 `jobs` call did; the next request sees the invalidation. A verdict, an error, a
declined or ignored offer, and a route without a loader follow steps 4-5 as written. The rendered
document is identical on both paths.

### §7 amendment

**§7 amendment (2026-10-10, M3-P P6; ruled by the lead on the m3p-d plan):** `bun_calls` in the
request log is the number of worker **round trips** the request made: 0 for an L1 HIT or a page
without a loader whose jobs all hit; 1 for a page whose loader returned data (its jobs ran in the
same call), and for a page without a loader that had a job miss; 2 only when the worker declined or
ignored the plan offer and a job missed, or when a `notFound` verdict renders a template with a job
miss. `/_brust/cache/stats`: `loader_calls` counts calls that ran the loader chain (unchanged);
`job_calls` counts job **batches** the worker ran — a `jobs` call, or the misses run inside a
planned `loader` call (every M2 count stays numerically the same); new `worker_calls` counts round
trips (the sum of `bun_calls`).

---

## Variant L (§3 of the M3-P spec as written)

### S1 amendment

**S1 amendment (2026-10-10, M3-P P6, lane `m3p-d-single-roundtrip`):** one worker call per page.
The `loader` request carries the route id; the worker derives the route's plan (component ids, prop
maps, literals, plan templates) from the `manifest.json` it loads at boot — no plan crosses the
wire. After the loaders it computes every job key, calls the sync addon export
`jobLookup(slot, keys: string[]): Uint8Array` (a hit bitmask over the SAME job cache; the hit
values are pinned in the claimed slot so an eviction or invalidation before the render cannot
remove them), runs the misses and answers `{ ctx, jobs: [{ key, id, output }], hits: [index] }`.
The `jobs` call kind is removed. A page without a loader but with jobs also makes one call (the
keys exist only in the worker).

### S6 amendment

**S6 amendment (2026-10-10, M3-P P6):** the job key is produced by the worker and opaque to Rust:
sha256 (hex) over `u32le len(componentId) componentId u32le len(keyJob) keyJob u32le len(json) json`,
`json` = canonical JSON of the job's inputs (keys sorted by UTF-16 code units, `JSON.stringify`
number text), `keyJob` = the job id or `<jobId>#<row>` as before; a `cache({key})` key stays
`k:<componentId>/<keyJob>/<user key>`. One implementation, `packages/brust/src/job-key.ts`; a
committed fixture of 20 keys pins it. 64-bit hashes are rejected (inputs may derive from request
data; a crafted collision would poison the job cache). Rust stores keys as opaque strings;
`inputs::job_key` and `plan_key` are removed.

### S7 amendment

**S7 amendment (2026-10-10, M3-P P6):** step 4 and step 5 become one call: the worker runs the
loaders, evaluates inputs and keys, looks up the job cache through `jobLookup`, runs the misses;
Rust derives each job's destination from the manifest and the returned context, reads the pinned
hits, inserts the fresh results with ttl/tags/user key, merges, and continues with step 6.

### §7 amendment

**§7 amendment (2026-10-10, M3-P P6):** `bun_calls` = worker round trips: 0 on an L1 HIT or a page
with neither loader nor jobs, else 1. Stats: `loader_calls` = page calls that ran a loader chain;
`job_calls` = page calls that ran at least one job; `worker_calls` = round trips.
