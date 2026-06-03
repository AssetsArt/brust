# PokéDex — brust example

A small public web app (landing → browse → detail → type chart) built with **brust**, styled with
**Tailwind v4**. Every route is `native: true` — JSX is compiled to minijinja at build time and rendered
in Rust; the only client JS is the islands and native directive components.

## Run

```bash
# from the repo root
bun run runtime/cli/index.ts build example/pokedex/index.ts   # native compile + css + chunks
bun run runtime/cli/index.ts dev   example/pokedex/index.ts   # dev server (build first)
```

## What it shows (framework capabilities → where)

| Capability | Where |
|---|---|
| **Native SSR routes** (Rust-rendered, no per-request React) | every page (`pages/*`, `routes.tsx`) |
| **Loaders** (view-model precompute, request cache) | `lib/loaders.ts` |
| **Cookies + request-context** | dark/light theme — `mode` cookie read in every loader, set by `/theme` |
| **`defineStore`** (cross-island shared state) | the team — `stores/team.ts`, shared by TeamBuilder + AddToTeamButton |
| **Client navigation** | `NavLink` active state, `NavPreloader` progress bar (`useNav`), hero search `navigate()` |
| **React islands** | `TeamBuilder` (team dock), `AddToTeamButton`, `NavPreloader` |
| **Native directive components** (react-free `x-*`) | `ThemeToggle`, `NavLink`, `HeroSearch`, `DexFilter` |
| **Keyed `x-for`** (DOM-preserving list reconcile) | `DexFilter` — instant client filter/sort on Browse |
| **Nested `<Outlet/>` layout** | `AppLayout` owns the shell; pages render into the slot |
| **Treaty actions** (typed client→server) | `/theme`, team add/remove (`actions.ts`, `brustjs/client`) |

## Native authoring note

Native page templates only interpolate member-paths, `.map()` (incl. nested), inline conditionals, and
`style={{…}}` objects — so the **loaders** precompute every formatted string, className, href, inline
color, and island/directive `x-props` JSON. Tailwind utility classes are static literals (the scanner
sees them via `@source`); data-derived colors (type tints, stat bars) use inline `style` from a loader
value, since the scanner can't see runtime-built class strings. Dark mode is the `mode` cookie driving
`<html data-mode>` + a Tailwind `@custom-variant dark` keyed to `[data-mode="dark"]`.
