# brust docs site

The brust documentation site, built with brust itself: every doc page is a
markdown file rendered through `mdRoutes()`, the Home page is a native (no
React) landing with a WebGL grainient hero, and `brust build --ssg` exports the
whole site as static HTML.

## Commands

There is no `package.json` here (the repo root owns all deps — adding one would
create a second React copy). **Every command runs with cwd = `example/docs`**;
the content dir, island chunk ids, and the `.brust/` cache are all cwd-relative.
The root `package.json` carries the wrappers:

```bash
# from the repo root
bun run docs:dev     # dev server with hot reload → http://localhost:1340
bun run docs:build   # production build → example/docs/dist (+ dist/static via --ssg)

# equivalent raw commands (cwd = example/docs)
bun ../../runtime/cli/index.ts dev index.ts
bun ../../runtime/cli/index.ts build index.ts --out-dir dist --ssg
```

Run the production server from the build output: `bun example/docs/dist/index.js`.
The integration suite is `bun test tests/docs-site.test.ts` (repo root).

## Deploying to Cloudflare Pages

The static export is a plain directory — no functions, no adapter.

**Automated (the default):** `.github/workflows/docs-deploy.yml` builds and
deploys to the `brust-docs` Pages project on every push to `main` that touches
`example/docs/` (plus manual `workflow_dispatch` runs). It authenticates with
the org secrets `CF_AID` (account id) and `CF_AC_TOKEN` (API token scoped
Pages Read/Write) and uploads `example/docs/dist/static` via
`wrangler pages deploy` — no dashboard build configuration needed.

**Manual (dashboard-driven alternative):**

| Setting | Value |
|---|---|
| Build command | `bun install && bun run docs:build` |
| Build output directory | `example/docs/dist/static` |
| Root directory | *(repo root — the build command cd's itself)* |

**Root path only:** every generated URL (`/_brust/islands/…`, `/_brust/css/…`,
`/fonts/…`, `/search-index.json`, and all internal links) is root-absolute.
Deploy at the domain root (`docs.example.com`), not under a subpath
(`example.com/docs/` will 404 every asset).

The same directory works on any static host that serves
`<path>/index.html` for `<path>` (Pages, Netlify, `nginx try_files`).

## Authoring content

Doc pages live in `content/`. A file's path is its URL under `/docs`:
`content/introduction.md` → `/docs/introduction`, `content/index.md` → `/docs`,
`content/a/index.md` → `/docs/a`.

### Frontmatter

```yaml
---
title: Introduction                # required everywhere: <title>, sidebar, search
description: One-line summary.     # <meta name="description">
nav: { group: "Getting Started", order: 1 }
---
```

- `nav.group` buckets the sidebar; pages without a group sort first (the
  Overview entry is `nav: { order: 0 }` with no group).
- `nav.order` sorts within the group and drives the prev/next pager.
- Headings (`##`/`###`) get slug ids automatically and feed the ⌘K search
  index (`lib/search-index.ts`, regenerated at boot/build — restart dev to
  pick up heading edits).

### Embedding components

A line consisting of a self-closing capitalized tag embeds a component:

```md
<Counter start={5} label="docs" />
<Counter start={0} hydrate="visible" />
<Counter csr />
<DemoBadge label="hi" />
```

- `hydrate="load|idle|visible|interaction"` and `csr` control island
  hydration (default `load`); native
  behavior components (files with `export const behavior`) take neither and
  their props must be string/number literals.
- **Three-identity rule:** the md tag name, the key in the `components`
  registry passed to `mdRoutes()` in `routes.tsx`, and the component's default
  import ident in `routes.tsx` must all be the same name:

  ```tsx
  import Counter from './components/Counter'        // 1. import ident
  mdRoutes('content', {
    prefix: '/docs',
    layout: DocsLayout,
    components: { Counter },                        // 2. registry key
  })
  // 3. <Counter … /> in the .md file
  ```

- **Gotcha — literal tags in prose and comments:** the scanner treats ANY line
  that starts with a capitalized self-closing tag as an embed — including
  lines inside HTML `<!-- … -->` comments (only code fences shield). A literal
  example like `<Island component={Foo} />` on its own line fails the build
  with "not in mdRoutes components registry". Put example tags in a code fence
  or inline code, never on a bare (or comment-wrapped) prose line.
- Code fences shield everything: component tags, `{{ }}`/`{% %}` text, and
  headings inside fences are rendered literally and stay out of the search
  index.

## Fonts

Self-hosted woff2 in `public/fonts/` (latin subset, extracted from
`@fontsource/schibsted-grotesk` and `@fontsource/spline-sans-mono` — OFL
licensed; the packages are NOT dependencies, the files are vendored).
`@font-face` lives at the top of `app.css` with `font-display: swap`; system
stacks remain in the `--font-sans`/`--font-mono` tokens as fallback.

## Project context

- `PRODUCT.md` / `DESIGN.md` — product framing and the binding visual system.
