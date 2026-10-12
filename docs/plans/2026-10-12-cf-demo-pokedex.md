# cf-demo-pokedex: a persistent pokedex demo on the human's Cloudflare account, from the PUBLISHED 2.0.0-alpha.3 packages

**RULED by lead Detoro 2026-10-12 (plan written by the lead; human: "publish แล้ว ลองเอา ทำ demo ขึ้น cloudflare ให้หน่อย", bb rule:publish-alpha3). Implementer knock2 (did the lane-C real deploy), reviewer: lead. Tier standard. Waits for the gate phrase `alpha.3 published` posted by the lead on this task.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 · lane: cf-demo-pokedex · tier: standard · review: lead

**Goal.** `https://brust-demo-pokedex.<account>.workers.dev` serves the pokedex app (team roster on D1), built from a FRESH scaffold of the published npm packages — this doubles as the alpha.3 fresh-install smoke. The demo STAYS UP (human request); it is the one exception to the delete rule in bb rule:cloudflare-account. Nothing else created for it survives (no test workers, no extra D1s).

## Boundary
`docs/cloudflare.md` (one "Demo" line with the public URL only, no account id), `bench/`-free. Everything else happens in a scratch dir OUTSIDE the repo (`/private/tmp/claude-501/.../scratchpad/cf-demo` of the implementer, or `~/tmp/cf-demo`), never inside `/Users/detoro/code/brust`.

## Tasks
1. Wait for the note `alpha.3 published` on this task (`conclave task watch`). Then `npm view @brust/core@2.0.0-alpha.3 version` and `npm view @brust/core-cf@2.0.0-alpha.3 version` must both print the version.
2. Scaffold from npm in a scratch dir: `bun create @brust/app brust-demo-pokedex --template pokedex` (if the flag differs, `bun create @brust/app --help`; the pokedex template is generated from `examples/pokedex` at prepack). `cd brust-demo-pokedex && bun install`. Confirm `bun pm ls | grep @brust/core` shows `2.0.0-alpha.3` and NO `workspace:`/file: link.
3. D1: `bunx wrangler d1 create brust-demo-pokedex-team` → paste the printed `database_id` into `wrangler.jsonc` (`d1_databases[0]`, binding `TEAM_DB`, `database_name` = the created name). Keep `migrations_dir`. Local proof first: `bun run cf:migrate:local` (or the template's equivalent) + `bun run dev:cf` → `curl -s localhost:<port>/` returns 200 with the pokedex HTML; stop it.
4. Name: set `"name": "brust-demo-pokedex"` in `wrangler.jsonc`. Remote migrations: `bunx wrangler d1 migrations apply <db name> --remote -c dist/cf/wrangler.jsonc` AFTER the first `brust build routes.tsx --target cloudflare` (the merged config lives in dist/cf). Then `bunx wrangler deploy -c dist/cf/wrangler.jsonc`.
5. Verify on the public URL: `/` 200 + `x-powered-by: brust`, a pokemon detail page 200, the team action round-trip (add a member → listed; the D1 rows survive a reload), `/_brust/cache/stats` if exposed, 404 page. Record each curl (status + the one header) in the READY note. Seed data for the roster if the migration ships empty: whatever `examples/pokedex/scripts` does for local.
6. Docs: one line in `docs/cloudflare.md` §1 ("Live demo: <url> — pokedex on Workers + D1, built from the published packages"). Commit on a lane branch from v2, docs-only.
7. READY note: URL, the exact create commands (no ids), scaffold version proof, the five curls, the deploy's `wrangler deploy` summary line (size/startup), and anything the published install got wrong (that is a FINDING for the release ledger, not something to patch in the scratch dir).

## Rules
- Only `brust-demo-pokedex` (worker) and `brust-demo-pokedex-team` (D1) are created; nothing with another name; no KV/DO for the demo.
- Account id, zone, database_id never enter Markdown or task notes; the public URL is fine.
- No benches; `wrangler login` is already done on this host — do not re-login or print tokens.
- A published-package bug (scaffold fails, build fails, import resolves wrong) → stop, `task challenge` with the exact error; do NOT work around it by linking the repo.
