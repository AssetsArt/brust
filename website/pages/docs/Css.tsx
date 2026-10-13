// CSS — global stylesheets linked into <head> for you, CSS Modules (and how `styles.x` folds at compile time), Tailwind CSS v4 built in, the dev swap; one browser-only demo of the fold.
// Every factual claim below has a `source:` comment next to it (file:line at this repo's v2 / docs-site as of the gaps round; the CSS Module fold (L20) is cited at v2 @34232c7, PR #177).
import CodeBlock from '../../components/CodeBlock'
import ClassFold from '../../components/demos/ClassFold'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface CssData {
  toc: TocItem[]
  blocks: Record<'imports' | 'global' | 'urls' | 'head' | 'mod' | 'modSrc' | 'compiled' | 'install' | 'entry' | 'layout' | 'apply' | 'layer', CodeBlockData>
}

const IMPORTS = `// Layout.tsx: site-wide, because every page's chain starts with this layout
import './layout.css'

// Home.tsx: linked on this page only
import './home.css'`

const GLOBAL = `[css]
global = ["styles/reset.css", "styles/theme.css"]   # for apps without a layout, or to go first`

const URLS = `.hero {
  background: url("/public/hero.jpg");      /* stays as written */
  font-family: Inter;
}
@font-face {
  font-family: Inter;
  src: url("./fonts/inter.woff2");           /* copied to dist/client/inter-<hash>.woff2, URL rewritten */
}`

const HEAD = `<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/_brust/client/layout-3f9c1a07b2.css" data-brust-css>
  <link rel="stylesheet" href="/_brust/client/home-91c4d2e8aa.css" data-brust-css>
  <title>Home</title>
  <link rel="stylesheet" href="/public/mine.css">   <!-- yours: later, so it wins -->
</head>`

const MOD = `// Card.tsx
import styles from './Card.module.css'

export default function Card() {
  return <p className={styles.card}>hello</p>
}`

const MOD_SRC = `/* Card.module.css */
.card { color: oklch(0.5 0.15 260); }
.title { font-weight: 700; }`

// observed: the css-module-fold fixture built on 2.0.0-alpha.3 + L20 (packages/brust/test/fixtures/css-fold): the template of a static page, class names are the bundler's.
const COMPILED = `<p{% if "card_nBzD1A" | present %} class="{{ "card_nBzD1A" | attr_str | e }}"{% endif %}>hello</p>`

const INSTALL = `bun add -d --exact tailwindcss@4.3.3 @tailwindcss/node@4.3.3 @tailwindcss/oxide@4.3.3
# the blank starter already has all three:
bun create @brust/app my-app`

const ENTRY = `/* app.css, imported by the root layout */
@import "tailwindcss";

@theme {
  --color-brand: oklch(0.55 0.2 260);
}`

const LAYOUT = `// Layout.tsx
import './app.css'
// …
<h1 className="text-brand font-bold md:text-4xl">…</h1>`

const APPLY = `/* Card.module.css */
@reference "../app.css";
.card { @apply p-4 text-brand; }`

const LAYER = `@layer components {
  .card { padding: 1rem; }   /* now a utility class can override it */
}`

