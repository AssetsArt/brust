# Bench pages — the markup contract

Every app serves these three pages. `lib/parity.ts` compares the TAG SEQUENCE and the TEXT of `<main>` after
normalization (scripts/links/styles/comments dropped, island wrappers unwrapped, attributes ignored, whitespace
collapsed, entities decoded). Attributes, class names and the document shell outside `<main>` are free per
framework; everything inside `<main>` below is not. Data: `data.json` (`types[18]`, `pokemon[151]`).

## S — `/types`
<main>
  <h1>Types</h1>
  <ul>
    <li><span data-type="{t.name}" style="background:{t.tint}">{t.label}</span></li>   ← ×18, data.types order
  </ul>
</main>

## D — `/dex` (brust: `?nocache=1` bypasses L1; others ignore the query)
<main>
  <h1>Pokédex</h1>
  <p>151 Pokémon</p>
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
    <tbody>
      <tr><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map(TypeBadge)}</td></tr>   ← ×151, dex order;
    </tbody>                                                                                   TypeBadge = the S span
  </table>
</main>

## I — `/team` (same query rule as D)
<main>
  <h1>Team</h1>
  <p>Pick up to 6.</p>
  <div data-testid="counter"><button type="button">clicks: {n}</button></div>   ← Counter island, n starts at 0
</main>

Counter is the ONE interactive component: `useReducer`, `'use client'` in Next, react tier in brust, an
`<Island ssr hydrate="load">` in 0.1.x, plain `renderToString` in bun-serve (no hydration — it is the ceiling).
Text nodes: React emits `clicks<!-- -->: <!-- -->0`; the normalizer strips comments, so every app yields
"clicks: 0".

## A1 / A2 — JSON contract (`actions-app.ts`, no HTML)
- A1 `GET /_brust/action/types` → 200 `application/json`, the 18 `data.types` rows of `data.json`, in order, as
  `[{ "name": "normal", "label": "Normal", "tint": "#9099a1" }, …]`.
- A2 `POST /_brust/action/team` with `content-type: application/json` and `{"id":25}` → 200 `application/json`
  `{ "ok": true, "id": 25 }`. A non-number `id` is a 422 (not benchmarked).
Parity: parsed JSON deep-equal across apps and equal to the expected value (key order and whitespace are free).
