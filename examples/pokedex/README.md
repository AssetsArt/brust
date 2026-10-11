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
  `team.ts` (`MAX_TEAM`), `team-db.ts` (sqlite, server-only), `api.ts` + `team-client.ts` (the typed actions client).
- `actions.ts` — the Elysia 2 team app on `brust()`; `stores/` — `team` and `unified` (`defineStore`).
- `components/`, `pages/` — plain React functions.
