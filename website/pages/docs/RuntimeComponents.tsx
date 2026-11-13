// Runtime components — render a component whose source text was stored after `brust build`: [build] expose, compileComponent,
// <Dynamic>, the resolver, the artifact and its limits, the trust model.
// Source of truth: the behaviour of packages/brust/src/compile/index.ts (the compile API and its refusals), packages/brust/src/routes.ts
// (RuntimeComponents, RuntimeArtifact, Dynamic) and the served test tests/server/runtime-components.chromium.test.ts, whose fixture is
// the code below. This page is static.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface RuntimeComponentsData {
  toc: TocItem[]
  blocks: Record<'expose' | 'source' | 'list' | 'resolver' | 'artifact' | 'manifest' | 'facts' | 'island', CodeBlockData>
}

const EXPOSE = `# brust.toml
[build]
expose = ["shop/sdk.ts"]`

const SOURCE = `// shop/sdk.ts: an app module, built with the app and exposed to runtime components
import { defineStore, signal } from '@brust/core/store'

export const cart = defineStore('cart', () => ({ count: signal(0) }))`

const LIST = `// List.tsx: a built component with one slot per row
import { Dynamic } from '@brust/core'

export default function List({ items }: { items: { ref: string; label: string }[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i.ref}>
          <Dynamic component={i.ref} props={{ label: i.label }} />
        </li>
      ))}
    </ul>
  )
}`

const RESOLVER = `// routes.tsx
import { type RuntimeComponents } from '@brust/core'
import { compileComponent } from '@brust/core/compile'

export const components: RuntimeComponents = {
  async resolve(ref, { build }) {
    const source = await db.componentSource(ref)       // text, stored after the build
    if (source === null) return null                   // no such ref: the slot prints nothing
    const cached = await db.artifact(ref, build)       // keyed by (ref, build)
    if (cached) return cached
    const r = await compileComponent({ source, filename: 'el/Promo.tsx' })
    if (!r.ok) return null                             // r.diagnostics says why
    await db.saveArtifact(ref, build, r.artifact)
    return r.artifact
  },
}`

const ARTIFACT = `interface RuntimeArtifact {
  v: 1
  build: string          // assets.build of the build it was compiled for
  id: string             // the x-data / defineBehavior id: a function of (filename, source text)
  tier: 'static' | 'native'
  jinja: string          // the server template
  client: string | null  // one self-contained ES module; null for a static component
  features: string[]     // the client runtime modules it needs
  stores: string[]       // the store names it reads
}`

const ISLAND = `// The app renders this component itself: \`render\` returns its HTML for the slot's props, \`client\` hydrates it.
const CLIENT = \`;(globalThis.__brustIslands ||= []).push(['counter_3f9a', (host, props, committed) => {
  const b = host.querySelector('button')
  let n = 0
  const on = () => { b.textContent = props.label + ' ' + ++n }
  b.addEventListener('click', on)
  committed()                       // the host gets data-committed and fires brust:island
  return () => b.removeEventListener('click', on)   // called when the host leaves the page
}])
globalThis.__brustIslandReady?.()\`

export const components: RuntimeComponents = {
  resolve(ref, { build }) {
    if (ref !== 'counter') return null
    // id: change it whenever CLIENT changes (a content hash); the chunk URL carries it and is cached for good
    return { v: 1, build, id: 'counter_3f9a', tier: 'island', client: CLIENT }
  },
  render(ref, props, { page }) {
    // page.id is one page render, page.total the calls of this batch: a per-page budget if you need one
    return \`<button type="button">\${escapeHtml(String(props.label))} 0</button>\`
  },
}`

const MANIFEST = `"runtime": {
  "exposed": { "shop/sdk.ts": "client/x-sdk-<hex>.js" },
  "stores":  { "cart": "shop/sdk.ts" }
}`

const FACTS = `const r = await compileComponent({ source, filename: 'el/Promo.tsx' })
const f = r.facts            // present when the text parses, on { ok: false } too
if (f && (f.risky.length > 0 || f.rawHtml || f.globals.some((g) => !ALLOWED_GLOBALS.has(g)))) {
  return null                // your policy: refuse what you do not want to run
}
// Handlers: allow-list what they write and call, and refuse the rest (incl. what the walk could not trace).
const writesOk = (w) => w.target === 'local'
const callsOk = (c) => c.kind === 'setter' || c.kind === 'local'
if (f?.handlers.some((h) => !h.writes.every(writesOk) || !h.callees.every(callsOk))) return null`

