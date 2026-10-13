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
