# Pokédex (brust v2, M2 dogfood)

Five routes served by `brust build && brust start` from a committed offline dataset
(`data/pokedex.json`, 151 Pokémon + 18 type relations). Every component is an ordinary React
function with hooks; `TeamBuilder` is the one react-tier child (SSR + idle hydration).

## Run

```bash
bun install            # from the repo root
cd examples/pokedex
bun run build          # brust build routes.tsx → dist/
bun run start          # brust start → http://127.0.0.1:1337
```

## Regenerating the generated files (never hand-edit)

- Dataset (needs network, run by hand): `bun run snapshot` → `data/pokedex.json`.
- Stylesheet (Tailwind CLI v4, run once, output committed):
  `bunx @tailwindcss/cli@4 -i styles/app.css -o public/app.css --minify`
  (Tailwind must resolve from the input's directory; the header comment of `public/app.css`
  records the command. `@source` scans `**/*.{tsx,ts}`.)

## Layout

- `routes.tsx` — `defineRoutes`: `/`, `/pokedex`, `/pokemon/{name}` (L1 60 s, `?nocache` bypass),
  `/type-chart` (L1 1 h), and a root-level `*` static full-document 404 outside the layout.
- `lib/` — loaders over the snapshot, `format.ts` (module helpers → build jobs), `filter.ts`.
- `components/`, `pages/` — plain React functions.