export async function runtimeComponentsLoader(): Promise<RuntimeComponentsData> {
  return {
    toc: [
      { id: 'expose', title: 'Expose your modules' },
      { id: 'compile', title: 'Compile a source' },
      { id: 'slot', title: 'Place it with Dynamic' },
      { id: 'resolver', title: 'The resolver' },
      { id: 'artifact', title: 'The artifact' },
      { id: 'refusals', title: 'What is refused' },
      { id: 'facts', title: 'Facts for a check' },
      { id: 'island', title: 'Islands you render yourself' },
      { id: 'limits', title: 'Limits and caching' },
      { id: 'trust', title: 'The trust model' },
    ],
    blocks: {
      expose: codeBlock({ lang: 'text', file: 'brust.toml', code: EXPOSE }),
      source: codeBlock({ lang: 'ts', file: 'shop/sdk.ts', code: SOURCE }),
      list: codeBlock({ lang: 'tsx', file: 'List.tsx', code: LIST }),
      resolver: codeBlock({ lang: 'tsx', file: 'routes.tsx', code: RESOLVER }),
      artifact: codeBlock({ lang: 'ts', file: 'RuntimeArtifact', code: ARTIFACT }),
      manifest: codeBlock({ lang: 'text', file: 'dist/manifest.json', code: MANIFEST }),
      facts: codeBlock({ lang: 'ts', file: 'routes.tsx', code: FACTS }),
      island: codeBlock({ lang: 'ts', file: 'routes.tsx', code: ISLAND }),
    },
  }
}

