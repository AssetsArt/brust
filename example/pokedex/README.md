# pokedex — Brust example (native-first dogfood)

A PokéDex built to **dogfood brust by pushing `native: true` as far as it goes** —
all three routes are native (compiled JSX → minijinja, rendered in Rust, zero
React on the server for the page shell). Data comes from the free, keyless
[PokeAPI](https://pokeapi.co/api/v2), fetched in loaders — boots zero-config.

The headline deliverable is **[`FRAMEWORK-GAPS.md`](./FRAMEWORK-GAPS.md)** — what
native (and brust) couldn't do, found empirically while building and running this.

## Run

Native routes are compiled by `brust build` (a plain `bun run` does **not** compile
them — see GAPS), so build first, then run:

```bash
cd <repo root>
bun install                                   # one-time
cd runtime && bun run build && cd ..           # one-time: build the native module
bun run runtime/cli/index.ts build example/pokedex/index.ts   # compile native routes → .brust/jinja
BRUST_PORT=3100 bun run example/pokedex/index.ts              # serve
```

Open http://127.0.0.1:3100/. Re-run the `build` step after editing any `pages/*`,
`components/*`, or `app.css`.

## Routes

| Path | Mode | Demonstrates |
|---|---|---|
| `GET /` | `native` | list loader · `?offset=` pagination (zod-validated by hand) · `.map()` grid · floating team island |
| `GET /pokemon/{name}` | `native` | dynamic param · evolution chain (loaded in the loader — native can't `<Suspense>`-stream) · type-tinted hero · 2 islands |
| `GET /type-chart` | `native` | static 18×18 effectiveness matrix flattened to one `.map()` into a CSS grid |

Actions (treaty): `GET/POST /team`, `DELETE /team/{id}` — an in-process team store.

## Layout

```
pokedex/
├─ index.ts            # boot — brust.run({ routes, entry, actions })
├─ routes.tsx          # 3 native routes
├─ actions.ts          # team-store RPC (treaty)
├─ app.css             # AssetsArt design system (tokens + components) + .dex-* layer
├─ lib/
│  ├─ pokeapi.ts       # PokeAPI fetch wrappers + helpers
│  ├─ team-store.ts    # in-process Map (global, no session — see GAPS S6)
│  ├─ types.ts         # view-model types
│  └─ loaders.ts       # THE view layer — precomputes every class/style/label
│                      #   because native templates only interpolate member paths
├─ pages/              # native route components — near-pure HTML + .map()
│  ├─ ListPage.tsx · DetailPage.tsx · TypeChart.tsx
├─ stores/             # isomorphic shared state (brustjs/store) — cross-island team
│  └─ team.ts           #   defineStore: one window singleton, synced across islands (S4)
└─ components/         # ISLANDS (real React, run in the browser)
   ├─ AddToTeamButton.tsx · TeamBuilder.tsx
```

## The one rule that shaped everything

Native route templates can interpolate **only member paths + `.map()`** — no
`style={{…}}`, no conditionals, no helper calls, no string building. So
`lib/loaders.ts` is the real view layer: it precomputes every formatted string,
CSS class, and inline-style string, and the `pages/*.tsx` are almost pure HTML.
The full reasoning + every gap is in [`FRAMEWORK-GAPS.md`](./FRAMEWORK-GAPS.md).
