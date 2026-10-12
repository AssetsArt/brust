# website — the brust docs site

The documentation site, built with brust itself: every page is a TSX component served by the workspace `@brust/core` (always the latest brust). No markdown pipeline, no deploy yet.

```bash
bun install                 # from the repo root
cd website && bun run dev   # brust build routes.tsx && brust start → http://127.0.0.1:1340
```

Scripts: `dev`, `build`, `start`, `test` (the build smoke test), `typecheck`.

Layout: `routes.tsx` (`/`, `/docs`, `*`), `components/Layout.tsx` (document root + site header), `pages/*.tsx` (one component per page), `public/` (static files at `/public/...`).
