# CSS

brust builds your stylesheets: global CSS and CSS Modules. Each stylesheet is bundled and minified into one content-hashed file, and the server links each page's stylesheets in its `<head>`. You write `import`s; you never write the `<link>` tags for them.

```tsx
// Layout.tsx: site-wide, because every page's chain starts with this layout
import './layout.css'

// Card.tsx: scoped class names
import styles from './Card.module.css'
export default function Card() {
  return <div className={styles.card}>…</div>
}
```

## 1. Which stylesheets a page links

A route links, in this order:

1. every file listed in `[css] global` in `brust.toml`, in the listed order;
2. every `.css` import reachable from the route's chain: the root layout first, then nested layouts, then the page, each depth-first in import order.

A file is linked once, at its first occurrence. A layout's import is therefore site-wide, and a page's import is linked only on that page. The walk follows static imports and dynamic `import()`s of your own source files (`.tsx`, `.ts`, `.jsx`, `.js`), including child components. CSS behind a dynamic `import()` is linked eagerly for the route, so a lazily loaded component is styled on first paint. It collects `.css` imports from your files and from packages (`import 'some-ui/dist/style.css'`). It does not follow the JavaScript inside `node_modules`.

```toml
[css]
global = ["styles/reset.css", "styles/theme.css"]   # for apps without a layout, or to go first
```

A `.css` import in the route entry (`routes.tsx`) belongs to no route. The build warns and links it nowhere. Import it from a layout, or list it in `[css] global`.

## 2. Output

Each source stylesheet becomes `dist/client/<name>-<hash>.css`, where the hash is 10 hex characters. It is minified, its `@import`s are inlined and its nesting is flattened. A file used by several routes is one file and one URL. The hash is in the name, so the server sends it as `immutable`. There is no `.min.` in the name. `brust build` always minifies; `brust dev` does not, so the CSS stays readable.

In `url()`:

- An absolute `/public/…` or `/_brust/…` URL stays as written.
- A relative font or image is copied to `dist/client/<name>-<hash>.<ext>` and the URL is rewritten. A small file may be inlined as a `data:` URL instead. The types served from there are `.woff2 .woff .ttf .otf .eot .png .jpg .jpeg .gif .webp .avif .svg .ico`. Any other type (a `.cur`, a video) fails the build with `css-asset-type`, because the server would answer 404 for it. Put such a file in `public/` and reference it as `/public/…`.

## 3. Where the links go

The server inserts `<link rel="stylesheet" href="/_brust/client/…" data-brust-css>` tags:

- right after the opening `<head>` tag, or right after `<meta charset>` when that is the first tag in the head;
- before every tag you wrote in the head yourself. Your own `<link>` and `<style>` tags come later, so they win the cascade.
- `<header>` is not a head. A page without a `<head>` gets the links first, after its doctype.

This happens on every page, including all-static pages that load no JavaScript. Cloudflare Workers and `--target static` use the same server code. The stylesheets are copied to Static Assets with the other client files.

## 4. CSS Modules

A `*.module.css` file is scoped. `import styles from './Card.module.css'` gives a frozen object that maps each class to a generated name, such as `{ card: "card_nBzD1A" }`. `composes:` works.

Class names are plain strings, so the same map works everywhere:

- in static and native templates;
- in a React island's server render and its hydration;
- in the Cloudflare worker.

Every JS build uses the same map. The build checks that every generated class exists in the emitted CSS.

Types ship with `@brust/core`: `import styles from './x.module.css'` types as `{ readonly [name: string]: string }`, and a side-effect `import './x.css'` typechecks.

For now, `styles.card` in a static or native template is computed by a precompute job, so it works but costs a worker call. Folding it into the template at compile time is the follow-up lane L20.

## 5. What does not change

- A `<link>` you write to a file in `public/` is untouched. It is served as before, without a content hash.
- No JS bundle contains CSS. A `.css` import in JavaScript is an empty module, and a `.module.css` import is its class map.

## 6. Tailwind CSS v4

Tailwind is built in through the official `bun-plugin-tailwind`. Install it and Tailwind as your app's own dev dependencies (`bun create @brust/app my-app --tailwind` does this):

```sh
bun add -d tailwindcss@4 bun-plugin-tailwind
```

```css
/* app.css, imported by the root layout */
@import "tailwindcss";

@theme {
  --color-brand: oklch(0.55 0.2 260);
}
```

```tsx
// Layout.tsx
import './app.css'
// …
<h1 className="text-brand font-bold md:text-4xl">…</h1>
```

- **When it loads.** brust loads Tailwind only when a stylesheet, or a file it `@import`s, contains `@import "tailwindcss"`, `@apply`, `@reference`, `@theme` or `@plugin`. If the packages are missing, the build fails with `tailwind-missing` and prints the `bun add -d` command above.
- **What it scans.** Tailwind scans the app root for class names. Utilities you use in `.tsx` files end up in the stylesheet, minified like every other.
- **One import.** Import `tailwindcss` once, in the stylesheet your root layout imports. The build warns if more than one file has `@import "tailwindcss"`, because each one ships the whole of Tailwind.
- **`@apply` in a CSS Module.** The module must reference your Tailwind entry itself. This is standard in v4, and brust does not add it for you:

  ```css
  /* Card.module.css */
  @reference "../app.css";
  .card { @apply p-4 text-brand; }
  ```

- **Cascade.** Tailwind v4 puts its utilities in `@layer`. Unlayered CSS, such as your CSS Modules and plain stylesheets, beats a utility whatever the file order. To let a utility override a module class, put that module rule in a layer too: `@layer components { … }`.
- **`brust dev`.** Editing a stylesheet rebuilds the CSS, and the page swaps its `data-brust-css` links without reloading. Editing a `.tsx` file rebuilds and reloads the page, and Tailwind rescans for classes.