export async function cssLoader(): Promise<CssData> {
  return {
    toc: [
      { id: 'global', title: 'Global stylesheets' },
      { id: 'order', title: 'Which, and in what order' },
      { id: 'output', title: 'The built files' },
      { id: 'head', title: 'Where the links go' },
      { id: 'modules', title: 'CSS Modules' },
      { id: 'fold', title: 'Class names fold at compile time' },
      { id: 'tailwind', title: 'Tailwind CSS v4' },
      { id: 'dev', title: 'In brust dev' },
      { id: 'same', title: 'What does not change' },
    ],
    blocks: {
      imports: codeBlock({ lang: 'tsx', file: 'Layout.tsx', code: IMPORTS }),
      global: codeBlock({ lang: 'toml', file: 'brust.toml', code: GLOBAL }),
      urls: codeBlock({ lang: 'text', file: 'layout.css', code: URLS }),
      head: codeBlock({ lang: 'text', file: 'the rendered <head>', code: HEAD }),
      mod: codeBlock({ lang: 'tsx', file: 'Card.tsx', code: MOD }),
      modSrc: codeBlock({ lang: 'text', file: 'Card.module.css', code: MOD_SRC }),
      compiled: codeBlock({ lang: 'text', file: 'dist/jinja/card.jinja', code: COMPILED }),
      install: codeBlock({ lang: 'sh', cwd: '~/my-app', code: INSTALL }),
      entry: codeBlock({ lang: 'text', file: 'app.css', code: ENTRY }),
      layout: codeBlock({ lang: 'tsx', file: 'Layout.tsx', code: LAYOUT }),
      apply: codeBlock({ lang: 'text', file: 'Card.module.css', code: APPLY }),
      layer: codeBlock({ lang: 'text', file: 'Card.module.css', code: LAYER }),
    },
  }
}

