# Docs site: static export for Cloudflare Pages + configuration docs

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · branch: docs-site (direct merges, no PR)

## Why

The human (2026-10-13): the docs site ships as a **static build on Cloudflare Pages** (free plan), **not Workers**,
so it costs no Workers credit. Every demo must run in the browser; the Actions page becomes a client demo,
not real actions. Docs first; the v2 framework work (SAB, `run()` cors, gaps G2–G12) comes after, in one round.

## Amendment 2026-10-13 (human): no exporter now

The human: "ยังไม่ใช่ทำ static export ตอนนี้แค่เขียน docs เพื่อไว้ ตอนเพิ่ม feature SSG เข้ามาจะได้ใช้ได้เลย" — no static
export yet; write the docs so the site works as soon as brust gets SSG. So **R1, R2, R8's export test and the exporter
are withdrawn** (`scripts/export-static.ts`, `test/export.test.ts`, `bun run export` removed after merge @12c3693).
R3–R7 stand: every demo runs in the browser and no page needs a server feature, which is what makes the site
SSG-ready. SSG is a brust feature in the v2 round (gap G12); the site switches to it there, and that lane brings
its own export test (the removed one is a reference: git show 4ab7b15:website/test/export.test.ts).

## Rulings (final)

- **R1. Exporter, not a framework feature.** v2 has no SSG. `website/scripts/export-static.ts` (`bun run export`)
  runs `brust build`, starts `brust start` on a free port, fetches every route, writes `website/out/`
  (gitignored), stops the server (own PID only). The missing SSG is gap **G12** in `m1a-followups.md` F95.
- **R2. File layout = Cloudflare Pages pretty URLs without a trailing slash.** `/` → `out/index.html`,
  `/docs` → `out/docs.html`, `/docs/x/y` → `out/docs/x/y.html`, the `*` route → `out/404.html`
  (Pages answers it with status 404). Assets keep their exact URL paths (`/_brust/**`, `/public/**`); collect
  them from what the pages and their JS actually reference (follow chunk imports), not a guess.
- **R3. Route list is derived, never hand-kept:** `/`, `/docs`, every `PAGES` slug from `lib/nav.ts`, and
  `/demo/pokemon/{name}` for every Pokémon in `lib/pokemon.ts`. An unknown name is the 404 page.
- **R4. No server features at runtime.** Delete `actions.ts`, `[actions]` in `brust.toml`, `team-client.ts`'s
  fetches and the cookie loaders. The exported site must make **zero** requests to non-file paths
  (no `/_brust/action`, no data endpoints).
- **R5. Team demo (Actions + Store pages) is client-only.** Same UI, same cap of 6, same duplicate/remove rules
  and the same error wording (`TeamFull`, `UnknownPokemon`), kept in the `team` store and persisted in
  `localStorage` (every access in try/catch; a blocked storage = an in-memory team). The Actions page keeps the
  Elysia code as a documented snippet and says plainly: "on this site the demo runs in your browser; with
  `[actions]` on a brust server the same buttons call `POST /_brust/action/team`." No sentence may claim the
  page calls a server.
- **R6. Caching probe is a labelled simulation.** It models the route's real rules (`ttl_seconds: 60`,
  `tags: ['pokemon']`, `bypass: 'query(nocache)'`) in the browser and prints `x-brust-cache` values the
  real server would send, under a visible label "simulated in your browser — `brust start` sends these headers
  for real". **No millisecond timings** (they would be invented). Add one recorded real transcript as a static
  code block, captured from `brust start` by the implementer (`curl -sI` ×3), not typed by hand.
- **R7. Loaders `?pokemon=` demo runs in the browser** with the same lookup (`lib/pokemon.ts`, 27 entries),
  updating the card and the shown URL (`history.replaceState`). The loader snippet stays as the reference.
  Tier: whatever the compiler picks; assert it in the tier test like the other demos.
- **R8. Tests.** Update the existing suite for R4–R7. Add `test/export.test.ts`: run the exporter, serve `out/`
  with a tiny Bun static server that mimics Pages (`.html` resolution, `404.html` with status 404), and with
  Playwright: every exported route 200 (unknown → 404), zero failed requests, zero non-file requests, zero
  page errors in light and dark, and the four demos work (team add/cap/remove survives a reload; cache probe;
  loaders search; tier demos on the landing). Keep 400px no-overflow.
- **R9. Nothing is deployed by an agent.** The lead asks the human for the Pages project before any deploy.

## Task B — configuration docs (independent of A)

`pages/docs/Configuration.tsx`, describing v2 as it is today (2.0.0-alpha.3 / v2 head):

1. **Configure from code.** `run()` from `@brust/core`, with a copyable `server.ts`
   (`distDir`, `entry`, `config: { host, port, workers, renderSlots, ioThreads, callTimeoutMs, drainTimeoutMs,
   bootTimeoutMs }`), run with `bun server.ts` after `brust build`. Precedence: env > `run({ config })` >
   `brust.toml` > defaults (source: `packages/brust/src/config.ts`). What only `brust.toml` can set today:
   `[cors]` (read at start) and `[actions]` / `[cache]` (read by `brust build` into the manifest — no
   `brust.toml` at build means no actions and no L2 cache).
2. **Response size.** Each render slot is a 256 KiB shared buffer (`SLOT_BYTES`), per worker:
   memory = 256 KiB × render slots × workers. A loader or job response larger than its slot fails the
   request (500, `response too large`); action bodies larger than the slot cross by heap up to
   `[actions] max_response_bytes` (8 MiB default). Not configurable yet (tracked on v2).
3. Every claim cites a source line in a code comment next to it (like the existing pages); tests in
   `test/reference.test.ts` assert the new headings/anchors exist.

When the v2 round lands (heap transfer for loaders/jobs, slot-size knob, `run({ config: { cors } })`), the
same lane that ships it updates this page.
