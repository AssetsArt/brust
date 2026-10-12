# beta1-no-hostname: bench headers carry the machine model, chip and RAM (never the hostname)

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Human rule: no machine hostname in any Markdown file. Routine lane; no re-measurement.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-no-hostname · tier: routine · review: standard

**Goal (amended by the human 2026-10-12: "ใส่แค่เป็น mac อะไร CPU อะไร RAM เท่าไหร่").** `bench/run.ts` no longer calls `hostname()`; the header gains a `machine` descriptor `{ model, chip, memGb }` collected once per run — macOS: `system_profiler SPHardwareDataType` → `Model Name`, `Chip`, `Memory` (e.g. `MacBook Pro`, `Apple M1 Pro`, `16 GB`); Linux fallback: `model` = `/sys/devices/virtual/dmi/id/product_name` or `linux`, `chip` = the `model name` line of `/proc/cpuinfo`, `memGb` = `Math.round(os.totalmem()/2**30)`. The rendered header line reads `MacBook Pro · Apple M1 Pro · 16 GB · 10 cores · darwin/arm64 · bun … · oha …` — no hostname anywhere. The `host` field becomes `<platform>/<arch>` only. `bench/RESULTS.json` (both the page block and the `actions` block) and `bench/RESULTS.md` carry no hostname; RESULTS.md is regenerated from RESULTS.json by the report code (numbers untouched). `git grep -n -E '\.local\b|MacBook-Pro' -- bench '*.md'` returns nothing (the words `MacBook Pro` as a model name are expected).

## Boundary
`bench/run.ts`, `bench/lib/report.ts`, `bench/lib/report.test.ts`, `bench/lib/fixtures/*.json`, `bench/RESULTS.json`, `bench/RESULTS.md`, `bench/README.md` (one sentence on the header), `bench/ATTRIBUTION.md` (only if it carries a hostname — check).

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-no-hostname`; `bun install --frozen-lockfile`; `bun test bench/lib` green baseline.
2. Test first: in `bench/lib/report.test.ts` assert the rendered header contains `host darwin/arm64 ·` style text without any `.local`/hostname for a fixture whose `host` is `darwin/arm64` (update the fixtures' `host` fields to `<platform>/<arch>`; if a test asserts the old hostname string, that assertion changes).
3. `bench/run.ts:173`: `const host = \`${process.platform}/${process.arch}\`` and drop `hostname` from the `node:os` import (line 7). `bench/lib/report.ts` needs no change unless it formats the host; verify.
4. Data: edit `bench/RESULTS.json` with a small script (no hand edits) — every `host` field → `darwin/arm64` and add `machine: { "model": "MacBook Pro", "chip": "Apple M1 Pro", "memGb": 16 }` to every header (both blocks were measured on this machine — lead-verified via system_profiler); then regenerate `bench/RESULTS.md` through the report writer (find how `run.ts` writes it — e.g. a `--report-only` path or call `writeReport` from a one-off `bun -e`; if no such path exists, add a tiny `bench/report.ts` entry `bun bench/report.ts` that renders RESULTS.md from RESULTS.json and document it in README). `git diff bench/RESULTS.md` must show only the two header lines changing.
5. `bench/README.md`: one sentence: "the header names the machine model, chip, RAM, core count and platform/arch — never the hostname (repo rule)". Check `bench/ATTRIBUTION.md` for a hostname; scrub the same way if present.
6. `bun test bench/lib`, `cd bench && bun run typecheck`, `git apply --check bench/attribution.patch`, `bun run m2-exit` (RESULTS.json header change must not alter the report — if it does, say so) all green; commit `bench: no hostname in headers (platform/arch only), RESULTS regenerated`; READY note with the grep proof.

## Acceptance (Afrojack)
`git grep -n -E '\.local\b|MacBook-Pro' -- bench '*.md'` empty; every RESULTS.md header shows model · chip · RAM · cores; `git grep -n hostname -- bench/run.ts` empty; RESULTS.md numbers identical to before (diff = headers only); tests green.