export default function Css({ blocks }: CssData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>CSS</h1>
      <Lead>You import stylesheets; brust bundles and minifies them, names them by content, and links each page's stylesheets in its head. You never write those link tags.</Lead>

      <h2 id="global">Global stylesheets</h2>
      {/* source: docs/css.md:1-3 (what the build does) and :18-21 (the two sources of a route's stylesheets); packages/brust/src/build/css.ts:78-88 (routeCssSources: globals first, then each chain file's CSS) */}
      <p>
        A plain <code>import './layout.css'</code> in a component is enough. The build collects every <code>.css</code> import reachable from a page and the server links them.
      </p>
      <CodeBlock code={blocks.imports.code} lang={blocks.imports.lang} file={blocks.imports.file} html={blocks.imports.html} />

      <h2 id="order">Which, and in what order</h2>
      {/* source: docs/css.md:20-21 (order: [css] global, then root layout, nested layouts, page, depth-first) and :23 (linked once, first occurrence; layout import is site-wide); css.ts:82-86 (the loop that builds the list) */}
      <p>A page links, in this order:</p>
      <ol>
        <li>
          every file in <code>[css] global</code> of <code>brust.toml</code>, in the listed order;
        </li>
        <li>every CSS import reachable from the page's chain: the root layout first, then nested layouts, then the page, each depth-first in import order.</li>
      </ol>
      <p>A file is linked once, at its first occurrence. So a layout's import is site-wide, and a page's import is linked on that page only.</p>
      <CodeBlock code={blocks.global.code} lang={blocks.global.lang} file={blocks.global.file} html={blocks.global.html} />
      {/* source: docs/css.md:23 and :30 (static and dynamic imports of your own source files, including child components; CSS behind import() is linked eagerly; package CSS is collected; JavaScript inside node_modules is not followed); css.ts:31-34 (CssGraph: a .css import is collected, never followed); css.ts:60 (the lazy case) */}
      <p>
        The walk follows static imports and dynamic <code>import()</code> of your own source files, including child components, so a lazily loaded component is styled on first paint. It also collects CSS imported from packages, for example{' '}
        <code>import 'some-ui/dist/style.css'</code>. It does not read the JavaScript inside <code>node_modules</code>.
      </p>
      {/* source: docs/css.md:30 (a CSS import in routes.tsx belongs to no route: the build warns and links it nowhere); packages/brust/test/css.test.ts:235-243 (the warning is asserted) */}
      <Note>
        A CSS import in <code>routes.tsx</code> itself belongs to no route: the build warns and links it nowhere. Import it from a layout, or list it in <code>[css] global</code>.
      </Note>

      <h2 id="output">The built files</h2>
      {/* source: docs/css.md:34 (one file per source, dist/client/<name>-<hash>.css with 10 hex characters; minified, @import inlined, nesting flattened; one URL for a file shared by routes; immutable; no .min.; build always minifies, dev does not) */}
      <p>
        Each stylesheet becomes <code>dist/client/&lt;name&gt;-&lt;hash&gt;.css</code> with a 10-character content hash. It is minified, its <code>@import</code>s are inlined and its nesting is flattened. A file shared by several pages is one file at one URL.
        The hash is in the name, so the server sends the file as <code>immutable</code>; there is no <code>.min.</code> in the name. <code>brust build</code> always minifies, and <code>brust dev</code> does not, so the CSS stays readable while you work.
      </p>
      {/* source: docs/css.md:36-39 (url(): absolute /public/ and /_brust/ stay; a relative font or image is copied with a hash and the URL rewritten; the served types; any other type fails with css-asset-type); css.ts:110 (SERVED_ASSET_EXT) */}
      <p>
        A relative <code>url()</code> to a font or image is copied next to the stylesheet with a hash in its name and the URL is rewritten. An absolute <code>/public/…</code> or <code>/_brust/…</code> URL is left as written.
      </p>
      <CodeBlock code={blocks.urls.code} lang={blocks.urls.lang} file={blocks.urls.file} html={blocks.urls.html} />
      <p>
        The types served from there are woff2, woff, ttf, otf, eot, png, jpg, jpeg, gif, webp, avif, svg and ico. Any other type, a cursor file or a video, fails the build with <code>css-asset-type</code> because the server would answer 404 for it. Put that file in{' '}
        <code>public/</code> and reference it as <code>/public/…</code>.
      </p>

      <h2 id="head">Where the links go</h2>
      {/* source: docs/css.md:43-47 (the link tags, right after <head> or after a leading <meta charset>, before the author's own tags, <header> is not a head, no head: first after the doctype) and :49 (every page, including all-static pages with no JavaScript; Workers and --target static use the same code); crates/brust-core/src/render.rs:349-353 (inject_css_into) */}
      <p>
        The server inserts one <code>&lt;link rel="stylesheet" data-brust-css&gt;</code> per stylesheet right after the opening <code>&lt;head&gt;</code>, or right after a <code>&lt;meta charset&gt;</code> that comes first. Everything you wrote in the head follows, so
        your own <code>&lt;link&gt;</code> and <code>&lt;style&gt;</code> tags come later and win the cascade.
      </p>
      <CodeBlock code={blocks.head.code} lang={blocks.head.lang} file={blocks.head.file} html={blocks.head.html} />
      <p>
        This happens on every page, including all-static pages that load no JavaScript. A page with no <code>&lt;head&gt;</code> gets the links first, after its doctype; <code>&lt;header&gt;</code> is not a head. Cloudflare Workers and <code>--target static</code> use the same
        server code.
      </p>

      <h2 id="modules">CSS Modules</h2>
      {/* source: docs/css.md:53 (a *.module.css is scoped: the import is a frozen object mapping each class to a generated name; composes works) and :55-61 (class names are plain strings: static and native templates, a React island's server render and hydration, the Cloudflare worker; one map for every JS build; the build checks every generated class is in the emitted CSS); :63 (types ship with @brust/core) */}
      <p>
        A file named <code>*.module.css</code> is scoped. <code>import styles from './Card.module.css'</code> gives a frozen object that maps each class to a generated name, such as <code>card_nBzD1A</code>. <code>composes:</code> works.
      </p>
      <CodeBlock code={blocks.mod.code} lang={blocks.mod.lang} file={blocks.mod.file} html={blocks.mod.html} />
      <CodeBlock code={blocks.modSrc.code} lang={blocks.modSrc.lang} file={blocks.modSrc.file} html={blocks.modSrc.html} />
      <p>
        Class names are plain strings, so the same map works in static and native templates, in a React island's server render and its hydration, and in the Cloudflare worker. Types ship with <code>@brust/core</code>: the import is typed as an object of strings.
      </p>

      <h2 id="fold">Class names fold at compile time</h2>
      {/* source: docs/css.md:65 (v2 @34232c7 (PR #177)): styles.x and styles['x'] in a static or native template fold into the literal class, so the component keeps needs_worker false and no job; an unknown class is a build error with file, line and column (rule css-module-class); only a property read of a default import of a relative *.module.css folds */}
      <p>
        In a static or native template, <code>styles.card</code> and <code>styles['card']</code> are replaced by the literal class string when the page is compiled. The component keeps <code>needs_worker: false</code> and the build plans no job for it, so the worker is
        not called for a string the build already knew.
      </p>
      <CodeBlock code={blocks.compiled.code} lang={blocks.compiled.lang} file={blocks.compiled.file} html={blocks.compiled.html} />
      {/* source: crates/brust-compiler/tests/css_module_fold.rs:34 (a known class folds and leaves no job) and :85 (bracket access, a conditional and a template literal fold) — v2 @34232c7 (PR #177); observed: the same conditional on a native page keeps both arms as literals, the template literal becomes a concatenation of literals (packages/brust/test/css-module-fold.test.ts) */}
      <p>
        It folds inside a conditional (<code>on ? styles.on : styles.off</code>) and inside a template literal too. A native component keeps its interactivity: the client chunk gets the literals as well.
      </p>
      {/* source: crates/brust-compiler/src/analyze/passes/placement.rs:513 (rule css-module-class, v2 @34232c7 (PR #177)) and tests css_module_fold.rs:65 (an unknown class is an error at its location) */}
      <p>
        A class the module does not define is a build error with the file, line and column of the use, rule <code>css-module-class</code>. The build never guesses.
      </p>
      {/* source: docs/css.md:65 — passing the whole styles object to a function, Object.keys(styles) and similar uses keep reading the map at run time; crates/brust-compiler/tests/css_module_fold.rs:100 (only a default import of a relative module folds); placement.rs:484 (the exception to the imported-object rule: the map is frozen) */}
      <Note tag="Limit">
        Only a property read of a default import of a relative <code>*.module.css</code> folds. <code>Object.keys(styles)</code>, or passing <code>styles</code> to a function, still reads the map at run time. Imported objects do not fold in general; this is the one exception, because the map is frozen.
      </Note>

      <h3 id="try">Try it</h3>
      <p>Type an expression a template could use with the module above. The demo answers the way the build does.</p>
      <Frame title="Live demo" label="ClassFold · native">
          <ClassFold initialExpr="styles.card" initialOut='class="card_nBzD1A"' initialStatus="folds: a literal in the template, no job" />
        
      </Frame>

      <h2 id="tailwind">Tailwind CSS v4</h2>
      {/* source: docs/css.md:74 (L32: brust compiles with @tailwindcss/node and scans with @tailwindcss/oxide, from the app; install the three at one version); packages/create-app/src/tailwind.ts:8 (the blank template ships the three, pinned; --tailwind does nothing) */}
      <p>
        Tailwind is built in: brust compiles with the Tailwind packages installed in your app, so the build uses exactly the <code>tailwindcss</code> version you pinned. Install <code>tailwindcss</code>, <code>@tailwindcss/node</code> and{' '}
        <code>@tailwindcss/oxide</code> as your app's own dev dependencies, at one version. The blank starter already ships all three and an <code>app.css</code> to start from, see{' '}
        <a href="/docs/project-structure">Project structure</a>.
      </p>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} file={blocks.install.file} html={blocks.install.html} />
      <CodeBlock code={blocks.entry.code} lang={blocks.entry.lang} file={blocks.entry.file} html={blocks.entry.html} />
      <CodeBlock code={blocks.layout.code} lang={blocks.layout.lang} file={blocks.layout.file} html={blocks.layout.html} />
      {/* source: docs/css.md:96 (brust loads Tailwind only when a stylesheet, or a file it @imports, contains @import "tailwindcss", @apply, @reference, @theme or @plugin; packages missing: tailwind-missing with the bun add -d command); css.ts:224 (TAILWIND_USE) and build/tailwind.ts loadTailwind (tailwind-missing) */}
      <h3>When it loads</h3>
      <p>
        brust loads Tailwind only when a stylesheet, or a file it imports, contains <code>@import "tailwindcss"</code>, <code>@apply</code>, <code>@reference</code>, <code>@theme</code> or <code>@plugin</code>. If the packages are missing, the build fails with{' '}
        <code>tailwind-missing</code> and prints the <code>bun add -d</code> command.
      </p>
      {/* source: css.ts:218-236 (CSS_IMPORT matches relative @import specifiers only: `@import "./x.css"`; tailwindUse follows those, never a bare package name); docs/css.md:96 ("or a file it @imports") */}
      <Note tag="Limit">
        brust looks for Tailwind in your stylesheets and in the files they import by a relative path. An <code>@import</code> of a bare package name is not followed, so Tailwind used only inside a package's stylesheet is not detected: put one of the markers above
        in one of your own files.
      </Note>
      {/* source: docs/css.md:97 (Tailwind scans the app root for class names; utilities used in .tsx files end up in the stylesheet, minified) and :98 (import tailwindcss once; the build warns on more than one file); css.ts:128-131 (the warning) */}
      <h3>What it scans, and one import</h3>
      <p>
        Tailwind scans the app root for class names, so the utilities you use in <code>.tsx</code> files end up in the stylesheet, minified like the rest. Import <code>tailwindcss</code> once, in the stylesheet your root layout imports: the build warns when more than one
        file has <code>@import "tailwindcss"</code>, because each one ships all of Tailwind.
      </p>
      {/* source: docs/css.md:99-105 (@apply in a CSS Module needs @reference to your Tailwind entry; brust does not add it) and :107 (cascade: v4 utilities are in @layer, unlayered CSS beats them whatever the file order; put the module rule in a layer to let a utility override it) */}
      <h3>Inside a CSS Module</h3>
      <p>
        A CSS Module that uses <code>@apply</code> must reference your Tailwind entry itself. This is standard in v4; brust does not add it.
      </p>
      <CodeBlock code={blocks.apply.code} lang={blocks.apply.lang} file={blocks.apply.file} html={blocks.apply.html} />
      <p>
        Tailwind v4 puts its utilities in a cascade layer, and unlayered CSS beats layered CSS whatever the file order. Your CSS Modules and plain stylesheets are unlayered, so they beat a utility. To let a utility override a module class, put the module rule in a
        layer too.
      </p>
      <CodeBlock code={blocks.layer.code} lang={blocks.layer.lang} file={blocks.layer.file} html={blocks.layer.html} />

      <h2 id="dev">In brust dev</h2>
      {/* source: docs/css.md:108 (editing a stylesheet rebuilds the CSS and the page swaps its data-brust-css links without reloading; editing a .tsx file rebuilds and reloads, Tailwind rescans) and :34 (dev does not minify); packages/brust/src/dev/client.ts:8-9 and :52-62 (swapBuiltCss: replaces each data-brust-css link with the new href, no reload) */}
      <p>
        Editing a stylesheet rebuilds the CSS and the open page swaps its stylesheet links without reloading, so the page keeps its state. Editing a <code>.tsx</code> file rebuilds and reloads the page, and Tailwind rescans for classes. In dev the CSS is not minified.
      </p>

      <h2 id="same">What does not change</h2>
      {/* source: docs/css.md:69-70 (a <link> you write to public/ is untouched and has no content hash; no JS bundle contains CSS: a .css import in JS is an empty module and a .module.css import is its class map) */}
      <ul>
        <li>
          A <code>&lt;link&gt;</code> you write to a file in <code>public/</code> is served as before, without a content hash.
        </li>
        <li>
          No JavaScript bundle contains CSS. A <code>.css</code> import in JavaScript is an empty module, and a <code>.module.css</code> import is its class map.
        </li>
      </ul>
    </section>
  )
}
