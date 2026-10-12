# beta1-no-hostname: bench headers carry platform/arch + cores, never the machine hostname

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Human rule: no machine hostname in any Markdown file. Routine lane; no re-measurement.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-no-hostname · tier: routine · review: standard

**Goal.** `bench/run.ts` no longer calls `hostname()`; the `host` header field is `<platform>/<arch>` (cores are already a separate field). `bench/RESULTS.json` (both the page block and the `actions` block) and `bench/RESULTS.md` carry no hostname; RESULTS.md is regenerated from RESULTS.json by the report code (numbers untouched). `git grep -n -E 'MacBook|\.local\b' -- bench '*.md'` returns nothing.

## Boundary
`bench/run.ts`, `bench/lib/report.ts`, `bench/lib/report.test.ts`, `bench/lib/fixtures/*.json`, `bench/RESULTS.json`, `bench/RESULTS.md`, `bench/README.md` (one sentence on the header), `bench/ATTRIBUTION.md` (only if it carries a hostname — check).

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-no-hostname`; `bun install --frozen-lockfile`; `bun test bench/lib` green baseline.
2. Test first: in `bench/lib/report.test.ts` assert the rendered header contains `host darwin/arm64 ·` style text without any `.local`/hostname for a fixture whose `host` is `darwin/arm64` (update the fixtures' `host` fields to `<platform>/<arch>`; if a test asserts the old hostname string, that assertion changes).
3. `bench/run.ts:173`: `const host = \`${process.platform}/${process.arch}\`` and drop `hostname` from the `node:os` import (line 7). `bench/lib/report.ts` needs no change unless it formats the host; verify.
4. Data: edit `bench/RESULTS.json` — every `host` field → `darwin/arm64` (keep everything else byte-identical; use a small script, not hand edits); then regenerate `bench/RESULTS.md` through the report writer (find how `run.ts` writes it — e.g. a `--report-only` path or call `writeReport` from a one-off `bun -e`; if no such path exists, add a tiny `bench/report.ts` entry `bun bench/report.ts` that renders RESULTS.md from RESULTS.json and document it in README). `git diff bench/RESULTS.md` must show only the two header lines changing.
5. `bench/README.md`: one sentence: "the header names platform/arch and core count, never the machine's hostname (repo rule)". Check `bench/ATTRIBUTION.md` for a hostname; scrub the same way if present.
6. `bun test bench/lib`, `cd bench && bun run typecheck`, `git apply --check bench/attribution.patch`, `bun run m2-exit` (RESULTS.json header change must not alter the report — if it does, say so) all green; commit `bench: no hostname in headers (platform/arch only), RESULTS regenerated`; READY note with the grep proof.

## Acceptance (Afrojack)
`git grep -n -E 'MacBook|\.local\b' -- bench '*.md'` empty; `git grep -n hostname -- bench/run.ts` empty; RESULTS.md numbers identical to before (diff = headers only); tests green.
