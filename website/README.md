# website — the brust docs site

The documentation site, built with brust itself: every page is a TSX component served by the workspace `@brust/core` (always the latest brust). No markdown pipeline, no deploy yet.

```bash
bun install                 # from the repo root
cd website && bun run dev   # brust build routes.tsx && brust start → http://127.0.0.1:1340
```

Scripts: `dev`, `build`, `start`, `test` (the build smoke test), `typecheck`.

Layout: `routes.tsx` (`/`, `/docs`, `*`), `components/Layout.tsx` (document root + site header), `pages/*.tsx` (one component per page), `public/` (static files at `/public/...`).

Production: `bun run deploy` builds the static output (`brust build --target static`) and uploads `dist/static` to the Cloudflare Pages project behind https://brust.dev (the `*.pages.dev` address is closed by an Access policy; only the custom domain is public). The 0.1.x docs stay on their own project and domain.
