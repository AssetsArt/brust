# m4cf-release-wiring: publish `@brust/cache-redis` + `@brust/cache-cloudflare` from release.yml and the release scripts

**SOLO by lead Detoro 2026-10-12 (integration work outside every lane's boundary; the handoff cost more than the 14-line change). Done on m4cf directly, release gates run by the lead.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf · tier: routine

## Why (plan defect, lead's own)
Plans `cache-redis` and `cache-cloudflare` both handed their release lines to "whichever of lane 6 / lane B merges later", but lane 6 (`m4cf-ci`, owner of `release.yml`) merged BEFORE both adapter lanes, so nobody applied them: `release.yml` published neither adapter (dry-run loop, `pub` list, dist-tag list) and `scripts/release-files.ts` lacked `packages/cache-cloudflare/package.json`. Lane B did add `cache-redis` to `release-files.ts`.

## Change
- `scripts/release-files.ts`: `FILES` 11 → 12 (`packages/cache-cloudflare/package.json`).
- `scripts/release-bump.ts`: `EXPECTED` comment, and the `workspace:*` peer check now covers both adapters.
- `scripts/release-check.test.ts`: counts 12/12.
- `.github/workflows/release.yml`: dry-run loop adds both packages after `packages/brust`; publish order runtime-dom → natives → core-cf → core → cache-redis → cache-cloudflare → create-app (adapters peer on core); the prerelease dist-tag list adds both.

## Gates (run by the lead on m4cf)
`bun test scripts/release-check.test.ts scripts/core-cf-check.test.ts` 14/0; `bun scripts/release-check.ts 2.0.0-alpha.2` → `✓ 12/12`; `bun pm pack` of both adapters rewrites the peer to `2.0.0-alpha.2` (no `workspace:`).

## Guard
Future plans: a new publishable package names the lane that edits `release.yml` + `release-files.ts` IN ITS OWN BOUNDARY, never "whichever merges later".
