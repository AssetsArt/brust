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

      <h2 id="alpha-7">2.0.0-alpha.7</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.6: #206 (per-instance-jobs PR1, F142) and #207 (island-prop-demotion, F138h); docs/shadcn-coverage.json (64 of 64 pages build) */}
      <p>
        Every page of the shadcn/ui fixture now builds, and a table of rows no longer needs React. See <a href="/docs/shadcn">shadcn/ui and React libraries</a> for the current numbers.
      </p>

      <h3>Upgrade note</h3>
      {/* source: per-instance-jobs PR 2 (lane/per-instance-jobs @40a8db65, reviewed, not yet on main when this was written): the manifest format moves from version 2 to 3; the refusal text was produced by starting a version 2 manifest with that build (Dew, task per-instance-jobs). Check this line against crates/brust-core/src/manifest.rs once PR 2 is on main. */}
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
