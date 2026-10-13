# website — the brust docs site

The documentation site, built with brust itself: every page is a TSX component served by the workspace `@brust/core` (always the latest brust). No markdown pipeline, no deploy yet.

```bash
bun install                 # from the repo root
cd website && bun run dev   # brust build routes.tsx && brust start → http://127.0.0.1:1340
```

Scripts: `dev`, `build`, `start`, `test` (the build smoke test), `typecheck`.

Layout: `routes.tsx` (`/`, `/docs`, `*`), `components/Layout.tsx` (document root + site header), `pages/*.tsx` (one component per page), `public/` (static files at `/public/...`).

Production: `bun run deploy` builds the static output (`brust build --target static`) and uploads `dist/static` to the Cloudflare Pages project behind https://brust.dev (the `*.pages.dev` address is closed by an Access policy; only the custom domain is public). The 0.1.x docs stay on their own project and domain.

## How the site is styled

Tailwind CSS v4, CSS-first (no `tailwind.config`): `app.css` is the site's one stylesheet, compiled by brust's CSS pipeline (`[css] global` in `brust.toml`) into one hashed file. Pages and components carry their look as utilities in markup; `app.css` holds only what utilities cannot say.

What is in `app.css`, top to bottom:

- `@import "tailwindcss"`.
- **Tokens.** The palette, fonts and easing are plain CSS variables on `:root` (`--paper`, `--ink`, `--amber`, `--term`, `--sy-kw`, `--ty-fire`, `--pz-sky0`, ...), redefined for dark under `prefers-color-scheme: dark` and for `[data-theme]`. A `@theme inline` block maps each one to a theme variable of the same name (`--color-paper: var(--paper)`, `--font-mono: var(--mono)`, `--ease-mirai: var(--ease)`), so `bg-paper text-ink border-rule font-mono` switch with light/dark through the variables and need no `dark:` variant.
- **Breakpoints.** The site is desktop-first and has two: `max-narrow:` (560 px and below) and `max-wide:` (980 px and below). They are defined half a pixel past those widths (`--breakpoint-narrow: 35.03125rem`, `--breakpoint-wide: 61.28125rem`) so they stay inclusive whichever way the compiler writes `max-*` (`max-width: calc(X - .001px)` today, `width < X` in later Tailwind). Use only these two, never `sm:`/`md:`/...
- **Motion.** Animations are `--animate-mirai-<name>` tokens (prefixed so they never shadow one of Tailwind's built-in animations), always used as `motion-safe:animate-mirai-<name>`; hover lifts and transitions are `motion-safe:` too, so reduced motion shows the final state with nothing moving. The `@keyframes` sit unlayered at the end of the file, and each one is named by a token.
- **Runtime CSS variables.** Components that set variables from code (`--rail`, `--ink-x`, `--ink-s`, per-element delays `--d` / `--n` / `--i` through `style={{ '--d': '.3s' }}`) keep doing so; utilities read them with arbitrary values such as `[transform:scaleY(var(--rail,0))]`.
- `@layer base`: Preflight undone rule by rule with `revert` (the site was written against the browser defaults), then the paper ground on `body` and the defaults of the bare elements the pages write as prose (headings, paragraphs, links, inline code), the code panes' WebKit scrollbars and smooth anchor scrolling.
- `@layer components`: the exceptions, each with a comment saying why a utility cannot express it: the spans `lib/highlight.ts` emits into highlighted code, and the docs body (the bare elements inside DocsLayout's `.doc` article).

### Authoring rules

1. **Longhands, not arbitrary shorthands.** Tailwind emits arbitrary properties such as `[font:inherit]` or `[transition:...]` after all named utilities, so a shorthand silently resets its neighbours (`[font:inherit]` undoes `font-mono` and `text-[13px]`). Write the longhands: `[font-weight:inherit] [line-height:inherit]`, `[transition-property:...] [transition-duration:...]`.
2. **Arbitrary `text-[..]` sizes when the line height must not move.** `text-xs` / `text-sm` / `text-base` also set a line height; `text-[13.5px]` sets only the size.
3. **No reliance on `.doc` descendant rules.** A component encodes its own look in its utilities; the `.doc` rules exist only for the bare prose elements of the pages, and a component placed inside a docs page must look the same outside it.
4. **`@theme inline` for tokens that read per-element variables.** A token in a plain `@theme` block is resolved once at `:root`, so the typing animation's token, whose value is `type calc(var(--n) * 22ms) ...`, would read `--n` there (unset: animation `none`, every delay `0s`). Tokens whose value reads a variable set on the element must live in `@theme inline`, which copies the value into each utility.
5. **Utility names in prose are utilities.** Tailwind scans every source file, comments and tests included, and emits a utility for any word that names one (a page that says `static` gets `.static`). Never give a site class a utility's name, and keep built-in names such as Tailwind's own animation utilities out of comments: one brought its own `@keyframes pulse` that replaced the site's (hence `mirai-pulse`; `test/static.test.ts` fails on a duplicated `@keyframes`). This README is kept out of the scan (`@source not` in `app.css`), since it quotes utilities as examples.

### Visual parity

`scripts/shots.ts` screenshots every nav route, `/docs` and the 404, light and dark at 400 and 1280 px, plus light at both sides of each breakpoint (560/561, 980/981 px), full page with animations off; `compare` diffs two such runs (pixelmatch, threshold 0.1) and prints the share of differing pixels per shot.

```bash
cd website
bun scripts/shots.ts capture /tmp/shots-before            # builds the site and starts brust itself
# ...change the CSS or markup...
bun scripts/shots.ts capture /tmp/shots-after
bun scripts/shots.ts compare /tmp/shots-before /tmp/shots-after --diff /tmp/shots-diff
```

A styling change that is not meant to change the look should compare at 0 differing pixels; `--widths 560,561,980,981` shoots only the views of those widths.
