// Release notes — what each published version changed, newest first. One section per version; adding a release is one new section.
// Every entry names its source (a PR or a file) in a comment beside it. Versions before alpha.6 are one line each, taken from the tag
// annotations and the merged pull requests between the tags, nothing more.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface ReleaseNotesData {
  toc: TocItem[]
  blocks: Record<'refusal', CodeBlockData>
}

// observed: the refusal printed when brust starts a build with manifest version 2 (Dew, task per-instance-jobs)
const REFUSAL = '[brust] manifest: manifest version 2 unsupported (want 3): rebuild the app with this brust version'

export async function releaseNotesLoader(): Promise<ReleaseNotesData> {
  return {
    toc: [
      { id: 'alpha-12', title: '2.0.0-alpha.12' },
      { id: 'alpha-11', title: '2.0.0-alpha.11' },
      { id: 'alpha-10', title: '2.0.0-alpha.10' },
      { id: 'alpha-9', title: '2.0.0-alpha.9' },
      { id: 'alpha-8', title: '2.0.0-alpha.8' },
      { id: 'alpha-7', title: '2.0.0-alpha.7' },
      { id: 'alpha-6', title: '2.0.0-alpha.6' },
      { id: 'earlier', title: 'Earlier versions' },
    ],
    blocks: { refusal: codeBlock({ lang: 'text', cwd: 'brust start', code: REFUSAL }) },
  }
}

