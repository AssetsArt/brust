# docs-site-scaffold: `website/` — the brust docs site project on v2 (TSX pages, workspace @brust/core, no deploy yet)

**SOLO by lead Detoro 2026-10-12 (human: "อยู่ใน root project ใช้ brust ล่าสุด ยังไม่ต้องมี deploy เขียนด้วย tsx แต่ยังไม่ต้องทำ แค่ขึ้น project ก่อน"). Scaffold only — smaller than a handoff. Code lane → PR → CI → v2.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 · lane: docs-site-scaffold · tier: routine

## Decisions
- Folder `website/` at the repo root (not `docs/`, which holds markdown + design + plans), workspace member `@brust/docs-site` (private) on `@brust/core: workspace:*` = always the latest brust (dogfood, like examples/pokedex).
- Pages are TSX components, one per page; NO markdown pipeline (supersedes the md-compile design proposed earlier today).
- No deploy, no wrangler, no actions, no islands in the scaffold. Port 1340.
- Routes: `/` (landing), `/docs` (index placeholder), `*` (404, outside the layout → static document).
- CI: `cd website && bun run typecheck && bun test` in the server job after the pokedex steps; the test builds the site and asserts the three routes + every component static with no client chunk.

## Next (content lanes, NOT started)
Docs pages as TSX under `website/pages/docs/`, sidebar nav in `website/lib/nav.ts`, following the outline recorded in the lead's 2026-10-12 message (getting started, routing, rendering tiers, caching, brust.toml + CLI reference, deployment, migration from 0.1.x) plus the six existing `docs/*.md` topics.
