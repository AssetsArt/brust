# Pokédex (brust v2, M2 dogfood)

Six routes served by `brust build && brust start` from a committed offline dataset
(`data/pokedex.json`, 151 Pokémon + 18 type relations). Every component is an ordinary React
function with hooks; `TeamBuilder` and `UnifiedIsland` are the react-tier children (SSR + idle hydration).

The team is real: it lives in `bun:sqlite`, is changed through Elysia actions (`actions.ts`, enabled by
`[actions]` in `brust.toml`) and is shown by one unified store (`stores/team.ts`) on three surfaces:
the native `AddToTeamButton`, the `TeamBuilder` island and the layout's first paint. `/unified` shows the
same idea with a counter (`?start=5` seeds it on the server).

## Run

```bash
bun install            # from the repo root
cd examples/pokedex
bun run build          # brust build routes.tsx → dist/
bun run start          # brust start → http://127.0.0.1:1337
```

The team is stored in `data/team.sqlite` (created on first use, gitignored; delete it to reset).
Set `POKEDEX_TEAM_DB=/path/to/team.sqlite` to put it elsewhere (the tests do). A fresh database is empty.
The actions are served under `/_brust/action` (`GET /team`, `POST /team {id}`, `DELETE /team/:id`);
the team holds at most 6 members and a seventh add answers `409` (`TeamFull`).

## Cloudflare Workers (preview)

The same app runs on Cloudflare Workers with a D1 database:

```bash
bun run cf:migrate:local   # create the local D1 table (state in .wrangler/state)
bun run dev:cf             # brust build --target cloudflare + wrangler dev (rebuilds on change)
```

- The `*:cf` scripts need a `wrangler` on `PATH` (or `BRUST_WRANGLER`): the example does not install one, to keep the
  monorepo lockfile free of workerd. A scaffold from `bun create @brust/app --template pokedex` has it as a devDependency.
- `brust.toml` `[cloudflare.alias]` swaps `lib/team-db.ts` for `lib/team-db.d1.ts`; bindings live in `wrangler.jsonc`.
- To deploy: `wrangler d1 create pokedex-team`, paste the `database_id` into this app-root `wrangler.jsonc` (`dist/cf/` is
  regenerated on every build), `bun run cf:migrate:remote`, then `bun run deploy:cf`.
- Preview: a team change refreshes cached team pages only in the isolate that served the action; other isolates catch up
  within the route `ttl` (60 s for `/pokemon/*`, 1 h for `/type-chart`) until the cross-isolate invalidation lands.
- Tests: `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf/pokedex-d1.test.ts tests/cf/team-db-d1.test.ts` (local workerd).

## Regenerating the generated files (never hand-edit)

- Dataset (needs network, run by hand): `bun run snapshot` → `data/pokedex.json`.
- Stylesheet (Tailwind CLI v4, run once, output committed):
  `bunx @tailwindcss/cli@4 -i styles/app.css -o public/app.css --minify`
  (Tailwind must resolve from the input's directory; the header comment of `public/app.css`
  records the command. `@source` scans `**/*.{tsx,ts}`.)

## Layout

- `routes.tsx` — `defineRoutes`: `/`, `/pokedex`, `/pokemon/{name}` (L1 60 s, `?nocache` bypass),
  `/type-chart` (L1 1 h), `/unified` (the store demo; both cached routes carry the `team` tag), and a root-level `*` static full-document 404 outside the layout.
- `lib/` — loaders over the snapshot, `format.ts` (module helpers → build jobs), `filter.ts`;
  `team.ts` (`MAX_TEAM`), `team-db.ts` (the team interface: sqlite natively via `team-db.sqlite.ts`, D1 on Cloudflare via `team-db.d1.ts` and `[cloudflare.alias]`; server-only), `api.ts` + `team-client.ts` (the typed actions client).
- `actions.ts` — the Elysia 2 team app on `brust()`; `stores/` — `team` and `unified` (`defineStore`).
- `components/`, `pages/` — plain React functions.