export default function ReleaseNotes({ blocks }: ReleaseNotesData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Release notes</h1>
      <Lead>What changed in each published version of brust, newest first. Packages are published under <code>@brust/*</code> with the version shown.</Lead>

      <h2 id="alpha-12">2.0.0-alpha.12 · 15 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.11: #236–#240 (context lowering 1a and 1c, F181, F155 tests, F183) */}
      <p>Context Providers that brust can lower, shadcn setup in <code>bun create</code>, no idle workers for static shadcn apps, and fixes for children that disappeared.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #237 (F181 + the F175 later row) */}
        <li>
          <strong><code>bun create @brust/app my-app --shadcn button card</code></strong> creates the project and runs <code>brust shadcn init</code> in it, in one command.
        </li>
        {/* source: PR #236 and #239 (S2 wave A PR 1a and 1c, plan 2026-10-14-shadcn-context-lowering) */}
        <li>
          <strong>Context Providers compile.</strong> A component that provides a value with <code>createContext</code> (or Radix&rsquo;s <code>createContextScope</code>) and the components that read it now compile without React when the Provider&rsquo;s value is literal data and the children under it read only props, locals, constants, or module helpers that brust can prove return a string, number or boolean. Anything else keeps the Provider as a React island, with a named reason in the build output. The Radix Progress pages still render as islands.
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #236 (jsx-const-child guard, found in review by Mellow) */}
        <li>
          <strong>A JSX constant used as children no longer disappears.</strong> <code>const icon = &lt;Star /&gt;</code> (in the same file or imported), passed as <code>{'{'}icon{'}'}</code> to a component that brust compiles, could render as an empty element on the server. It now renders, using React where brust cannot prove what the value is.
        </li>
        {/* source: PR #236 (integration with #229) */}
        <li>
          <strong>A context consumer with server work inside a React island no longer fails the build.</strong> The component that renders it stays React. The shadcn collapsible, dialog and sheet pages are affected: each now renders as a React page with one island, at about the same size as before (89, 101 and 101 KB).
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #237, reviewed by Mellow */}
        <li>
          <strong><code>brust shadcn init</code> is safer to run and to copy from.</strong> It no longer writes through a symlinked <code>tsconfig.json</code> or <code>components.json</code>. It installs the exact package versions it was tested with, and it warns that a component given as a registry URL installs third-party code. Every command it prints for you to run quotes the folder and component names, so pasting them into a shell cannot run anything else.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #240 (F183) */}
        <li>
          <strong>Static shadcn apps start with no worker processes.</strong> Server code that no page uses is no longer written to <code>jobs.js</code>, and it no longer counts when <code>brust start</code> decides whether it needs workers. The pages are served the same.
        </li>
        {/* source: PR #236 (lead ruling on Provider frame values) */}
        <li>
          <strong>A context Provider whose value comes from props, state or a function call stays a React island.</strong> brust lowers a Provider only when its value is literal data; any other value keeps the React behaviour exactly.
        </li>
      </ul>

      <h2 id="alpha-11">2.0.0-alpha.11 · 15 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.10: #228–#234 (F165, F164 PR 2a + F169, F148a, F175, F182, F178, F164 PR 2b) */}
      <p>A one-command shadcn/ui setup, fewer worker processes for static apps, more components that compile, and fixes for builds that failed on valid React.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #231 (F175, human request; plan 2026-10-14-shadcn-init-command, R41.1–R41.10) */}
        <li>
          <strong><code>brust shadcn init</code> sets up shadcn/ui in one command.</strong> Run <code>bunx brust shadcn init button card dialog</code> in a project. It writes <code>components.json</code>, adds the <code>@/*</code> path to <code>tsconfig.json</code> (your comments are kept) and installs the four packages the components use. Then it runs the shadcn CLI, at a pinned version, to add the theme and the components you named. A second run skips every step that is already done. <a href="/docs/guides/shadcn-setup">Set up shadcn/ui</a> is rewritten around it.
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #232 (F182): #229 re-based instance records only for static wrappers */}
        <li>
          <strong>A native component that holds a component with its own server work no longer fails the build.</strong> A component with state and a handler that renders a child with a server job or <code>useId</code> stopped <code>brust build</code> with <code>nested-instance</code>. The component that renders it now stays React.
        </li>
        {/* source: PR #233 (F178, found by knock2 in the wave B spike) */}
        <li>
          <strong>An object constant used in an event handler no longer breaks the build.</strong> <code>const step = {'{'} up: 1, down: -1 {'}'}</code> inside a component, read in an <code>onClick</code>, was printed as invalid JavaScript and stopped <code>brust build</code>. It now compiles and behaves as in React.
        </li>
        {/* source: PR #229 (F169, Mellow N1) */}
        <li>
          <strong><code>useId</code> no longer repeats the same id.</strong> A child that calls <code>useId</code>, passed through a component that renders its children in every row of a list, printed the same id in each row. Such a child now renders with React.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #228 (F165, R40.1): manifest needs_workers */}
        <li>
          <strong>An app whose pages are all static no longer starts worker processes.</strong> If no page has a loader, a server job, an action, a React island to render on the server or a cache adapter, <code>brust start</code> serves without workers. It therefore no longer imports your route modules: top-level code in them runs during <code>brust build</code>, not at start.
        </li>
        {/* source: PR #229 (F164 PR 2a, R34.83 + static-wrapper re-base) */}
        <li>
          <strong>Props spread into a component that does server work now compile.</strong> A wrapper that spreads its props into such a child (<code>{'{'}...props{'}'}</code>) used to keep the page in React. It now compiles, and the shadcn <code>aspect-ratio</code> page goes from 74 KB of JavaScript to none.
        </li>
        {/* source: PR #234 (F164 PR 2b, R34.96 job fusion), served parity with React folded and per request */}
        <li>
          <strong>Components whose children need their own server work run as one job.</strong> When a component computes something on the server and so does a child it renders (shadcn&rsquo;s pagination link inside a button, an input group&rsquo;s addon), the child now runs inside the parent&rsquo;s job instead of keeping the page in React. Client JavaScript on the shadcn pages: pagination 87 → 0 KB, button-group 86 → 0 KB, separator 84 → 0 KB, input-group 87 → 4 KB, field 86 → 4 KB.
        </li>
        {/* source: PR #230 (F148a, R34.116–R34.125), reviewed for the data path (Afrojack) and security (Mellow) */}
        <li>
          <strong>A component that passes its own props into a React island compiles.</strong> If a wrapper renders an island and passes it <code>{'{'}title{'}'}</code>, <code>{'{'}children{'}'}</code> or a condition over its props, the page stays static and only the island loads React. Values from a request are only ever rendered as text or as attribute values, never as markup. A <code>style</code> object, a list over props and a wrapper that also spreads props into the island still render with React.
        </li>
      </ul>

      <h2 id="alpha-10">2.0.0-alpha.10 · 14 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.9: #222–#226 (F153b parts 3–4, hardening batch, F149, F164 PR 1) */}
      <p>Mostly fixes: pages that rendered the wrong classes or text, builds that failed on valid React, and one security hardening. Upgrading is recommended.</p>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #225 (F149 + challenge 9b2a99a9): brust-core projected a missing job input as null; cva treats null as "no variant" */}
        <li>
          <strong>A component built with <code>cva</code> gets its default classes when you omit a variant.</strong> A shadcn-style <code>&lt;Alert&gt;</code> or <code>&lt;Badge&gt;</code> without a <code>variant</code> prop was rendered by the server without its <code>defaultVariants</code> classes, because a missing prop reached the class function as <code>null</code> instead of <code>undefined</code>. It now matches React, including nested props, explicit <code>null</code>, default parameters and <code>??</code>.
        </li>
        {/* source: PR #223 (F168, found by Afrojack in review) */}
        <li>
          <strong>A prop named <code>loop</code>, <code>range</code>, <code>namespace</code>, <code>caller</code> or <code>self</code> renders its value.</strong> Read as <code>props.loop</code> (or <code>rest.self</code>), it printed the server template&rsquo;s own object, such as <code>&lt;loop 0/2&gt;</code>. Those reads now render with React.
        </li>
        {/* source: PR #226 (F164 PR 1, R34.97) */}
        <li>
          <strong>Valid React no longer stops the build with <code>nested-instance</code> or <code>instance-prop-path</code>.</strong> Shapes such as <code>&lt;Button className={'{'}cn('a', props.x){'}'} /&gt;</code> in a page, a component with server-computed props inside another inlined component, or an island with per-row props in nested lists now render with React instead of failing <code>brust build</code>.
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #223 (hardening batch item 1, F163), signed off by Mellow */}
        <li>
          <strong><code>server-only</code> modules stay on the server.</strong> A module that imports <code>server-only</code> and is reached from code that runs in the browser is refused with brust&rsquo;s own error, including through re-exports and dynamic imports. The build also checks that <code>.brust</code> and <code>.brust/pkg-src</code> stay inside your app before deleting anything there.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #225 (F149, R34.88–R34.95): evaluated once at build with the real packages, no port */}
        <li>
          <strong>Class names built from constants are computed at build time.</strong> <code>cn(…)</code>, <code>cva(…)</code>, <code>clsx</code> and <code>tailwind-merge</code> calls whose inputs are constants run once during <code>brust build</code> (with the real packages) and the page carries the resulting class string, so the server does less work per request. <code>brust dev</code> keeps computing them per request; the output is the same.
        </li>
        {/* source: PR #224 (F153b part 4) and PR #222 (F153b part 3) */}
        <li>
          <strong>More prop shapes compile.</strong> A prop default that reads a module constant (<code>orientation = DEFAULT_ORIENTATION</code>), and a spread onto an HTML element of a constant whose value is chosen by a condition (<code>const attrs = vertical ? a : b</code>, then <code>{'{'}...attrs{'}'}</code>).
        </li>
      </ul>

      <h2 id="alpha-9">2.0.0-alpha.9 · 14 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.8: #216–#220 (F153b part 2, L35, F153c, F161, F159); docs/shadcn-coverage.json */}
      <p>
        brust now compiles published library source, more shadcn/ui pages ship no JavaScript, and there is a guide for setting up shadcn/ui. See <a href="/docs/guides/shadcn-setup">Set up shadcn/ui</a> and <a href="/docs/shadcn">shadcn/ui and libraries</a>.
      </p>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #219 lane/props-pattern-fix (F161): found by Mellow; the template read `data-x` as `data - x` */}
        <li>
          <strong>A props pattern with a quoted key no longer breaks every render.</strong> <code>function C({'{'} 'data-x': dx, ...rest {'}'})</code> compiled, but each render of that component failed and the page answered 500. A default that is an immediately called function, <code>{'{'} a = (() =&gt; 1)() {'}'}</code>, rendered empty. Both, and the related defaults that could not be printed, now render with React (a named fallback), in parameter and body patterns.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #218 lane/package-source (F153c): sourcesContent extracted to .brust/pkg-src, integrity-checked against the dist, never executed */}
        <li>
          <strong>Published packages are compiled from their own source.</strong> When a package ships its original TypeScript in its source maps (every <code>@radix-ui/*</code> package does), brust compiles the components you use instead of shipping them as a React island. The first one is Radix Label: the label page goes from 85 KB to 4 KB of JavaScript. A package without its source stays an island, as before.
        </li>
        {/* source: PR #220 lane/icon-shapes (F159, R34.76–R34.78) */}
        <li>
          <strong><code>@/</code> imports, icons that receive props, and <code>??</code> fallbacks compile.</strong> <code>tsconfig.json</code> <code>paths</code> (such as <code>"@/*": ["./*"]</code>, which the shadcn CLI writes) resolve like relative imports; a lucide icon that receives <code>{'{'}...props{'}'}</code> renders as plain SVG; <code>{'{'}children ?? &lt;ChevronRight /&gt;{'}'}</code> renders without React. The spinner, breadcrumb and button pages ship no JavaScript.
        </li>
        {/* source: PR #216 lane/forwardref-body-destructure (F153b part 2, R34.66) */}
        <li>
          <strong>Props destructured in the component body.</strong> <code>const {'{'} a, b = 1, ...rest {'}'} = props</code> compiles like the same pattern in the parameter list.
        </li>
        {/* source: PR #217 lane/shadcn-setup-guide (L35), verified with the real shadcn CLI on a fresh project */}
        <li>
          <strong>Guide: set up shadcn/ui.</strong> A step-by-step guide from <code>bun create @brust/app</code> to shadcn/ui components, and a new &ldquo;React &amp; libraries&rdquo; section in these docs.
        </li>
      </ul>

      <h2 id="alpha-8">2.0.0-alpha.8 · 14 October 2026</h2>
      {/* source: PR #214 lane/revive-hardening (F158, R34.69–R34.75); the HTTP 500 was reproduced by Mellow on 2.0.0-alpha.6 and alpha.7 (React error #31 thrown by the SSR job) */}
      <p>A fix release. Upgrade if your app uses 2.0.0-alpha.6 or alpha.7.</p>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #214: nestedOf returned undefined for element-only lowered children, so the island had no revive code */}
        <li>
          <strong>A page no longer answers HTTP 500 when a React island gets plain HTML elements as children.</strong> In 2.0.0-alpha.6 and alpha.7, an island whose JSX children (or element-valued props) were only plain elements, such as <code>&lt;TooltipTrigger&gt;&lt;span&gt;…&lt;/span&gt;&lt;/TooltipTrigger&gt;</code>, made the server render fail with React error #31 and the whole page returned 500. Those children now render as React elements.
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #214 (R34.69–R34.72); docs/plans/2026-10-14-shadcn-revive-hardening.md §2 threat model */}
        <li>
          <strong>Request data can no longer be turned into elements by the island revive.</strong> In 2.0.0-alpha.7, when one component was both a page or layout and a React island that received JSX children from another file, data returned by its loader could reach the code that rebuilds those children, so a loader value shaped like brust&rsquo;s internal markers could add elements to the page. React&rsquo;s escaping, the removal of <code>dangerouslySetInnerHTML</code> and the island&rsquo;s own component list still applied. Now a page or layout is never such a host (the caller falls back to React with <code>revive-host-route-root</code>), only names the compiler declared are rebuilt, and a server render rejects reserved <code>$</code> keys in a host&rsquo;s inputs.
        </li>
      </ul>

      <h2 id="alpha-7">2.0.0-alpha.7 · 14 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.6: #206–#212 (F142 PR1 and PR2, F138h, F153a, F157, F155, F153b part 1); docs/shadcn-coverage.json (64 of 64 pages build) */}
      <p>
        Every page of the shadcn/ui fixture now builds, lists and conditions made of constants no longer force a React island, and the largest page is smaller. See <a href="/docs/shadcn">shadcn/ui and React libraries</a> for the current numbers.
      </p>

      <h3>Upgrade note</h3>
      {/* source: PR #210 (F142 PR 2): MANIFEST_VERSION 2 to 3 in crates/brust-core/src/manifest.rs; the refusal text is that file's Version error, produced by starting a version 2 manifest with that build (Dew, task per-instance-jobs). */}
      <p>
        <strong>Rebuild your app after you upgrade.</strong> The build output (<code>dist/manifest.json</code>) changed format, from version 2 to 3. A build made with an earlier brust is refused when it starts:
      </p>
      <CodeBlock code={blocks.refusal.code} lang={blocks.refusal.lang} cwd={blocks.refusal.cwd} html={blocks.refusal.html} />
      <p>Run <code>brust build</code> again with the new version; nothing else changes in your project.</p>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #207 lane/island-prop-demotion (F138h, R34.56–R34.60): island-prop is a fallback, not a build error */}
        <li>
          <strong>A function or a changing value passed to a React island no longer fails the build.</strong> The component that passes it renders with React, like every other shape brust does not lower, and the build prints <code>island-prop</code> as a fallback. Before, such a page stopped with <code>error island-prop</code>.
        </li>
        {/* source: PR #206 lane/per-instance-jobs PR 1 (F142, R34.42): a fed instance whose job inputs are the same in every row of a list over a module constant or an inline array */}
        <li>
          <strong>Lists over a constant.</strong> A component rendered in a <code>.map</code> over a module constant or an inline array, whose props do not depend on the row, is rendered once per page instead of making the page a React island (<code>instance-list-path</code>). A table of rows built from a constant array is static.
        </li>
        {/* source: PR #210 lane/per-instance-jobs PR 2 (F142, R34.43): rows of a constant list ride the manifest (per-row-literal), hence manifest version 3 */}
        <li>
          <strong>A component fed by the row of a constant list.</strong> A component rendered in a <code>.map</code> over a module constant or inline array, whose props read the row, gets one job call per row from the literal instead of falling back. The served HTML of the started page equals the React build&rsquo;s.
        </li>
        {/* source: PR #209 lane/constant-slots (F157, R34.49–R34.55): a closed-subset folder, never runs your code */}
        <li>
          <strong>Constant lists, conditions and element props inside an island&rsquo;s children.</strong> <code>[1, 2, 3].map(n =&gt; &lt;li&gt;{'{'}n{'}'}&lt;/li&gt;)</code>, <code>Array.from({'{'} length: 4 {'}'}, …)</code>, a constant condition, and an element passed as a prop (<code>content={'{'}&lt;Tooltip /&gt;{'}'}</code>) are worked out at build time. The scroll-area, carousel, sidebar and chart pages stop being React pages, each keeping only its library island. A prop named <code>$…</code> on an island fails closed.
        </li>
        {/* source: PR #211 lane/esm-resolve (F155, R37.1–R37.4): staged bare imports resolve natively; one React copy across chunks is a test */}
        <li>
          <strong>Smaller island bundles.</strong> A package imported by a staged island is now resolved the way your own source is, so it is tree-shaken: the dialog page goes from 114 to 102 KB gzip, and the chart page stays at 240 KB now that it is a static page (without this change it would have grown to 324 KB). One copy of React is bundled across island, runtime and job chunks, for the Bun build, the Cloudflare build and <code>--target static</code>.
        </li>
        {/* source: PR #212 lane/forwardref-components (F153b part 1, R34.63, R34.64): forwardRef components compile; refs drop on hosts */}
        <li>
          <strong><code>forwardRef</code> components.</strong> <code>const X = React.forwardRef(function X(props, ref) {'{'} … {'}'})</code>, an arrow callback, <code>export default forwardRef(…)</code> and alias exports (<code>export {'{'} X, X as Root {'}'}</code>) compile like any component. A forwarded <code>ref={'{'}ref{'}'}</code> on an HTML element is dropped; any other use of the ref (reading it, passing <code>ref</code> to a component, <code>useImperativeHandle</code>) keeps the component on React (<code>forwardref-ref</code>).
        </li>
        {/* source: PR #208 lane/jsx-runtime-call (F153a, R34.67): hand-written jsx() calls fall back */}
        <li>
          <strong>A hand-written <code>jsx()</code> call is no longer printed as an object.</strong> A call to <code>jsx</code>, <code>jsxs</code> or <code>jsxDEV</code> from <code>react/jsx-runtime</code> now falls back to React (<code>jsx-runtime-call</code>). Before, the page compiled static with the element object in its HTML.
        </li>
      </ul>

      <h2 id="alpha-6">2.0.0-alpha.6 · 14 October 2026</h2>
      {/* source: tag v2.0.0-alpha.6 (22675c21), the pull requests merged since v2.0.0-alpha.5: #196–#205 */}
      <p>
        This release is about React code you did not write for brust. The compiler now reads what shadcn/ui components are made of, so more of them render as static markup or a native component instead of a React island.
        See <a href="/docs/shadcn">shadcn/ui and React libraries</a> for what compiles and what does not, with the numbers from the build.
      </p>

      <h3>You can now write</h3>
      <ul>
        {/* source: PR #200 lane/rest-props (shadcn S1.2, R34.14–R34.19): rest props in the props pattern and {...props} spreads */}
        <li>
          <strong>Rest props and JSX spread.</strong> <code>function Card({'{'} className, ...props {'}'})</code> followed by <code>&lt;div {'{'}...props{'}'} /&gt;</code> compiles. It used to be a React island (<code>prop-pattern</code>, <code>spread-props</code>).
        </li>
        {/* source: PR #202 lane/spread-handlers (shadcn S1.3, R34.18–R34.20): the parent binds the forwarded function on the child's element */}
        <li>
          <strong>A handler through a child&rsquo;s rest spread.</strong> <code>&lt;Button onClick={'{'}add{'}'}&gt;</code> where <code>Button</code> spreads its props onto a <code>&lt;button&gt;</code>: the parent binds the handler on that element and becomes a native component, instead of the pair falling back to React. A handler that closes over the child&rsquo;s own state, and render props, still keep the component a React island.
        </li>
        {/* source: PR #204 lane/local-component (R34.28–R34.34): const Comp = asChild ? Slot : "button" resolved at the call site */}
        <li>
          <strong><code>asChild</code> and <code>Slot</code>.</strong> <code>const Comp = asChild ? Slot.Root : 'button'</code> is resolved where the component is used: <code>&lt;Button&gt;</code> is a button, <code>&lt;Button asChild&gt;&lt;a href="/x"&gt;…&lt;/a&gt;&lt;/Button&gt;</code> is the link carrying the button&rsquo;s props. A value that is not known when you build still makes the component an island.
        </li>
        {/* source: PR #205 lane/member-tag (R34.35–R34.41): <Pkg.Member> and const aliases resolve to the package export */}
        <li>
          <strong><code>&lt;Pkg.Member&gt;</code> tags.</strong> <code>&lt;DialogPrimitive.Root&gt;</code> and a <code>const Root = DialogPrimitive.Root</code> alias resolve to the package&rsquo;s export, which renders as an island like any package component. A member that the package does not have fails with <code>brust: &lt;package&gt; has no export &lt;path&gt;</code> when the island loads.
        </li>
        {/* source: PR #203 lane/island-children (R34.21–R34.27): constant JSX children travel into the island as JSON */}
        <li>
          <strong>Constant children inside an island.</strong> Markup between the tags of a React island, when it is constant, is handed to the island as data. The page around it stays static; before, one such island made the whole page one island.
        </li>
        {/* source: PR #198 lane/named-export-islands (S1.1): an island whose component is a named export of its file */}
        <li>
          <strong>Components exported by name.</strong> A file that exports several components (<code>Card</code>, <code>CardHeader</code>, …) can have any of them rendered as an island. Before, building such a page failed with <code>No matching export … for import &quot;default&quot;</code>.
        </li>
      </ul>

      <h3>What got smaller</h3>
      <ul>
        {/* source: PR #201 lane/runtime-split (L33); packages/brust/src/build/features.ts:8 (the feature modules), crates/brust-core/src/render.rs (the modulepreload links) */}
        <li>
          <strong>A page loads only the browser runtime it uses.</strong> The runtime is a small core plus feature files (<code>basics</code>, <code>if</code>, <code>for</code>, <code>model</code>, <code>html</code>, <code>island</code>, <code>store</code>). The build records which a page needs and the page links exactly those, with <code>modulepreload</code>. Before, every page with a native component loaded the whole runtime. See <a href="/docs/rendering-tiers">Rendering tiers</a>.
        </li>
      </ul>

      <h3>CSS</h3>
      <ul>
        {/* source: PR #196 lane/tailwind-compiler (L32, F135): the app's own Tailwind version compiles the app's CSS; 4.1 is the floor with a clear error */}
        <li>
          <strong>Your Tailwind compiles your CSS.</strong> The Tailwind version installed in your app builds your stylesheet, not a copy bundled with brust. Tailwind 4.1 is the minimum; an older version stops the build with an error that says so. See <a href="/docs/css">CSS</a>.
        </li>
      </ul>

      <h3>Measuring shadcn/ui</h3>
      <ul>
        {/* source: PRs #197 lane/shadcn-survey and #199 lane/shadcn-measured: scripts/shadcn, docs/shadcn-coverage.md and .json */}
        <li>
          A fixture app with the shadcn/ui components, built page by page, writes <code>docs/shadcn-coverage.md</code> and <code>docs/shadcn-coverage.json</code>: tier, islands and client JavaScript per page, and the ranked list of what still blocks. CI fails when the committed copy is stale.
        </li>
      </ul>

      <h2 id="earlier">Earlier versions</h2>
      <ul>
        {/* source: tag v2.0.0-alpha.5 (f3ec0349) and PRs #181–#195 */}
        <li>
          <strong>2.0.0-alpha.5</strong> · 13 October 2026. The documentation site on Tailwind (#191–#195), its stylesheet through the brust CSS pipeline (#186), <code>create-app</code> writes the current version (#187), and fixes for two flaky tests (server start-up logging #181, a 413 on chunked bodies #183).
        </li>
        {/* source: tag v2.0.0-alpha.4 (c7d937e0) and PRs #156–#180 */}
        <li>
          <strong>2.0.0-alpha.4</strong> · 13 October 2026. Static export (<code>--target static</code>, #159), the CSS pipeline and Tailwind (#163, #167), components from packages as islands (#161), build-time evaluation of constant slots (#164, #174), lucide icons as inline SVG (#178), CSS Modules folded into class names (#177), standalone actions (#172), the dev tools panel (#166), and a blank template with Tailwind (#168, #180).
        </li>
        {/* source: tag v2.0.0-alpha.3 annotation: "M4-CF: Cloudflare Workers runtime (workers-rs, @brust/core-cf) + cache adapters (@brust/core/cache-adapter, @brust/cache-redis, @brust/cache-cloudflare)" */}
        <li>
          <strong>2.0.0-alpha.3</strong> · 12 October 2026. The Cloudflare Workers runtime (<code>@brust/core-cf</code>) and cache adapters: <code>@brust/core/cache-adapter</code>, <code>@brust/cache-redis</code>, <code>@brust/cache-cloudflare</code>.
        </li>
        {/* source: tag v2.0.0-alpha.2 and PR #143 (beta1 follow-ups F81–F91) */}
        <li>
          <strong>2.0.0-alpha.2</strong> · 12 October 2026. Follow-ups to the first alpha: cache read stamps for the L1 and job caches, the cross-site guard for actions, large action bodies.
        </li>
        {/* source: tag v2.0.0-alpha.1 and PRs #140–#142 (M3-F, M3-P) */}
        <li>
          <strong>2.0.0-alpha.1</strong> · 12 October 2026. The first v2 release: the unified store, Actions served as an Elysia app behind the Rust HTTP server, <code>bun create @brust/app</code>, and the performance work with its benchmark suite.
        </li>
      </ul>
    </section>
  )
}
