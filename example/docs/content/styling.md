---
title: Styling
description: app.css and Tailwind v4, CSS Modules (native routes included), and self-hosted fonts.
nav: { group: "Concepts", order: 7 }
---

Styling in brust is convention-driven: an `app.css` next to your entry is the
global stylesheet (with first-class Tailwind v4 support), and component-level
CSS — plain imports or CSS Modules — is extracted into per-route chunks. All
compiled CSS is served by the Rust side under `/_brust/css/`.

## app.css and Tailwind v4

If `<scanRoot>/app.css` exists (scanRoot defaults to your entry's directory),
brust compiles it at boot in dev and during `brust build`, serves the result
at `/_brust/css/app.css`, and injects the `<link>` into every page — React
routes get it spliced before `</head>`, and the `<BrustPage>` native document
shell includes it in its head. There is no separate CSS build step to wire up.

Tailwind v4 is CSS-first — opt in inside `app.css` itself:

```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";

@theme {
  --color-brand-500: oklch(0.65 0.2 255);
}
```

The compiler is `@tailwindcss/node` with the oxide scanner: `@source` globs
resolve relative to `app.css`, and class candidates are scanned from the files
they match. `tailwindcss` is a dependency of **your project** (the scaffold
declares it), not of brust core. An `app.css` without the Tailwind import is
also fine — it passes through as ordinary CSS.

## Component CSS and CSS Modules

Components can import their own styles, in either form:

```tsx
import './Card.css'                       // plain — global selectors
import styles from './Card.module.css'   // CSS Module — hashed local class names

export default function Card() {
  return <div className={styles.card}>…</div>
}
```

At build time brust scans the import graph, processes each CSS file
(class-name hashing for `.module.css`; Tailwind `@apply` resolves when
available), and emits one chunk per file at
`/_brust/css/components/<hash>.css`. A per-route manifest maps each route to
the chunks it needs: the import scan walks **transitively** from each route's
component sources, so importing the CSS in the component that uses it is
enough — `routes.tsx` never mentions stylesheets.

This works on **native routes** too: the Rust-rendered document head carries a
framework-owned slot that the worker fills with the route's component-CSS
`<link>` tags, so a native page gets its module styles in the initial HTML.

Typing comes in two layers: an ambient `*.module.css` declaration ships with
the framework (imports resolve as `Record<string, string>` out of the box),
and the build also emits a precise per-module `.d.ts` (one `readonly` key per
exported class) under the build output's `types/` directory — generated
artifacts, not files in your source tree.

## The /_brust/css/* URLs

| URL | Contents |
|---|---|
| `/_brust/css/app.css` | The compiled global stylesheet. |
| `/_brust/css/components/<hash>.css` | One chunk per imported component CSS file. The hash is derived from the file's relative path, so the URL is stable across content edits. |

The Rust server serves both with `Cache-Control: public, max-age=3600` in
production and `no-store` in dev (so hot reload always sees fresh CSS).
Filenames are strictly validated server-side; only `.css` files from the
build output are reachable.

## Self-hosted fonts

Fonts follow the [`public/`](/docs/project-structure) pattern: put the
`.woff2` files under `public/fonts/` (served at `/fonts/...`) and declare the
`@font-face` rules in `app.css`. This site does exactly that:

```css
@font-face {
  font-family: "Schibsted Grotesk";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/schibsted-grotesk-latin-400-normal.woff2") format("woff2");
}
```

No third-party font CDN, no render-blocking cross-origin request — the font
ships with the app and is cached under the same static-asset policy as the
rest of `public/`.

## Next

Applied walkthroughs, including the markdown pipeline this site is built on,
live in the Guides section.
