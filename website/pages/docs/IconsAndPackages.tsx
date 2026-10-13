// Icons and packages — a component from an npm package in a static or native page (it renders as a React island of the export itself), and lucide-react icons, which render at build time to inline SVG instead.
// Every factual claim below has a `source:` comment next to it. Package islands (L22) are on v2 at docs-site 0689b0c6; the lucide icons (L23) are cited from lane/lucide-native @1071c202 until v2 lands them (the lane's files are named in full).
// Lines marked "observed" were run (lucide-react 1.55.0 in packages/brust/test/fixtures/lucide), not read.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import IconAttrs from '../../components/demos/IconAttrs'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface PackagesData {
  toc: TocItem[]
  blocks: Record<'pkg' | 'warn' | 'icons' | 'staticOut' | 'nativeOut' | 'provider' | 'fallbackWarn', CodeBlockData>
}

const PKG = `import { Chart } from 'fancy-charts'      // a package, not a file of yours

export default function Report({ rows }: { rows: number[] }) {
  return (
    <section>
      <h1>Totals</h1>
      <Chart kind="bar" values={rows} />       {/* JSON props: literals and props paths */}
    </section>
  )
}`

// observed: the build line for a lucide <Heart> that stays an island (Fallback.tsx in packages/brust/test/fixtures/lucide, lucide-react 1.55.0)
const WARN = `warning external-component Fallback.tsx:4:10 <Heart> comes from the package lucide-react; it renders as a React island`

const ICONS = `import { Heart, Plus } from 'lucide-react'

export default function Toolbar({ big, tone }: { big: number; tone: string }) {
  return (
    <p>
      <Heart size={16} color="red" strokeWidth={1.5} className="love" />
      <Plus />
      <Heart size={big} color={tone} />   {/* values that change: lowered to attributes */}
    </p>
  )
}`

// observed: packages/brust/test/fixtures/lucide/Static.tsx built on lane/lucide-native @1071c202 with lucide-react 1.55.0; the first icon's markup in dist/jinja/static_*.jinja
const STATIC_OUT = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="red" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart love" aria-hidden="true"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676…"></path></svg>`

// observed: the same build, packages/brust/test/fixtures/lucide/Native.tsx (<Heart size={n} color={c} /> with useState), dist/jinja/native_*.jinja, svg start tag, line wrapped here
const NATIVE_OUT = `<svg xmlns="http://www.w3.org/2000/svg"
  {% if (n if n is defined and n is not none else "24") | present %}
    width="{{ (n if n is defined and n is not none else "24") | attr_str | e }}"{% endif %}
  x-bind-width="_c1" … x-bind-height="_c2" viewBox="0 0 24 24" fill="none"
  {% if (c … else "currentColor") | present %} stroke="{{ … }}"{% endif %}
  x-bind-stroke="_c3" stroke-width="2" … class="lucide lucide-heart" aria-hidden="true">`

const PROVIDER = `import { Heart, LucideProvider, Plus } from 'lucide-react'

export default function Provided() {
  return (
    <LucideProvider size={32} color="green" strokeWidth={3}>
      <Heart />            {/* 32px, green, stroke 3: applied at build */}
      <Plus size={10} />   {/* 10px: its own prop wins */}
    </LucideProvider>
  )
}`

// observed: DynamicProvider.tsx and Fallback.tsx in the same fixture, same build
const FALLBACK_WARN = `warning icon-provider-dynamic DynamicProvider.tsx:5:5 LucideProvider prop \`size\` is not a constant (line 5:5); the icons under it render as React islands
warning icon-dynamic-prop Fallback.tsx:4:10 icon prop \`aria-label\` is not a constant and cannot be lowered to an attribute; the icon renders as a React island`

export async function packagesLoader(): Promise<PackagesData> {
  return {
    toc: [
      { id: 'package', title: 'A component from a package' },
      { id: 'icons', title: 'lucide-react icons' },
      { id: 'output', title: 'What the build writes' },
      { id: 'dynamic', title: 'Values that change' },
      { id: 'defaults', title: 'React’s defaults stay' },
      { id: 'provider', title: 'LucideProvider' },
      { id: 'fallbacks', title: 'When an icon stays an island' },
      { id: 'versions', title: 'Versions' },
    ],
    blocks: {
      pkg: codeBlock({ lang: 'tsx', file: 'pages/Report.tsx', code: PKG }),
      warn: codeBlock({ lang: 'text', cwd: 'brust build', code: WARN }),
      icons: codeBlock({ lang: 'tsx', file: 'pages/Toolbar.tsx', code: ICONS }),
      staticOut: codeBlock({ lang: 'text', file: 'static page, first icon', code: STATIC_OUT }),
      nativeOut: codeBlock({ lang: 'text', file: 'native page, start tag of the icon', code: NATIVE_OUT }),
      provider: codeBlock({ lang: 'tsx', file: 'pages/Provided.tsx', code: PROVIDER }),
      fallbackWarn: codeBlock({ lang: 'text', cwd: 'brust build', code: FALLBACK_WARN }),
    },
  }
}