export default function RuntimeComponents({ blocks }: RuntimeComponentsData) {
  return (
    <>
      <h1>Runtime components</h1>
      <Lead>
        A runtime component is a TSX source your app stores outside its route tree, for example in a database, and creates or changes long after <code>brust build</code>. One running build compiles it and renders it as a real brust component, static or
        native, inside your pages. No deploy, and every replica serves the same result.
      </Lead>
      <p>Three parts fit together: you expose some of your own modules, you compile a source into an artifact, and a page places the artifact with a slot.</p>

      <h2 id="expose">Expose your modules</h2>
      <p>
        A runtime component may share code with the app only through modules you list in <code>[build] expose</code>. Each one is built once, as a client file with a stable URL, so a built component and a runtime component that import it get the{' '}
        <strong>same module instance</strong> in the browser. That is how both read and write one store.
      </p>
      <CodeBlock code={blocks.expose.code} lang={blocks.expose.lang} file={blocks.expose.file} html={blocks.expose.html} />
      <CodeBlock code={blocks.source.code} lang={blocks.source.lang} file={blocks.source.file} html={blocks.source.html} />
      <ul>
        <li>The paths are app-root-relative and inside the root or a <code>source_roots</code> entry. A missing file or a path outside the roots is a build error.</li>
        <li>
          Every <code>defineStore(&apos;name&apos;, …)</code> an exposed module exports is listed in the manifest, so a runtime component may read it. The store forms recognised are a direct export, a default export, a renamed export,{' '}
          <code>export … from</code>, <code>export *</code> and import-then-export, all with <strong>relative</strong> specifiers and a literal store name. A store re-exported through an alias or a package specifier is not listed, and a runtime component that
          reads it is refused (<code>runtime-store</code>).
        </li>
        <li>
          Changing <code>expose</code> changes the build id, so artifacts compiled for the old build are no longer valid (see <a href="#limits">Limits and caching</a>).
        </li>
      </ul>
      <CodeBlock code={blocks.manifest.code} lang={blocks.manifest.lang} file={blocks.manifest.file} html={blocks.manifest.html} />

      <h2 id="compile">Compile a source</h2>
      <p>
        <code>compileComponent</code> from <code>@brust/core/compile</code> compiles source text exactly as the build would. It reads <code>dist/manifest.json</code> and <code>brust.toml</code> (source roots, server-only modules, tsconfig aliases) and
        writes nothing under the app root. It runs in Bun and is refused in a browser bundle.
      </p>
      <ul>
        <li>
          <code>compileComponent({'{'} source, filename, appRoot?, dist? {'}'})</code>. <code>filename</code> is a virtual app-root-relative path such as <code>el/Promo.tsx</code>; it decides how the source&rsquo;s relative imports resolve.{' '}
          <code>appRoot</code> defaults to the working directory and <code>dist</code> to <code>&lt;appRoot&gt;/dist</code>.
        </li>
        <li>
          The result is <code>{'{'} ok: true, artifact, diagnostics {'}'}</code> or <code>{'{'} ok: false, diagnostics {'}'}</code>. A diagnostic carries <code>class</code>, <code>rule</code>, <code>message</code>, <code>line</code>, <code>col</code> and{' '}
          <code>remediation</code>.
        </li>
        <li>
          The artifact id is content-addressed: it changes when the source text changes and is equal on every machine for an equal (filename, source). Two filenames with the same text give different ids, because the filename decides how imports resolve.
        </li>
        <li>
          The source may import <code>react</code>, <code>@brust/core/store/react</code> and your exposed modules. Type-only imports are erased by the parser and are not checked.
        </li>
      </ul>

      <h2 id="slot">Place it with Dynamic</h2>
      <p>
        <code>&lt;Dynamic component={'{'}ref{'}'} props={'{'}…{'}'} /&gt;</code> from <code>@brust/core</code> is a slot. The server decides on every render which ref goes there; the artifact&rsquo;s root is the output, with no wrapper element. It works inside a
        server list row.
      </p>
      <CodeBlock code={blocks.list.code} lang={blocks.list.lang} file={blocks.list.file} html={blocks.list.html} />
      <ul>
        <li>
          <code>component</code> and <code>props</code> must be server expressions that do not depend on state, a store or live props (<code>dynamic-expr</code>, <code>dynamic-reactive</code>). Only <code>component</code>, <code>props</code> and <code>key</code>{' '}
          are accepted (<code>dynamic-props</code>).
        </li>
        <li>
          A slot cannot sit in a row the browser builds, such as the list of a stateful component (<code>dynamic-in-client-row</code>), or in a React island (<code>dynamic-in-react</code>). Calling <code>Dynamic</code> as a function throws.
        </li>
        <li>
          The component receives <code>props</code> as its props (JSON values). A <code>ref</code> must match <code>[A-Za-z0-9_-]{'{'}1,128{'}'}</code>; anything else renders nothing.
        </li>
        <li>
          <code>brust build --target static</code>, the Cloudflare target and <code>--ssg</code> refuse an app that has a slot (<code>dynamic-target</code>): a slot is filled by the running native server, and a prerendered page would freeze it.
        </li>
      </ul>

      <h2 id="resolver">The resolver</h2>
      <p>
        The routes entry exports <code>components</code>. Its <code>resolve(ref, {'{'} build {'}'})</code> returns the artifact for a ref, <code>null</code> when there is none, or a promise of either. A build that has a slot and no <code>components</code> export
        does not start.
      </p>
      <CodeBlock code={blocks.resolver.code} lang={blocks.resolver.lang} file={blocks.resolver.file} html={blocks.resolver.html} />
      <ul>
        <li>
          A page renders once when every ref in it is warm. A cold ref is resolved (all cold refs of one render in one call to a worker), then the page renders a second time. Nothing else runs twice: the loader is not run again.
        </li>
        <li>
          <strong>Missing:</strong> <code>resolve</code> returned <code>null</code>. The slot prints nothing, the answer is remembered for 10 seconds, and the page is cached for at most that long, so a row that names a ref before its artifact exists heals.
        </li>
        <li>
          <strong>Refused or failed:</strong> the artifact failed a registration check, or <code>resolve</code> threw. The slot prints nothing and one line is logged (<code>[brust] runtime component &lt;ref&gt;: &lt;why&gt;</code>). The page is still answered with 200, but it
          is not stored in the page cache.
        </li>
        <li>An error while the artifact&rsquo;s template renders also prints nothing for that slot, and never turns the page into a 500.</li>
        <li>
          The scripts of every native artifact that rendered are linked once per page at <code>/_brust/rc/&lt;build&gt;/&lt;ref&gt;/&lt;id&gt;.js</code>, served with an immutable cache header only when the id matches the registered artifact. A page that is otherwise all
          static gets the client runtime when a native artifact rendered.
        </li>
        <li>
          Warm artifacts are kept per server, up to <code>[components] cache_entries</code> (default 2048). Each entry holds up to 512 KiB.
        </li>
      </ul>

      <h2 id="artifact">The artifact</h2>
      <p>The artifact is JSON. Your app stores it and returns it as it is; do not edit it.</p>
      <CodeBlock code={blocks.artifact.code} lang={blocks.artifact.lang} file={blocks.artifact.file} html={blocks.artifact.html} />
      <p>
        It is valid for one build only, because the client chunk imports the build&rsquo;s hashed runtime and exposed-module URLs. Key your store by (ref, build). After a deploy, <code>resolve</code> gets the new build id and compiles again; an artifact for another
        build is refused.
      </p>

      <h2 id="refusals">What is refused</h2>
      <p>
        These are errors with <code>ok: false</code>. Each names a position and a fix.
      </p>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>runtime-tier</code></td>
            <td>The component needs React (an island). The message carries the compiler&rsquo;s reason.</td>
          </tr>
          <tr>
            <td><code>runtime-jobs</code></td>
            <td>Some expression is left to run on the server per render (a runtime job). Only a pure component fits one template.</td>
          </tr>
          <tr>
            <td><code>runtime-import</code></td>
            <td>An import that is not an exposed module, <code>react</code> or <code>@brust/core/store/react</code>. A private copy of an app module would split its state.</td>
          </tr>
          <tr>
            <td><code>runtime-store</code></td>
            <td>It reads a store no exposed module defines.</td>
          </tr>
          <tr>
            <td><code>runtime-use-id</code></td>
            <td>It calls <code>useId</code>.</td>
          </tr>
          <tr>
            <td><code>runtime-children</code></td>
            <td>It takes children fed per instance.</td>
          </tr>
          <tr>
            <td><code>runtime-dynamic</code></td>
            <td>It holds a <code>&lt;Dynamic&gt;</code>: slots do not nest.</td>
          </tr>
          <tr>
            <td><code>runtime-size</code></td>
            <td>The template or the client module is over 256 KiB.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="facts">Facts for a check</h2>
      <p>
        The result of <code>compileComponent</code> also carries <code>facts</code>: what the source file refers to, read from the same parse and symbol table the compiler uses, over the whole file (render, handlers, effects and module-level helpers).
        They are present whenever the text parses, on an <code>ok: false</code> result too. Use them as the input of your own allowlist.
      </p>
      <CodeBlock code={blocks.facts.code} lang={blocks.facts.lang} file={blocks.facts.file} html={blocks.facts.html} />
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Holds</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>imports</code></td>
            <td>Each runtime import as <code>{'{'} specifier, names {'}'}</code>. Type-only imports are erased by the parser and never appear.</td>
          </tr>
          <tr>
            <td><code>globals</code></td>
            <td>Every unbound identifier the file reads, writes or calls (<code>fetch</code>, <code>document</code>, <code>window</code>), sorted.</td>
          </tr>
          <tr>
            <td><code>hooks</code></td>
            <td>Calls named <code>useX</code> as <code>{'{'} name, from {'}'}</code>; <code>from</code> is the import specifier, or <code>null</code> for a local or global one.</td>
          </tr>
          <tr>
            <td><code>tags</code>, <code>attrs</code></td>
            <td>The JSX tags and every prop name written on an element, including <code>dangerouslySetInnerHTML</code>, <code>ref</code> and <code>style</code>.</td>
          </tr>
          <tr>
            <td><code>spreads</code>, <code>rawHtml</code></td>
            <td>Whether a JSX spread attribute appears, and whether <code>dangerouslySetInnerHTML</code> is written.</td>
          </tr>
          <tr>
            <td><code>handlers</code></td>
            <td>
              Each <code>onX</code> prop with its <code>event</code>, <code>tag</code> and position, and what its function does, block bodies, nested callbacks and every local function it reaches (by call or by naming it) included:
              <code>callees</code> (a callee&rsquo;s <code>kind</code> is <code>import</code>, <code>local</code>, <code>setter</code>, <code>prop</code>, <code>prop-member</code>, <code>global</code>, <code>global-member</code>, <code>param-member</code>, <code>member</code> or <code>unknown</code>; a handler that is
              not a function written in the file, such as <code>onClick={'{'}props.go{'}'}</code>, is itself a callee), <code>writes</code> (every assignment, <code>++</code> and <code>delete</code>, each with a <code>target</code> and the written
              <code>path</code>), <code>readsParams</code> (it looks at the event), <code>globals</code> and <code>reaches</code>.
            </td>
          </tr>
          <tr>
            <td><code>functions</code></td>
            <td>Every local function some handler reaches, with the same facts for its own body, so the rule applied to a handler can be applied to each function behind it.</td>
          </tr>
          <tr>
            <td><code>risky</code></td>
            <td>Constructs that can reach a name the walk cannot see: <code>dynamic-import</code>, <code>computed-member</code>, <code>constructor-access</code> and <code>eval</code>, with positions.</td>
          </tr>
        </tbody>
      </table>
      <p>
        A <code>writes</code> entry&rsquo;s <code>target</code> says what the written place is rooted at: <code>local</code> (a variable the handler declares, or a property of an object literal it made, one level deep), <code>param</code> (<code>e = x</code>),
        <code>param-member</code> (<code>e.currentTarget.innerHTML = x</code>, also through a <code>const</code> alias of the event), <code>prop-member</code> (through a parameter of an enclosing function, such as <code>props.obj.x = 1</code>), <code>closure</code> and <code>closure-member</code> (a variable of the component or module, or a property of one), <code>global</code>
        (<code>location = x</code>), <code>global-member</code> (<code>document.title = x</code>) and <code>other</code> for anything the walk cannot trace (a call result, <code>this</code>, a loop variable, a name assigned from several sources). A target that is not
        recognised is <code>other</code>, never <code>local</code>, and a callee it cannot name is <code>unknown</code>, never omitted. A callee of kind <code>prop</code> or <code>prop-member</code> is <em>not local</em>: it came in from outside the component (its props, or a helper&rsquo;s argument), and the file does not say what it is, even when the same file passes a global into it. It is claimed only for a parameter that is never reassigned, never handed to a call or spread into an element, and none of whose members (or its aliases&rsquo; members) is written anywhere in the file; otherwise the callee is <code>unknown</code> or <code>member</code>.
        <strong>Allow-list</strong>: write targets <code>local</code> and callee kinds <code>setter</code> and <code>local</code>, and refuse the rest; add <code>prop</code> only on purpose, for a platform that trusts the props its host passes.
        Effects (<code>useEffect</code>), callback refs and module-level code are named by <code>hooks</code>, <code>attrs</code> and <code>globals</code>; their writes are not listed.
      </p>
      <Note tag="Limit">
        Facts are a report, not a sandbox. They name what the source refers to. They are an input to an allowlist, not a proof of isolation: a computed member such as <code>window[k]</code>, <code>eval</code> or a dynamic <code>import()</code> can reach a name the walk never sees (which is why they are
        listed in <code>risky</code>), and what an imported function does is outside the file. Pair them with a Content-Security-Policy. There is no built-in allow or deny profile; the <code>runtime-import</code> refusal already stops foreign imports.
      </Note>

      {/* source: crates/brust-core/src/components.rs (register: tier island; island_slot; HtmlCache), packages/brust/src/handlers.ts (resolveComponents: renders), tests/server/rc-island.chromium.test.ts (F546) */}
      <h2 id="island">Islands you render yourself</h2>
      <p>
        An app that renders a component on its own (its own server rendering, its own client code) returns an <strong>island artifact</strong>: <code>tier: &apos;island&apos;</code>, an <code>id</code>, and a <code>client</code> module, with no <code>jinja</code>.
        The slot prints the same host a built React island gets, <code>&lt;brust-island data-id=&quot;&lt;id&gt;&quot; x-props=&apos;&lt;the props&gt;&apos;&gt;</code>, around the HTML your <code>components.render(ref, props, ctx)</code> returns for that
        slot&apos;s props. The island runtime then hydrates each host once when the browser is idle, calls your hydrate function with <code>(host, props, committed)</code>, sets <code>data-hydrated</code> and, when you call <code>committed()</code>,
        <code>data-committed</code>, and calls the function it returned when the host leaves the page.
      </p>
      <CodeBlock code={blocks.island.code} lang={blocks.island.lang} file={blocks.island.file} html={blocks.island.html} />
      <ul>
        <li>
          <strong>The HTML is trusted.</strong> What <code>render</code> returns is placed inside the host as given, like a loader&apos;s raw HTML: escape what you put in it. The props are written into <code>x-props</code> as data, escaped as for a built
          island.
        </li>
        <li>
          One page render makes at most one extra worker call: the refs it has not resolved yet and the (ref, props) pairs whose HTML is not cached go together. <code>render</code> is called once per distinct (ref, props) of that page, in parallel, with{' '}
          <code>ctx = {'{'} build, page: {'{'} id, total {'}'} {'}'}</code>: <code>page.id</code> is the same for every call of one page render, <code>page.total</code> the number of calls in the batch (cached pairs are not called).
        </li>
        <li>
          The server caches the HTML per (ref, artifact, props), bounded by <code>[components] cache_entries</code> and 64 MiB in total; a new artifact for the ref starts afresh. <code>null</code> (or no <code>render</code>) prints an empty host your
          client mounts into, and the page is cached as usual. A throw, or more than 4 MiB of HTML, prints an empty host and the page is not cached.
        </li>
        <li>
          <strong>
            <code>render</code> must depend only on <code>(ref, props)</code>.
          </strong>{' '}
          Do not read cookies, the user, the time or anything else of the request: the HTML cache and the page cache are shared by every visitor, so what one user&apos;s render returned is what the next user gets. Pass what varies as props, or render that
          part in the client.
        </li>
        <li>
          All the HTML one page asks for comes back in that one worker reply, which is limited by <code>[server] max_loader_response_bytes</code> (default 8 MiB, up to 64 MiB). A page whose batch is bigger loses every island of that batch: empty hosts, and
          the page is not cached. Raise the limit, or keep the per-page HTML small (<code>page.total</code> helps you budget it).
        </li>
        <li>
          The client module is served at <code>/_brust/rc/&lt;build&gt;/&lt;ref&gt;/&lt;id&gt;.js</code>, at most 256 KiB, cached for good: <strong>change the id whenever the client changes</strong>. A ref registered again with the same id and other code is
          refused, and so is one id with two different codes.
        </li>
        <li>
          The module may import other same-origin modules by absolute path (<code>/app/shared.js</code>, with your base path if you have one); brust neither bundles nor rewrites them, and one URL is one module in the browser, so every island on the page
          shares it. A cross-origin import is not refused by brust, but <code>[csp]</code> (<code>script-src &apos;self&apos;</code>) blocks it. The chunk itself is same-origin and adds nothing inline.
        </li>
        <li>
          <code>compileComponent</code> never produces an island artifact: you build it yourself. The same targets apply: a <code>{'<Dynamic>'}</code> slot renders on the brust server only.
        </li>
      </ul>

      <h2 id="limits">Limits and caching</h2>
      <ul>
        <li>
          <code>jinja</code> and <code>client</code> are each at most 256 KiB. The server also checks at registration that the artifact is for this build, that every feature and store it names exists, and that its template parses. An artifact whose id belongs to a built
          component is refused.
        </li>
        <li>
          The chunk URL carries the artifact id, which changes with the source. Browsers cache it for good, so <strong>give a changed source a new ref</strong> (or a ref that includes a version); the server keeps the artifact warm per ref.
        </li>
        <li>An artifact&rsquo;s template renders in its own sandboxed template environment with a fuel limit: it cannot include or import an app template, and a runaway loop ends as a render error for that slot.</li>
        <li>
          SPA navigation works as on any page: the slot is part of the page HTML, and its scripts load with the page. A native artifact that reads a store seeds it like a built component does.
        </li>
      </ul>

      <h2 id="trust">The trust model</h2>
      <Note tag="Trust">
        An artifact is code: its template runs on your server and its client module runs in your visitors&rsquo; browsers, with the page&rsquo;s own privileges. Return only what <code>compileComponent</code> produced from a source you accept.
      </Note>
      <ul>
        <li>
          Never accept an artifact from a client or an untrusted store. Compile on your side, from the source text, and store the result next to the ref and the build.
        </li>
        <li>
          Decide who may write a source before you compile it. The compile API enforces the shape of a runtime component (no foreign imports, no React tier, no jobs); it is not a sandbox for what the source&rsquo;s own handlers do in the browser. Pair untrusted
          authors with a Content-Security-Policy and a review step.
        </li>
        <li>
          The ref must change when the source changes, and artifacts are keyed per build. That keeps a stale artifact from rendering against a build whose runtime URLs it does not match.
        </li>
      </ul>
    </>
  )
}