export default function IconsAndPackages({ blocks }: PackagesData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Icons and packages</h1>
      <p className="lead">A component from a package works in any page. An icon from lucide-react does better than that: the build turns it into inline SVG, so the page ships no React for it.</p>

      <h2 id="package">A component from a package</h2>
      {/* source: crates/brust-compiler/src/analyze/passes/children.rs:249 (the external-component fallback names the package and says "it renders as a React island") */}
      <p>
        Import a component from a package and use it in a static or native page. The build prints <code>external-component</code> for it, and the component is rendered as a React island: the island is the package&rsquo;s own export,
        not a file of yours. The page around it stays static or native.
      </p>
      <CodeBlock code={blocks.pkg.code} lang={blocks.pkg.lang} file={blocks.pkg.file} html={blocks.pkg.html} />
      {/* source: crates/brust-compiler/src/analyze/passes/children.rs:119-131 (the island id is the export&rsquo;s name plus a hash of the package and the export, one island per export) and packages/brust/src/build/bundle.ts:282-289 (componentImport: the island entry and the worker&rsquo;s SSR entry import { Export } from 'package', or the default export) */}
      <p>
        The server renders it in the worker and the browser hydrates it from a chunk that imports the export. Each package export is one island, however many pages use it. The package must be installed in your project, as it is for any
        other import.
      </p>
      {/* source: crates/brust-compiler/src/analyze/passes/children.rs:553-590 (island-prop is an error for a function or a value read from state or a store, and for an island in a list that changes with state; island-children is a fallback for JSX children) */}
      <p>
        A package component takes the same props as any island: plain JSON values, either literals or values from your props. A function, a value that changes with state, or JSX children is refused; render those inside a React component of
        your own instead.
      </p>
      {/* source: packages/brust/test/e2e-external-island.test.ts and tests/server/external-island.chromium.test.ts — a tiny local package in a static parent and in a native parent: built, server-rendered, hydrated in Chromium with no console error */}
      <CodeBlock code={blocks.warn.code} lang={blocks.warn.lang} cwd={blocks.warn.cwd} html={blocks.warn.html} />

      <h2 id="icons">lucide-react icons</h2>
      {/* source: lane/lucide-native @1071c202 crates/brust-compiler/src/analyze/passes/icons.rs:1-10 (an icon from lucide-react becomes inline SVG; the build renders it) and :26-28 (a named import, an alias, or a deep …/icons/<name> import) */}
      <p>
        An icon imported from <code>lucide-react</code> (a named export, an alias such as <code>Edit</code>, or a deep import of one icon) is not an island. The build renders it once and writes the SVG into the page.
      </p>
      <CodeBlock code={blocks.icons.code} lang={blocks.icons.lang} file={blocks.icons.file} html={blocks.icons.html} />
      {/* source: lane/lucide-native @1071c202 packages/brust/src/build/build-icons.ts:1-5 and :48-59 (react-dom/server renderToStaticMarkup with the app&rsquo;s own react and lucide-react); packages/brust/test/lucide-native.test.ts (the page contains renderToStaticMarkup&rsquo;s output byte for byte) */}
      <p>
        The build renders each icon with <code>react-dom/server</code>, using your project&rsquo;s own <code>react</code> and <code>lucide-react</code>. The markup is therefore what React itself would print for the installed version,
        character for character.
      </p>

      <h2 id="output">What the build writes</h2>
      {/* source: lane/lucide-native @1071c202 packages/brust/test/lucide-native.test.ts (the static page: needs_worker false, no job, no client chunk, no brust-island) */}
      <p>A static page carries the SVG and nothing else: no worker job, no script, no island.</p>
      <CodeBlock code={blocks.staticOut.code} lang={blocks.staticOut.lang} file={blocks.staticOut.file} html={blocks.staticOut.html} />

      <h2 id="dynamic">Values that change</h2>
      {/* source: lane/lucide-native @1071c202 icons.rs:18-19 (size, color, strokeWidth and className may be dynamic) and :174-190 (any other prop that is not a constant: icon-dynamic-prop, the icon stays an island); parser/lowering: icons.rs (a sentinel in the markup becomes a dynamic attribute) */}
      <p>
        <code>size</code>, <code>color</code>, <code>strokeWidth</code> and <code>className</code> may be values that change: a prop, a value from state, a loop item. They become attributes of the SVG, computed like any other attribute: in a
        static page by the server, in a native page by the server for the first paint and by a binding afterwards.
      </p>
      <CodeBlock code={blocks.nativeOut.code} lang={blocks.nativeOut.lang} file={blocks.nativeOut.file} html={blocks.nativeOut.html} />
      {/* source: observed: tests/server/lucide.chromium.test.ts on lane/lucide-native @1071c202 — in Chromium a native icon&rsquo;s width and stroke follow state (16 to 24, red to blue), no island, no console error */}
      <p>
        <code>size</code> sets both <code>width</code> and <code>height</code>; <code>color</code> sets <code>stroke</code>; <code>className</code> is added after the icon&rsquo;s own classes. In the browser the bindings keep the SVG in step
        with the state.
      </p>

      <h2 id="defaults">React’s defaults stay</h2>
      {/* source: lane/lucide-native @1071c202 packages/brust/src/build/build-icons.ts:62-63 (the icon is rendered a second time with the changing props absent) and icons.rs (`prop ?? default` for a size, color or stroke width, a conditional for className); packages/brust/test/lucide-native.test.ts "an undefined size / color / strokeWidth / className renders React's defaults" */}
      <p>
        When a value is <code>undefined</code> (or <code>null</code>), the icon is what React would render without that prop: 24 pixels, <code>currentColor</code>, a stroke width of 2, or the values of an enclosing{' '}
        <code>LucideProvider</code>. The build renders the icon a second time with those props left out and uses that markup as the fallback for each attribute.
      </p>

      <h3 id="try">Try it</h3>
      <p>The demo is plain JSX with the same rule: pick &ldquo;undefined&rdquo; and the attribute falls back to the default.</p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">IconAttrs · native</span>
        </div>
        <div className="vp">
          <IconAttrs />
        </div>
      </div>

      <h2 id="provider">LucideProvider</h2>
      {/* source: lane/lucide-native @1071c202 icons.rs:106-146 (a provider whose props are all constants is applied at build and removed when every icon under it was rendered; a dynamic prop: icon-provider-dynamic and the icons stay islands) and build-icons.ts:49-54 (the icon is rendered inside the provider with those values); packages/brust/test/lucide-native.test.ts "a literal LucideProvider is applied at build" */}
      <p>A provider with constant props is applied at build, and its icons render with its values. A prop on the icon itself still wins.</p>
      <CodeBlock code={blocks.provider.code} lang={blocks.provider.lang} file={blocks.provider.file} html={blocks.provider.html} />
      <p>A provider whose props change at run time is not applied: its icons stay islands, and the build says so.</p>

      <h2 id="fallbacks">When an icon stays an island</h2>
      {/* source: lane/lucide-native @1071c202 icons.rs:127-135 (icon-provider-dynamic), :181-190 (icon-dynamic-prop), build-icons.ts:64-66 (icon-render: the icon could not be rendered); the whole-icon choice is deferred, ledger row F126 (docs/plans/m1a-followups.md) */}
      <CodeBlock code={blocks.fallbackWarn.code} lang={blocks.fallbackWarn.lang} cwd={blocks.fallbackWarn.cwd} html={blocks.fallbackWarn.html} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>What you wrote</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A prop other than size, color, strokeWidth, className that changes (an <code>aria-label</code> from props)</td>
              <td>
                The icon is an island; <code>icon-dynamic-prop</code> names the prop. Make it a literal to get inline SVG.
              </td>
            </tr>
            <tr>
              <td>A <code>LucideProvider</code> with a prop that changes</td>
              <td>
                The icons under it are islands; <code>icon-provider-dynamic</code>.
              </td>
            </tr>
            <tr>
              <td>
                The icon itself chosen at run time (<code>const Icon = open ? Minus : Plus</code>, or an icon from a map)
              </td>
              <td>An island. Choosing between icons is not inlined yet (ledger row F126); use two icons and show one.</td>
            </tr>
            <tr>
              <td>An icon the build cannot render (a lucide-react without that export)</td>
              <td>
                An island, with <code>icon-render</code> in the build output.
              </td>
            </tr>
            <tr>
              <td>
                <code>size</code> combined with <code>absoluteStrokeWidth</code> when the size changes
              </td>
              <td>An island, with <code>icon-render</code>: the stroke width would depend on the size.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="versions">Versions</h2>
      {/* source: lane/lucide-native @1071c202 packages/brust/package.json (lucide-react 1.55.0 is the version the tests pin); docs/plans/2026-10-13-gaps-round.md §L23 R23.1 (whatever lucide-react the app installs, no copy in brust) */}
      <Note tag="Tested with">
        brust has no copy of lucide-react: the icons come from the version your project installs, so new icons and options appear as soon as you upgrade. The tests run against lucide-react 1.55.0, including <code>nonScalingStroke</code>,
        an alias import and <code>LucideProvider</code>.
      </Note>
    </section>
  )
}
