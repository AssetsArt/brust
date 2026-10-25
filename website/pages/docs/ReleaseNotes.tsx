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
      { id: 'alpha-26', title: '2.0.0-alpha.26' },
      { id: 'alpha-25', title: '2.0.0-alpha.25' },
      { id: 'alpha-24', title: '2.0.0-alpha.24' },
      { id: 'alpha-23', title: '2.0.0-alpha.23' },
      { id: 'alpha-22', title: '2.0.0-alpha.22' },
      { id: 'alpha-21', title: '2.0.0-alpha.21' },
      { id: 'alpha-20', title: '2.0.0-alpha.20' },
      { id: 'alpha-19', title: '2.0.0-alpha.19' },
      { id: 'alpha-18', title: '2.0.0-alpha.18' },
      { id: 'alpha-17', title: '2.0.0-alpha.17' },
      { id: 'alpha-16', title: '2.0.0-alpha.16' },
      { id: 'alpha-15', title: '2.0.0-alpha.15' },
      { id: 'alpha-14', title: '2.0.0-alpha.14' },
      { id: 'alpha-13', title: '2.0.0-alpha.13' },
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

      <h2 id="alpha-26">2.0.0-alpha.26 · 25 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.25 (git log --merges --first-parent v2.0.0-alpha.25..origin/main), written from the merged PRs and the lane branches before the cut: #391 (F455), #392 (F453), #393 (F454) and the navigation docs pull request (F456, #394); design docs/design/2026-10-25-spa-navigation-design.md, plan docs/plans/2026-10-25-spa-navigation.md */}
      <p>Links no longer reload the page. A click on a same-origin link fetches the target&rsquo;s HTML and swaps it in place, and the result is what a full load of that URL would show. Layouts whose markup did not change stay live, with their state, islands and scroll position, and a navigation that crosses layouts never reloads. There are four events to listen to, a <code>data-brust-loading</code> attribute for a preloader in pure CSS, and <code>navigate(url, {'{'} replace {'}'})</code> for code. The pages are described in <a href="/docs/navigation">Navigation</a>.</p>

      <h3>Breaking</h3>
      <ul>
        {/* source: design docs/design/2026-10-25-spa-navigation-design.md section 5.1 (on by default, opt-out by attribute only; there is no config key); PR #393 (F454), packages/runtime-dom/src/nav/nav.ts */}
        <li>
          <strong>Navigation without a reload is on by default. To keep a normal page load, put <code>data-brust-reload</code> on a link, on a region, or on <code>&lt;html&gt;</code>.</strong> Every plain click on a same-origin <code>&lt;a href&gt;</code> now stays in the document. A click with Ctrl, Meta, Shift or Alt, a link with <code>target</code> other than <code>_self</code> or with <code>download</code>, a click that something already <code>preventDefault()</code>-ed, and a link that only changes the <code>#hash</code> are left to the browser, and forms still submit as before. If anything in your app assumed that a link click re-runs every script on the page, check it: a classic script in a layout that stays live does not run again. A script that must run once per tab can say so with <code>data-brust-once</code>. There is no config key; <code>data-brust-reload</code> on <code>&lt;html&gt;</code> turns the whole feature off.
        </li>
        {/* source: PR #392 (F453), crates/brust-core/src/render.rs render_chain_into and inject_document_assets_into; the dev markers were in packages/brust/src/dev/devtools.ts */}
        <li>
          <strong>Every full document now carries the <code>nav</code> script tag, and every layout level is wrapped in <code>&lt;!--brust-l:id:hash--&gt;</code> comments.</strong> The tag (<code>&lt;script type=&quot;module&quot; data-brust-nav&gt;</code>) is on all documents, also pages that are fully static and load no runtime, and in <code>--target static</code> output; fragments get none. The comments mark where each inner layout&rsquo;s output starts and ends, and carry a hash of that layout&rsquo;s own markup, which is how a layout is kept only when its markup is the same. The root layout&rsquo;s id and hash are on the tag. If you minify HTML (an adapter, a CDN setting), keep comments: when they are stripped, navigation still works, but it replaces the whole body instead of keeping layouts. The dev-only <code>&lt;!--brust:id--&gt;</code> markers are gone; the devtools highlighter uses the new ones. Golden files that print a page&rsquo;s HTML change by these comments and the tag.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #393 (F454), packages/runtime-dom/src/nav/ and tests/server/spa-nav.chromium.test.ts; design docs/design/2026-10-25-spa-navigation-design.md sections 3 and 5.9 */}
        <li>
          <strong>A link click fetches the real HTML and swaps only the layout levels that changed.</strong> There is no new endpoint, so the server, the static target, Cloudflare and the adapters all work as they are. The new page&rsquo;s stylesheets and every module it needs (runtime features, behavior chunks, React island chunks) are loaded before anything is swapped, so a page never paints unstyled or before its code. The head ends up exactly as the new page&rsquo;s head, in the same order; an element that is identical in both is reused, not downloaded again, and an element a live component added at runtime (a CSS-in-JS style, a React hoisted link) is kept. Between two pages under the same layouts only the page is replaced; across sibling layouts the common ancestors stay and the rest is replaced; across root layouts the body and the attributes of <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code> are replaced. Whenever a level cannot be swapped safely (an outlet in a <code>&lt;p&gt;</code> whose child is a block, or in a table, a React page level that is not marked, a response with no marks) the swap happens one level higher, in the end the whole body, and a response that is not a page of this build is loaded the normal way. It is never a wrong page. Back and forward restore the scroll position, a <code>#hash</code> scrolls to its target, and a link to the page already on screen re-fetches it without a new history entry. After a deploy the first navigation does a full load, so a tab never mixes two builds. The client is a standalone module of 3,522 bytes gzip (budget 3,730; the design estimate of 2.5 KB was too low once every behaviour above was in), built as its own content-hashed asset.
        </li>
        {/* source: PR #393 (F454), design docs/design/2026-10-25-spa-navigation-design.md section 4 */}
        <li>
          <strong>Four events for a preloader, and <code>data-brust-loading</code> on <code>&lt;html&gt;</code>.</strong> They are plain <code>CustomEvent</code>s on <code>document</code> that bubble, so a native component, a React island or a plain script listens the same way. <code>brust:nav:click</code>: a qualifying link was clicked; it is cancelable, and <code>preventDefault()</code> leaves the click to the browser. <code>brust:nav:load</code>: a navigation started (a link, <code>navigate()</code>, or back and forward). <code>brust:nav:success</code>: the new page is in place and mounting. <code>brust:nav:error</code>: the navigation did not succeed. Each carries <code>id</code> (a per-tab counter that pairs the end with its start), <code>url</code> and <code>from</code>; the order is always <code>click</code>, <code>load</code>, then exactly one of <code>success</code> or <code>error</code>, and a navigation that a newer one aborts fires nothing more. An <code>error</code> for a 404 or another error page that brust rendered has <code>swapped: true</code>: the page is shown, as a full load would show it. An <code>error</code> where nothing could be swapped (network failure, a response of another build, a failed import) has <code>swapped: false</code> and loads the URL the normal way, unless you call <code>preventDefault()</code> to show your own message. While a navigation loads, <code>html[data-brust-loading]</code> matches, which is enough for a progress bar in CSS alone.
        </li>
        {/* source: PR #393 (F454), packages/runtime-dom/src/nav/nav.ts; ruling on challenge 9c2632d3 in the design */}
        <li>
          <strong>Prefetch on intent, <code>data-brust-persist</code>, and head scripts.</strong> A link is fetched after 65 ms of hover, on focus, or at once on touch, and the click uses that response (held for 15 seconds, used once); it is skipped when the browser asks to save data and for <code>data-brust-prefetch=&quot;false&quot;</code> and <code>data-brust-reload</code>. An element with <code>data-brust-persist=&quot;key&quot;</code> that both pages have is moved into the new page and never disposed (a playing video, an open chat widget). A classic script that is new in the head runs; after a swap of the whole body every classic head script runs again, in order, as on a full load, so a theme script that sets <code>&lt;html class&gt;</code> stays right, except those marked <code>data-brust-once</code>.
        </li>
        {/* source: PR #391 (F455), packages/runtime-dom/src/island.ts, packages/brust/src/build/bundle.ts islandShim and packages/runtime-dom/test/spa-nav.test.ts; PR #393 (F454) for the live-store rule; design docs/design/2026-10-25-spa-navigation-design.md section 5.5 */}
        <li>
          <strong>What survives a navigation: live stores, and a React island is unmounted when its page leaves.</strong> A store that is already in use keeps its client value; the new page&rsquo;s snapshot only seeds a store the tab has not used yet, as client state does across a route change in a React app (this is the one place where a navigation differs from a full load). When an island&rsquo;s host leaves the document its React root is unmounted, so effects clean up once, as on a React route change, and the next page&rsquo;s islands hydrate when idle. The island chunk&rsquo;s hydrate function now returns the root&rsquo;s <code>unmount</code>, so island chunks built before alpha.26 should be rebuilt (a build always writes new ones). The dev first-paint warning no longer fires for a component that mounts after the page loaded (F301), and a page that first loads the runtime core while its body is later replaced by another page mounts the new page&rsquo;s components as late ones. The runtime grows by 182 bytes raw; the core is 3,557 bytes gzip of its 3,560 budget.
        </li>
        {/* source: the navigation docs pull request (F456, #394); design docs/design/2026-10-25-spa-navigation-design.md section 5.3 */}
        <li>
          <strong><code>navigate(url, {'{'} replace {'}'})</code> is exported from <code>@brust/core</code>.</strong> It runs the same flow as a click with <code>trigger: &apos;navigate&apos;</code> and resolves after <code>success</code> or <code>error</code>. It is a browser function: on the server it throws <code>navigate is browser-only</code>, and on a page with no <code>nav</code> script it falls back to <code>location.assign</code>. The types of the event <code>detail</code> objects are exported too. <a href="/docs/navigation">Navigation</a> has the events table, the opt-outs, and a preloader example in JavaScript and in CSS.
        </li>
      </ul>

      <h2 id="alpha-25">2.0.0-alpha.25 · 24 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.24 (git log --merges --first-parent v2.0.0-alpha.24..origin/main), written from the merged PRs and the lane branches before the cut: #382 (F402), #383 (F437), #384 (F432, F434), #385 (F431, F446 guard), #386 (F369b, F369c), #387 (F428, F427), #388 (F442 part 1 and W3) and #389 (F372, F375); nothing else is merged, and no pull request is open at the cut */}
      <p>A patch that stops silent wrong output. A React island page that reads a context a layout provides now fails the build with a message and a workaround, where it used to show the context&rsquo;s default. The JavaScript operators <code>-</code>, <code>*</code>, the comparisons and <code>==</code> / <code>===</code> follow JavaScript on the server and no longer answer 500, a controlled <code>&lt;select&gt;</code> behind a spread paints its value, and more Radix components compile to native code.</p>

      <h3>Breaking</h3>
      <ul>
        {/* source: PR #383 (F437; pre-existing: wrong value with no diagnostic); compile.ts checkLayoutContexts and the error text; native resolution is F439 (literal values) and F440 (state values) */}
        <li>
          <strong>A React island page that reads a context a layout provides now fails the build (<code>island-layout-context</code>).</strong> In alpha.24 and earlier, a page that imported a context from another module (<code>useContext(Ctx)</code>, or <code>useTheme()</code> from a theme module) could not be compiled to native code, so it was sent as a React island, and an island is rendered on its own: it never sees the Provider that a layout puts around <code>&lt;Outlet /&gt;</code>. It painted the <code>createContext</code> default, on the server and after the page loaded, where React shows the layout&rsquo;s value. The build now refuses it, naming the module, the context and the layout. The rule is deliberately wide: it applies to the page and to every component in its compiled tree that is an island, and it refuses when the component imports <em>anything</em> (the context, a hook, a helper) from a module that declares a context a layout above the route provides, directly or through re-exporting modules; css, json and image imports are not scripts and are not checked. To fix it, pass the value to the page through its loader (as a prop), or render the Provider inside the page&rsquo;s own tree. Reading such a context natively is planned (F439 for literal values, F440 for values that are state).
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #387 (F428, F427; pre-existing, HTTP 500 or wrong text); the filters are in crates/brust-jinja/src/lib.rs, the printer in crates/brust-compiler/src/lower/server_expr.rs; the 5,460-row table is crates/brust-jinja/tests/js_operators_table.rs, generated by gen-js-operators.ts from JavaScript itself */}
        <li>
          <strong>Subtraction, multiplication, comparisons and equality in a template expression follow JavaScript and no longer answer 500.</strong> The template engine&rsquo;s <code>-</code> and <code>*</code> fail on a string or <code>null</code> (<code>&apos;5&apos; - 1</code>, <code>-s</code>), its <code>&lt;</code> and <code>&gt;</code> fail when a string meets a number, and its <code>==</code> follows Python, so <code>1 == &apos;1&apos;</code> and <code>null == undefined</code> were wrong and <code>true === 1</code> was true. An operator whose two sides are not both known to be numbers (or both strings) now does what JavaScript does: text and <code>null</code> become numbers as <code>Number()</code> does, <code>undefined</code> is <code>NaN</code>, strings compare by UTF-16 code unit, <code>==</code> coerces and <code>===</code> is strict. <code>NaN</code> and <code>Infinity</code> print as JavaScript prints them and <code>-0</code> prints as <code>0</code>. Two numbers, two strings, and <code>===</code> against a string literal keep the plain operator. A loop index (<code>i</code> in <code>items.map((x, i) =&gt; …)</code>) and <code>.length</code> count as numbers, so <code>i + 1</code> is a plain addition again (alpha.24 made it a function call). Two arrays or two objects are never equal here, because a template cannot see whether they are the same object. A list item that is destructured and has the name of an outer loop&rsquo;s index is not yet told apart from that index (F452).
        </li>
        {/* source: PR #384 (F432, F434); spread_control_value and spread_attrs_control in the server lowering, packages/runtime-dom (x-model, x-bind-value); the size change is recorded in runtime-budget.json */}
        <li>
          <strong>A controlled <code>&lt;select&gt;</code> or <code>&lt;textarea&gt;</code> behind a spread paints its value, and a <code>multiple</code> select keeps its picks when the page loads.</strong> <code>&lt;select {'{'}...props{'}'} value={'{'}v{'}'}&gt;</code> and the same for a textarea, the shape of the shadcn wrappers, still wrote a <code>value</code> attribute with no selected option (alpha.24 fixed the shape without a spread). The server now takes the value from the spread when no prop after the last spread gives one, and a textarea whose value is <code>null</code> or <code>undefined</code> shows its children, as React does. In the browser, <code>x-model</code> and <code>x-bind-value</code> on a <code>select multiple</code> used to bind one string and cleared the server&rsquo;s picks on load; they now read and write each option&rsquo;s <code>selected</code>. The model runtime grows from 648 to 720 bytes (655 measured). Not covered yet: a live value bound through a spread by a parent (F445).
        </li>
        {/* source: PR #385 (F431; F446 is the follow-up row for the guard); ComponentIR.ctx_object_defaults, tests/server/ctx-object-defaults.chromium.test.ts */}
        <li>
          <strong>An object <code>createContext</code> default stays native, and a page&rsquo;s own inline Provider no longer paints the default.</strong> In alpha.24 a page that read <code>useContext(Ctx).a</code> or <code>const {'{'} a, b {'}'} = useContext(Ctx)</code> with no Provider, when <code>Ctx</code> was <code>createContext({'{'} a: &apos;x&apos;, b: 2 {'}'})</code>, fell back to a React island. The literal fields now become the defaults of the fields the page reads, for the page and for the components it inlines. A spread, a getter, a computed key, a value that is not a literal, or a read of a field the default does not have still falls back, by name. Separately, a page that rendered <code>&lt;Ctx.Provider&gt;</code> in its own JSX and read the context in a component inside it painted the default where React paints the Provider&rsquo;s value. That is now refused by name (<code>context-no-provider</code>), and the page is rendered by React; framing it natively is F446.
        </li>
        {/* source: PR #382 (F402; pre-existing, the component was refused); rebase_sources in crates/brust-compiler/src/analyze/passes/children.rs; test crates/brust-compiler/tests/foreign_scope_rebase.rs */}
        <li>
          <strong>A <code>Primitive.&lt;tag&gt;</code> from another package scope inside a copied component now resolves.</strong> The Radix <code>Presence</code> of the tabs content is copied into the component that uses it, and the <code>&lt;Primitive.div&gt;</code> it renders comes from <code>@radix-ui/react-primitive</code>, which the copied module cannot import from its own place in a package manager that isolates packages. brust looked for it from the copy and refused the component. It now resolves the factory from the module that wrote the JSX, so the node becomes its element and <code>asChild</code> works as before. A namespace import or a member chain longer than one name is still refused, and so is a component brust cannot resolve at all; the message now names the module that wrote it. In the shadcn coverage the checkbox goes from two React components to one.
        </li>
        {/* source: PR #386 (F369b, F369c); the remaining walls are F448 to F451 in the PR description; packages/runtime-dom bind.ts */}
        <li>
          <strong><code>asChild</code> under a native parent, and handlers passed through a native child&rsquo;s spread.</strong> A native component that takes <code>asChild</code> and renders one element is now copied around that element, so the parent no longer has to be static; the same holds when the child is a native component, and its attributes become props, its event handlers are combined, and its ref carries over. And an <code>on…</code> prop that reaches a native child&rsquo;s rest spread is now bound on the child&rsquo;s element and read from the child&rsquo;s live props when the event fires, so a parent that swaps the handler is honoured, and <code>onChange</code> on a text input listens to <code>input</code> as in React. It refuses (and the component stays React) when the child reads or combines the same key, when a later spread may replace it, or when the order of the element&rsquo;s own handler for that event cannot be proven. The shadcn toggle group does not turn native yet; the next obstacles are F448 to F450.
        </li>
        {/* source: PR #388 (F442 part 1 and W3; the held W2 is not part of it); radix_id.rs and radix_id.shape.js, hook_in_jsx.rs, tests/server/radix-id.test.ts */}
        <li>
          <strong>A hook called inside JSX attributes and a method on an array literal compile natively, and Radix <code>useId</code> ids equal React&rsquo;s.</strong> A built-in method on an array literal of plain values, such as <code>[&apos;mounted&apos;, &apos;unmountSuspended&apos;].includes(state)</code> in Radix&rsquo;s <code>Presence</code>, is now a plain read; it used to make the component a React island. <code>&lt;input id={'{'}useThing(){'}'} /&gt;</code> and a hook whose result is written straight into the JSX are lifted to the top of the component, only when the call is unconditional (not in a condition, a loop or a callback). Radix&rsquo;s own <code>useId</code> (<code>@radix-ui/react-id</code>) is recognised by its printed source, token for token, and by nothing else, and on React 19 it is lowered to the same server-seeded id <code>useId()</code> gives: <code>radix-</code> plus the id, or the id you pass in. Any other shape stays an ordinary custom hook, and with another React version the old path is used, so a change in Radix&rsquo;s hook falls back to a React island and does not paint a wrong id. The ids of a form field, its label and its description match the HTML React renders for the same page.
        </li>
        {/* source: PR #389 (F372, F375; they replace the two refusals of F371 and F374 from alpha.18, which kept these shapes React); crates/brust-compiler/src/analyze/passes/children.rs, tests/clone_cache.rs, tests/server/clone-cache.chromium.test.ts */}
        <li>
          <strong>A native Provider copied for its content can contain another Provider, and a rest forwarder can sit around a native Provider.</strong> Alpha.18 kept these two shapes in React so that they would not paint a wrong value; they are native now, and still paint what React paints. When a component such as a tabs root is copied around its children, a child that reads a context now reads the Provider nearest to it: the one inside the copied template when the child sits under it, the child&rsquo;s own Provider when it has one, and the outer one otherwise. A child that sits beside the inner Provider (next to <code>{'{'}children{'}'}</code>) and reads its context is refused by name and the component stays React, because it would have read the wrong Provider. A wrapper that spreads its own <code>{'{'}...rest{'}'}</code> exactly once into a native Provider is copied for each place that calls it, with its children, or with none; a wrapper with any other spread stays React. A forwarder that is itself a Provider (the shape of <code>RovingFocusGroup</code>) is not covered yet: it needs F446 first, then F447.
        </li>
        {/* source: PR #372 (F386) and the lane js-operators; for people who work on brust */}
        <li>
          <strong>For people who work on brust: the JavaScript operator filters are checked against JavaScript itself.</strong> <code>crates/brust-jinja/tests/gen-js-operators.ts</code> computes the expected result of each operator over 26 operands (undefined, null, booleans, numbers, strings, arrays, objects) with JavaScript and writes a 5,460-row table that a Rust test runs through the filters; the battery has three new rows for the operator families, and <code>tests/server/js-operators.test.ts</code> prints 37 expressions through <code>brust start</code> and compares them with <code>String()</code> of the JavaScript value.
        </li>
      </ul>

      <h2 id="alpha-24">2.0.0-alpha.24 · 24 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.23 (git log --merges --first-parent v2.0.0-alpha.23..origin/main): #371 (F404), #372 (F386), #373 (F415, F416), #374 (F424), #375 (F423), #376 (F425), #377 (F420, F421), #378 (F418, F419), #379 (F438, CI only; one sentence in the contributor entry) and #380 (F288 phase B PR 2); the merge list is re-checked against main before the tag. F418 to F425 were found by the new server-HTML comparison (#372) */}
      <p>A patch of wrong output and crashes, most of them found by comparing the HTML that brust serves with React&rsquo;s own render of every battery row. A local named <code>loop</code> no longer stops the server from starting, a sibling module&rsquo;s JSX constant no longer answers 500, <code>string + number</code> follows JavaScript, and a controlled <code>&lt;select&gt;</code> or <code>&lt;textarea&gt;</code>, a lazily initialised state and a page&rsquo;s own context default now paint their value on the first load.</p>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #375 (F423; found by #372; the server did not boot); the names are from the PR description, Printer::local_var in crates/brust-compiler/src/lower/template.rs is where locals are named */}
        <li>
          <strong>A state or list variable named <code>loop</code>, <code>self</code>, <code>none</code>, <code>True</code> and similar no longer stops <code>brust start</code> for the whole app.</strong> A <code>useState</code>, list item or list index with such a name was written into the template as <code>{'{'}% set loop %{'}'}</code> or <code>{'{'}% for loop in … %{'}'}</code>, which the template engine refuses, so the server did not start at all. Such a name now gets another name in the template. The names covered are the engine&rsquo;s reserved words (<code>loop</code>, <code>self</code>, <code>none</code>, <code>None</code>, <code>True</code>, <code>False</code> and others) and every function brust&rsquo;s templates call. A variable named <code>not</code> also read wrongly and is fixed. Props are not affected: a prop with such a name was already refused with a message.
        </li>
        {/* source: PR #376 (F425; found by #372; pre-existing; the test harnesses set NODE_ENV=production, so no test caught it); installProductionJsxDev in packages/brust/src/build/server-only.ts */}
        <li>
          <strong>A sibling module&rsquo;s JSX constant no longer answers 500 under <code>brust start</code>.</strong> A page that imported <code>export const el = &lt;b /&gt;</code> from another module failed with <code>jsxDEV is not a function</code> when you ran <code>brust start</code> from a shell that has no <code>NODE_ENV</code>: Bun then compiles the JSX for development, and React&rsquo;s production runtime has no <code>jsxDEV</code>. Only JSX that runs when the module is imported was affected. In production mode the workers now map <code>jsxDEV</code> onto the app&rsquo;s own production JSX functions, so there is still one copy of React. <code>brust dev</code> keeps React&rsquo;s development runtime, and a static build or a Cloudflare bundle was never affected.
        </li>
        {/* source: PR #374 (F424; found by #372; pre-existing, HTTP 500); the new filter js_add is in crates/brust-jinja/src/lib.rs, the lowering in crates/brust-compiler/src/lower/server_expr.rs */}
        <li>
          <strong><code>string + number</code> in a template expression follows JavaScript and no longer answers 500.</strong> <code>tone={'{'}t + n{'}'}</code> in a list, with <code>t</code> a string and <code>n</code> an index, failed with &ldquo;tried to use + on string and number&rdquo;, because the template engine&rsquo;s <code>+</code> does not join a string and a number. A <code>+</code> whose two sides are not both known to be numbers now does what JavaScript does: it joins as text when either side is a string (<code>undefined + &apos;x&apos;</code> is <code>&apos;undefinedx&apos;</code>), and adds otherwise. Two numbers still add as before.
        </li>
        {/* source: PR #377 (F420, F421; found by #372); the limits are the new ledger rows F432 and F434 in the PR description; the filters selected_in and textarea_text are in crates/brust-jinja/src/lib.rs */}
        <li>
          <strong>A controlled <code>&lt;select&gt;</code> and <code>&lt;textarea&gt;</code> show their value on the first load.</strong> <code>&lt;select value=&quot;b&quot;&gt;</code> was written with a <code>value</code> attribute and no selected option, so the first option showed until the page loaded; <code>&lt;textarea value=&quot;hi&quot;&gt;</code> was written with a <code>value</code> attribute, which browsers ignore, so it was empty until the page loaded. They now match React: the option whose value equals the select&rsquo;s value (or its text, when it has no <code>value</code>) is <code>selected</code>, and the textarea&rsquo;s value is its text. It works for a string, a number, an array on a <code>multiple</code> select, and <code>defaultValue</code>, and for options written directly, in a <code>.map</code>, in an <code>&lt;optgroup&gt;</code> or in an inlined child component. An <code>&lt;option&gt;</code> that has no <code>value</code> and an element as a child is refused by name (<code>select-option</code>). Not covered yet: a select whose props arrive through a spread (the shadcn wrapper shape; F432), and a <code>multiple</code> select, whose picks the browser still clears when the page loads (F434).
        </li>
        {/* source: PR #378 (F418; found by #372); is_module_fn in crates/brust-compiler/src/lower/common.rs is the shared rule */}
        <li>
          <strong><code>useState(load)</code> with a module-level function paints its value.</strong> <code>const [n] = useState(load)</code>, where <code>load</code> is a function declared in the module or a <code>const</code> arrow or function expression, painted nothing on the server, because the server seeded the function itself and not its result. The server and the client now both call it. An <code>async</code> initialiser keeps its existing fallback to React.
        </li>
        {/* source: PR #378 (F419; found by #372); F431 and F437 are the follow-up ledger rows named in the PR description */}
        <li>
          <strong>A page&rsquo;s own <code>useContext</code> with no Provider paints the context&rsquo;s default.</strong> A page that read a context itself, with nothing providing it, painted nothing; the default given to <code>createContext</code> now shows. When that default is not a plain literal (an object, an array or an expression) and nothing provides the context, the component now falls back to a React island by name (<code>context-no-provider</code>) and does not paint an empty value. Still open: a page that is a React island under a layout&rsquo;s Provider paints the default and not the provided value (F437).
        </li>
        {/* source: PR #371 (F404; pre-existing: wrong output with no diagnostic); crates/brust-compiler/src/analyze/passes/state_children.rs. The only entry in this version that refuses something that compiled before, so it is a change and not a break: the component paints correctly as an island */}
        <li>
          <strong>A state whose initial value reads <code>children</code> now falls back to a React island by name.</strong> <code>const [c] = useState(children)</code> compiled as a native component and printed nothing where React prints the child. It is now refused as <code>state-from-children</code> with the component&rsquo;s file and line, and the component renders as an island, which paints correctly. This covers <code>props.children</code>, a destructured or renamed <code>children</code>, an expression over it, a lazy initialiser, an alias, the whole props object, rest props, <code>useReducer</code> and an inlined custom hook. A component that does not read <code>children</code> into state is unchanged.
        </li>
        {/* source: PR #373 (F415, F416; F288 phase B PR1; both pre-existing); packages/runtime-dom, the capture sink in the core */}
        <li>
          <strong>A conditional branch in the browser disposes its effects and refs when it closes.</strong> The effects and cleanups of an <code>x-if</code> branch (and of a replaced <code>x-for</code> row) were kept on the component, so a branch that you removed kept running: after 20 toggles, one change ran 21 text updates on detached nodes. A ref inside a removed branch also kept the detached element, where React sets it to <code>null</code>. Each branch now owns its effects and refs, and drops them before it leaves the page. The core runtime budget grows by the size of this one hook.
        </li>
        {/* source: PR #380 (F288 phase B PR 2); the order of attaching and detaching is from the PR description; the sentence on what stays React is from the lane's commit message */}
        <li>
          <strong>Radix <code>Presence</code> with an element child now compiles to native code.</strong> The checkbox and radio indicators are the case: <code>Presence</code> renders its element child while it is present, and nothing when it is not. brust now turns that into a conditional branch, and a callback ref inside a branch is attached once the branch is on the page and detached before it leaves, in React 19&rsquo;s order. A callback that changes between renders, a ref inside a list row and a component&rsquo;s <code>children</code> still render with React.
        </li>
        {/* source: PR #372 (F386; a test, not a change in output); scripts/battery/ssr-compare.ts, ssr-normalise.ts and ssr-allowlist.ts; PR #379 (F438) for the last sentence. For people who work on brust */}
        <li>
          <strong>For people who work on brust: CI now compares the HTML of every battery row with React.</strong> <code>bun scripts/battery/ssr-compare.ts --check</code> builds one app with a route for each row, starts it, and compares each row&rsquo;s served HTML with React&rsquo;s <code>renderToString</code> of the same source and props, after a normaliser whose rules are listed in its header. It fails on a difference, and on an allowlisted difference that is no longer there. It found the wrong outputs above (F418 to F425). CI also runs eight served test files that were on main but in no CI step, and a test (<code>scripts/ci-wiring.test.ts</code>) now fails when a file under <code>tests/server</code> is named neither in <code>ci.yml</code> nor in the <code>server-test</code> script.
        </li>
      </ul>

      <h2 id="alpha-23">2.0.0-alpha.23 · 24 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.22 (git log --merges --first-parent v2.0.0-alpha.22..origin/main), written from the lane branches before the cut: #364 (F406), #365 (F407), #366 (F408), F411 (lane aac-font-preload), F413 (lane aac-island-box) and F412 (lane aac-list-first-paint, tests only, so no entry); the merge list is re-checked against main before the tag. The issues were filed by the Assets Art team (B-6 to B-11) */}
      <p>A patch from the Assets Art team&rsquo;s second round of issues. It adds one feature: importing a font or an image file gives its served URL, so a stylesheet font can be preloaded. It fixes a list inside a list row in a native component, a lucide icon under a condition, a line break written before every native component, and a gap that a React island added in a flex or grid row.</p>

      <h3>Changes</h3>
      <ul>
        {/* source: lane aac-font-preload (F411, Assets Art B-9; a feature); packages/brust/src/build/css.ts cssPlugin and docs/css.md "Preload a stylesheet font"; the types, the targets and the reason for not preloading every font are from the lane's READY note and docs */}
        <li>
          <strong>Importing a font or an image gives its served URL, so you can preload a stylesheet font.</strong> <code>import nunito from &apos;./fonts/nunito.woff2&apos;</code> is the string <code>/_brust/client/nunito-&lt;hash&gt;.woff2</code>, the same file and name that a <code>url()</code> of it in a stylesheet is rewritten to, so the file is shipped once. It works for every type brust serves from <code>client/</code>: <code>.woff2 .woff .ttf .otf .eot .png .jpg .jpeg .gif .webp .avif .svg .ico</code>. Put it in a layout as <code>&lt;link rel=&quot;preload&quot; as=&quot;font&quot; type=&quot;font/woff2&quot; crossOrigin=&quot;&quot; href={'{'}nunito{'}'} /&gt;</code> and it lands in <code>&lt;head&gt;</code>. The string is a build-time constant, so it works in a native component, in a React island, on the server, on Cloudflare Workers and in <code>--target static</code>; <code>@brust/core</code> now carries the TypeScript declarations for these imports. brust does not preload the stylesheet&rsquo;s fonts by itself, because a package such as <code>@fontsource-variable/nunito</code> has one file for each <code>unicode-range</code> subset and the browser should fetch only the subsets a page uses. See <a href="/docs/css#preload">Preload a stylesheet font</a>.
        </li>
        {/* source: PR #364 (F406, Assets Art B-6; pre-existing, the server HTML was right) */}
        <li>
          <strong>A list inside a list row in a native component works in the browser.</strong> In alpha.22 and earlier, the inner rows of <code>items.map(item =&gt; &lt;li&gt;{'{'}item.tags.map(…){'}'}&lt;/li&gt;)</code> had their text bound but were not a list. After the page loaded, every inner row was empty, rows were copied into the next outer row, and the console warned of a first-paint mismatch. The inner list is now a client list of its own, keyed by its own <code>key</code>, with the outer row&rsquo;s item in scope. It matches React on load, when you reorder it and when it reads the outer item.
        </li>
        {/* source: PR #365 (F407, Assets Art B-7; pre-existing); a real nested-instance is still an error and now names its cause */}
        <li>
          <strong>A lucide icon in a component under a condition no longer fails the build with <code>nested-instance</code>.</strong> <code>{'{'}post.interactive &amp;&amp; &lt;TryBadge /&gt;{'}'}</code>, where <code>TryBadge</code> holds an icon and no job, was refused with &ldquo;has a job&rdquo;. The first compile sees an icon as a server-rendered island, and icons become static SVG only in the final compile; the first compile&rsquo;s refusal is now a warning. A real <code>nested-instance</code> still stops the build, and its message names the cause, for example that <code>&lt;TryBadge&gt;</code> holds the server-rendered React island <code>&lt;Hand&gt;</code>, with its position.
        </li>
        {/* source: PR #366 (F408, Assets Art B-8; wrong output, pre-existing); crates/brust-compiler/src/lower/template.rs is where the break was written */}
        <li>
          <strong>No line break is written before a native component&rsquo;s root.</strong> In alpha.22 and earlier, brust wrote a line break before every native component&rsquo;s root, whatever the JSX around it, so <code>&lt;p&gt;the end.&lt;Mark /&gt; after&lt;/p&gt;</code> was built as <code>the end.</code>, a line break, then the element, and an inline native component showed a space before it. The break is gone, and JSX&rsquo;s whitespace rule applies at a native component as at any element: a line break between text and the component is dropped, and a space on the same line is kept. The HTML of a native component now equals what React&rsquo;s <code>renderToString</code> gives for its surroundings. The built <code>.jinja</code> templates also lose the line break after their header comment and after each <code>{'{'}% set %{'}'}</code> line of the preamble, so a test that pins their exact text sees the change.
        </li>
        {/* source: lane aac-island-box (F413, Assets Art B-11; pre-existing); crates/brust-compiler/src/lower/mod.rs island_host is the single emit site; the wording about CSS and exact-markup tests is the lead's instruction */}
        <li>
          <strong>A React island no longer adds a gap in a flex or grid row.</strong> In alpha.22 and earlier, <code>&lt;brust-island&gt;</code> was an element with a box, so in a row with <code>gap: 24px</code> an island that rendered nothing still counted as an item and added a second gap. Every <code>&lt;brust-island&gt;</code> now carries <code>style=&quot;display:contents&quot;</code>, as <code>&lt;brust-host&gt;</code>, <code>&lt;brust-row&gt;</code> and <code>&lt;brust-if&gt;</code> already did, so it takes no box and the layout matches the same page written with plain React. Check two things when you upgrade: CSS of yours that gave <code>brust-island</code> a box (a width, a margin, a border) no longer applies to it, and a test that compares the exact markup of an island sees the new attribute.
        </li>
      </ul>

      <h2 id="alpha-22">2.0.0-alpha.22 · 23 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.21 (git log --merges --first-parent v2.0.0-alpha.21..origin/main): #359 (F384), #360 (elysia-rc), #361 (F399, Assets Art B-5) and #362 (F288 phase A); nothing else is merged */}
      <p>Elysia moves from the 2 beta to the 2 release candidate, which is a breaking change for apps that use brust&rsquo;s actions. A <code>&lt;title&gt;</code>, <code>&lt;meta&gt;</code> or <code>&lt;link&gt;</code> rendered inside a page now goes into <code>&lt;head&gt;</code>, as in React 19, and the Radix <code>Presence</code> now compiles to native code.</p>

      <h3>Breaking</h3>
      <ul>
        {/* source: PR #360 (elysia-rc; requested by the human); the peer range, the install command, extension() and the top-level wire members are from the PR description and docs/actions.md */}
        <li>
          <strong>Actions now need Elysia 2 release candidate 0 (<code>2.0.0-rc.0</code>) instead of the beta.</strong> <code>@brust/core</code> lists <code>elysia</code> and <code>@elysia/eden</code> as optional peers at <code>^2.0.0-rc.0</code>, so install them with <code>bun add elysia@rc @elysia/eden@rc</code>; keep one copy of Elysia in the app, because <code>mountActions</code> checks <code>instanceof Elysia</code>. Two things change for your code. An <code>HTTPError</code> subclass now sets its extra members with an <code>extension()</code> method; the <code>detail()</code> method is gone. And extra members of an error response are now top-level in the response body (<code>body.max</code>, not <code>body.detail.max</code>). Elysia rc also requires <code>typebox</code>, <code>exact-mirror</code> and <code>openapi-types</code> as peers; bun installs them with the two packages, and with another package manager you add them yourself. The create-app template, the pokedex example and the docs are updated to the same version.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #361 (F399, Assets Art B-5; pre-existing, in alpha.21 and earlier); the React 19 order, the skipped cases, the link rule, the per-route title advice and F405 are from the PR description */}
        <li>
          <strong>A <code>&lt;title&gt;</code>, <code>&lt;meta&gt;</code> or <code>&lt;link&gt;</code> rendered inside a page now goes into <code>&lt;head&gt;</code>.</strong> In alpha.21 and earlier it stayed in <code>&lt;body&gt;</code>, so a route could not set its own title. brust now moves it as React 19 does, in the server&rsquo;s HTML, in the adapters and in a <code>--target static</code> build: the head&rsquo;s own elements first, then the moved ones in the order they were rendered. A <code>&lt;link&gt;</code> moves only when it has a <code>rel</code> other than <code>stylesheet</code> and a non-empty <code>href</code>. Elements inside <code>svg</code>, <code>math</code>, <code>template</code> or an island, elements with an <code>itemprop</code>, and elements that carry a client binding or sit in a conditional or list stay where they are rendered. To give each route its own title, drop the <code>&lt;title&gt;</code> from the layout&rsquo;s <code>&lt;head&gt;</code>, as in React. A title that changes in the browser is not handled yet (F405).
        </li>
        {/* source: PR #362 (F288 phase A); the Presence behaviour, the layout-effect order and the 106 B are from the PR description; collapsible is not yet native past Presence (next wall F382), so the entry says only what Presence does */}
        <li>
          <strong>Radix <code>Presence</code> now compiles to native code.</strong> Before, the content of a Collapsible was an island at <code>Presence</code>. brust now compiles the published <code>@radix-ui/react-presence</code> source, with React 19&rsquo;s behaviour, including holding the content in place until <code>animationend</code> when it closes. It needs React 19: with another major version the component renders with React. Collapsible as a whole is not native yet, and Tabs content is still an island.
        </li>
        {/* source: PR #362 (layout effects, amended ruling 94404307; runtime +147 B gzip, budget reason: core +168 / basics -21) */}
        <li>
          <strong><code>useLayoutEffect</code> now runs after the DOM bindings and before <code>useEffect</code>, as in React.</strong> When an update re-runs effects, the order is: the page&rsquo;s bindings, then layout effects, then passive effects. The runtime grows by 147 bytes gzipped in total.
        </li>
        {/* source: PR #362 (F403, pre-existing); the PR says the caller's ref stayed null */}
        <li>
          <strong>A ref passed to a native child now reaches the caller.</strong> The ref a caller put on a native child&rsquo;s host element was bound by the child itself, so the caller&rsquo;s <code>ref.current</code> stayed <code>null</code>. It now holds the element.
        </li>
        {/* source: PR #359 (F384, collapsible wall W10; pre-existing) */}
        <li>
          <strong>A conditional <code>{'{'}children{'}'}</code> inside a specialised component compiles.</strong> <code>{'{'}isOpen &amp;&amp; children{'}'}</code> or <code>cond ? children : null</code> in a component that brust specialises per call site (Radix&rsquo;s <code>CollapsibleContentImpl</code> is one) was refused with a message that named an empty value. It is now a conditional slot, and the refusal, where one remains, names the value.
        </li>
      </ul>

      <h2 id="alpha-21">2.0.0-alpha.21 · 23 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.20 (git log --merges --first-parent v2.0.0-alpha.20..origin/main): #353 (F332, tests and doc comments only: the compiler logic is unchanged, so no entry), #354 (F396), #355 (F392, F393), #356 (F394, F395) and #357 (F388): both listed here on the lead's ruling and both must be merged before the cut. F332 aside, the Assets Art issues were filed by the Assets Art team (B-1 to B-4) */}
      <p>A patch that starts from problems found while building a production site: every full page now starts with a doctype, small fonts and images in <code>url()</code> are copied instead of inlined, a prop named <code>req</code> compiles, build errors name the right file and component, and a child component in a native list row no longer throws on load. It also fixes a wrong output: a falsy number left of <code>&amp;&amp;</code> renders as React renders it.</p>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #355 (F392, Assets Art B-1; pre-existing, in alpha.20 and earlier); the check is in the shared render step, so the server, the adapters and a static build all get it */}
        <li>
          <strong>Every full page now starts with <code>&lt;!doctype html&gt;</code>.</strong> In alpha.20 and earlier, a root layout that returned <code>&lt;html&gt;</code> was sent without a doctype, because JSX cannot write one, and browsers rendered the page in quirks mode (<code>document.compatMode</code> was <code>BackCompat</code>), which changes table sizing, the line height of inline images and the height of <code>body</code>. A response whose first element, after whitespace and comments, is <code>&lt;html</code> and that has no doctype now gets one in front. It applies to <code>brust start</code>, to the adapters and to the pages <code>brust build --target static</code> writes. A page that already has a doctype, and a fragment, are unchanged.
        </li>
        {/* source: PR #355 (F393, Assets Art B-2; pre-existing, in alpha.20 and earlier); ?query and #fragment kept verbatim and an author-written data: URI left alone are from the PR description and its tests */}
        <li>
          <strong>A relative <code>url()</code> in a stylesheet is always copied, never inlined.</strong> In alpha.20 and earlier, a font or image under the bundler&rsquo;s size threshold became a <code>data:</code> URI in the CSS, so importing a package such as <code>@fontsource-variable/nunito</code> produced one large stylesheet that carried every subset, and the browser could not choose a subset by <code>unicode-range</code>. Every relative <code>url()</code> asset is now written as <code>client/&lt;name&gt;-&lt;hash&gt;.&lt;ext&gt;</code> at any size, with or without minification, and the URL is rewritten to it. A <code>?query</code> or <code>#fragment</code> on the URL (<code>?v=3</code>, <code>?#iefix</code>, an SVG font&rsquo;s <code>#id</code>) is kept. A <code>data:</code> URI you wrote yourself stays as written.
        </li>
        {/* source: PR #356 (F394, Assets Art B-3 part 1; pre-existing, in alpha.20 and earlier) */}
        <li>
          <strong>A component prop named <code>req</code>, <code>request</code>, <code>cookies</code> or <code>headers</code> now compiles.</strong> In alpha.20 and earlier, any such prop was refused with <code>request-state-in-render</code>, even for plain data such as <code>&lt;Count req=&quot;18,420&quot; /&gt;</code>. Request state is now judged by where the value comes from, not by the prop&rsquo;s name: only the props the router passes to a route component can carry it. A route page that reads <code>req</code> while rendering is still refused.
        </li>
        {/* source: PR #356 (F395, Assets Art B-3 part 2; pre-existing, in alpha.20 and earlier) */}
        <li>
          <strong>Build errors name the file and the component that cause them.</strong> In alpha.20 and earlier, an error raised inside a component imported from another file printed the page&rsquo;s file name with the other file&rsquo;s line and column, and <code>nested-instance</code> could name an unrelated sibling. Each error now names the file its line and column point into, and <code>nested-instance</code> names the component that has the job or <code>useId</code>.
        </li>
        {/* source: PR #354 (F396, Assets Art B-4; HIGH, pre-existing in every alpha with a row root of hidden={cond}; the server HTML was right); F397 (a literal hidden on a row root is lost on client-added rows) is open and not fixed here */}
        <li>
          <strong>A child component in a native list row no longer throws <code>TypeError</code> on load.</strong> In alpha.20 and earlier, a native list whose row root was <code>hidden={'{'}cond{'}'}</code> and held a child component logged <code>Cannot read properties of undefined</code> when the page loaded: the server&rsquo;s row was not adopted and was cloned again without its item. The server HTML was already right. The row now keeps the server&rsquo;s markup, the child receives its row&rsquo;s item, and clicking a button that changes <code>hidden</code> behaves as it does in React.
        </li>
        {/* source: PR #357 (F388, wrong output with no diagnostic, pre-existing in every alpha); the table/select fallback name and the JavaScript-disabled paint are from the PR description and its tests */}
        <li>
          <strong>A falsy number left of <code>&amp;&amp;</code> now renders as React renders it.</strong> In alpha.20 and earlier, <code>{'{'}n &amp;&amp; &lt;X /&gt;{'}'}</code> with <code>n = 0</code> rendered nothing where React renders <code>0</code>, with no error. When the left side is not provably a boolean, the value is now printed when it is falsy, both in the server&rsquo;s first paint (also with JavaScript disabled) and in the browser. A left side that is provably a boolean is unchanged. Inside a table or a <code>select</code>, where that markup is not allowed, a non-boolean left side is rendered with React and the build names the reason <code>and-falsy-in-table</code>.
        </li>
      </ul>

      <h2 id="alpha-20">2.0.0-alpha.20 · 17 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.19 (be29ef27): #348–#350 (f337-progress-live, toggle-group F329b, collapsible-flip F385); #346 (F329 part a) was merged before the alpha.19 tag, so it is listed under alpha.19; ledger-only commits have no entry */}
      <p>A native Radix Progress follows a changing value, and live values reach the elements of a native child&rsquo;s rest spread. Two HIGH wrong outputs are fixed: a first-click <code>ReferenceError</code> from a prop default, and an <code>undefined</code> argument in a custom hook&rsquo;s first paint.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #348 (F337 PR1); the shadcn wrapper (PR2) is not part of it: ledger F377 */}
        <li>
          <strong>A native Radix <code>Progress</code> root follows a changing <code>value</code>.</strong> A bare Radix Progress Root whose <code>value</code> changes in the browser compiles to native code, and the server and the browser paint the same for every kind of value (a non-integer, <code>-0</code>, a large number, <code>null</code> or <code>undefined</code>, a boolean). The shadcn <code>Progress</code> wrapper is not part of this change.
        </li>
        {/* source: PR #349 (F329 part b; part a is PR #346, shipped in alpha.19); measured: the served test presses one Item and checks the other Items' aria-checked and tabindex against React */}
        <li>
          <strong>Live values now reach the elements of a native child&rsquo;s rest spread.</strong> A value that changes at the call site and lands in a native child&rsquo;s <code>{'{'}...rest{'}'}</code> used to make the call site render with React. It now stays native: pressing one item of a roving group updates the other items&rsquo; <code>aria-checked</code> and <code>tabindex</code>, equal to React. <code>className</code>, <code>style</code>, event handlers, URL attributes, <code>value</code>, attributes with no known mapping, camelCase SVG attributes and list rows still render with React.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #348 (F376, HIGH, present in alpha.18 and alpha.19) */}
        <li>
          <strong>A prop default that names a module function no longer throws on the first click.</strong> In alpha.18 and alpha.19 the default was printed in the page&rsquo;s script without declaring what it reads, so a Radix <code>getValueLabel = defaultGetValueLabel</code> default gave a <code>ReferenceError</code> on the first click. The script now declares the module names and imports that prop defaults read.
        </li>
        {/* source: PR #350 (F385, HIGH, pre-existing; in alpha.19 and earlier; the example is the PR's repro) */}
        <li>
          <strong>A custom hook that takes an argument no longer paints the server&rsquo;s first paint with that argument <code>undefined</code>.</strong> In alpha.19 and earlier, a hook such as <code>function useLabel(n) {'{'} return &apos;L&apos; + n {'}'}</code> called as <code>useLabel(1)</code> rendered <code>title=&quot;Lundefined&quot;</code> where React renders <code>L1</code>, and a static attribute never recovers after hydration. The server template, the server job module and the page&rsquo;s script now order their values by what each one reads.
        </li>
      </ul>

      <h2 id="alpha-19">2.0.0-alpha.19 · 17 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.18: #335–#346 (#346 added to this list by the alpha.20 notes; host-specialise-f344, f362-projection PR1–PR2, toggle-group F363a/F364/F369a, clone-cache F371/F374, ledger-knock12, F356/F351; ledger-only and test-only PRs #336, #340 have no entry) */}
      <p>Rows that run in the browser ship only the fields they read from a module-level list, and a page whose derived value was read only by a ref or an effect no longer throws on load. <code>asChild</code> over a plain static component child, and through a static wrapper that passes its rest props on, compile to native code. Two wrong outputs from alpha.18 now render with React instead.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #339 (F362 PR1), PR #341 (F362 PR2); size from PR #339's fixtures; unrecognised uses ship the list whole, which is what alpha.18 did */}
        <li>
          <strong>Rows that run in the browser ship only the fields they read from a module-level list.</strong> The list is a <code>const</code> array of object literals with literal values, declared in the file or imported from a plain data file in the project. A field that no row cell, key, handler, ref initial value or effect dependency reads stays out of the page&rsquo;s scripts. The page chunk is 4 to 11% smaller on the test pages, and the saving grows with the unread fields. Any use brust does not recognise ships the list whole, as before.
        </li>
        {/* source: PR #342 (F363a, task toggle-group-f328) */}
        <li>
          <strong><code>asChild</code> over a static component child now compiles to native code when the child only takes the slot&rsquo;s props.</strong> The child must spread its props onto one host element, as a plain link component does in <code>&lt;XTrigger asChild&gt;&lt;Link href=&quot;/a&quot; /&gt;&lt;/XTrigger&gt;</code>. The child&rsquo;s own props win and <code>className</code> is joined, the slot&rsquo;s first, as Radix&rsquo;s <code>Slot</code> does. A child that brings a handler or a <code>style</code>, that has state of its own, that is itself polymorphic, or that does not spread its props onto its one element, or a parent whose replaced element carries a handler or a ref, still renders with React.
        </li>
        {/* source: PR #344 (F369a, ledger F369 part a) */}
        <li>
          <strong><code>asChild</code> now works through a static wrapper that hands its rest props to one polymorphic child.</strong> A static component that passes all its remaining props to one polymorphic child (for example a package leaf that spreads them into a <code>Primitive</code> element) now counts as polymorphic itself, so <code>asChild</code> at its call site is resolved at build time. A native component such as a Radix item still renders with React. A wrapper that gives that child children of its own, passes the rest to a second place, or spreads it at run time keeps rendering with React.
        </li>
        {/* source: PR #338 (F364) */}
        <li>
          <strong>A ref that nothing reads no longer forces a forwardRef call site to render with React.</strong> If a <code>useRef</code> value is only passed as <code>ref</code> to a static or native component, and that component never reads its forwarded ref, the ref is dropped. A child that reads it, composes it or passes it to something that reads it, or a spread in the props, keeps the React fallback.
        </li>
        {/* source: PR #343 (F133) */}
        <li>
          <strong><code>brust dev</code> no longer prints a <code>change detected</code> line when it starts.</strong> Before, the first build was reported as a change to the project folder. The line now appears only for a real edit, and it names the file.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #339 (F368, ledger row; HIGH, wrong output on valid React; present in alpha.18 and earlier: git log of lower/client.rs chunk roots) */}
        <li>
          <strong>A derived value that only a ref&rsquo;s initial value or an effect&rsquo;s dependencies read is now declared in the page&rsquo;s script.</strong> In alpha.18 and earlier the page threw <code>ReferenceError</code> on load for code such as <code>const first = ITEMS[0]?.name; const r = useRef(first)</code>, with <code>first</code> used nowhere else. Ref initial values and effect dependencies now count as roots, so the value is declared and the page loads.
        </li>
        {/* source: PR #345 (F371, HIGH, present in alpha.18 and earlier) */}
        <li>
          <strong>Content that reads a context provided inside a cloned component now gets the provided value.</strong> In alpha.18 and earlier, when a Provider sat inside a component that brust cloned for one call site, content reading that context got the default value instead. That call site now renders with React, so the output is correct.
        </li>
        {/* source: PR #345 (F374, HIGH, present in alpha.18 and earlier) */}
        <li>
          <strong>A component that spreads its rest props into a native Provider no longer loses its children.</strong> In alpha.18 and earlier the area the Provider renders its children in came out empty. That call site now renders with React and shows them. The same wrapper used with no children also renders with React (a spread may carry children brust cannot see).
        </li>
        {/* source: PR #335 (F344; many call sites pinned, spliced-offset guard; 156 B gzip per clone for identical sites, about 334 B for distinct sites: Dew's READY note on host-specialise-f344; ledger F359) */}
        <li>
          <strong>A page can use a copy of a child made for its host element at many call sites.</strong> Pages with 20 identical and with 20 distinct call sites are native, give the same bytes on every request and behave like React after each click. A copy costs about 156 B gzip when the sites are identical and about 330 B when they differ. Content spliced in from another module whose source position equals another call site&rsquo;s is refused by name.
        </li>
        {/* source: PR #337 (F356) */}
        <li>
          <strong>A written literal <code>undefined</code> for a Radix <code>__scope</code> prop no longer makes the page render with React.</strong> brust reads it as an absent value, the reading it already used elsewhere. Only the literal is exempt.
        </li>
        {/* source: PR #343 (F292) */}
        <li>
          <strong>An object built in a template ignores an own <code>__proto__</code> key, as <code>Object.assign</code> does.</strong> Before, a key with that name was copied as an ordinary key. No wrong output was known, because style printing dropped the key.
        </li>
        {/* source: PR #343 (F137) */}
        <li>
          <strong>The hover lift on the docs site&rsquo;s loader demo and benchmark cards now eases.</strong> The transition named <code>transform</code> while the lift moves the <code>translate</code> property, so it jumped. Both now transition <code>translate</code>.
        </li>
        {/* source: PR #346 (F329 part a; merged before the v2.0.0-alpha.19 tag but not listed when the alpha.19 notes were written) */}
        <li>
          <strong>A prop written after a spread of unknown keys now wins, as in React, and stays native.</strong> A function or live prop written after the last spread cannot be replaced by it, so the call site no longer renders with React for that reason. A key written twice, or between spreads, still renders with React. A <code>useMemo</code> that returns an array of plain values, as Radix <code>ToggleGroup</code> does, can now be a derived value of a native Provider.
        </li>
      </ul>

      <h2 id="alpha-18">2.0.0-alpha.18 · 17 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.17: #318–#331 (switch-provider-chain PR1–PR3, toggle-group F328, clone-carry F305/F306, F345, F340, F347, F290, F316; test and ledger-only PRs #319, #322, #323, #327, #330 have no entry) */}
      <p>The shadcn <code>Switch</code> page now compiles with no React and loads a tenth of the JavaScript. A few more Radix building blocks compile to native code, and two diagnostics are clearer.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #326 (switch-provider-chain PR1), PR #329 (PR2), PR #331 (PR3); docs/shadcn-coverage.md switch row (0 islands, 10 KiB gzip); before from PR #331's body (1 island, 89 KiB) */}
        <li>
          <strong>The shadcn <code>Switch</code> page compiles with no React.</strong> It was one React island with 89 KiB of JavaScript. It now has no island and 10 KiB, and it toggles the same way React does. Radix <code>Switch.Root</code> and <code>Switch.Thumb</code> compile to native code: the thumb&rsquo;s <code>data-state</code> and the root&rsquo;s <code>aria-checked</code> follow each toggle. A Radix render prop that is called with a local object now reads that object&rsquo;s members. A <code>Switch</code> in a list whose rows come from state renders with React (see Changes).
        </li>
        {/* source: PR #328 (toggle-group F328); the shadcn toggle-group page itself still renders with React (docs/shadcn-coverage.md) */}
        <li>
          <strong>Radix <code>RovingFocusGroup</code> (<code>Root</code>, <code>Impl</code> and <code>Item</code>) compiles to native code.</strong> <code>composeEventHandlers(user, handler)</code> from a package counts as a function prop, so these components no longer render with React because of &ldquo;render reads document&rdquo;. A <code>useId</code> inside a native child is fused into its native parent, and two siblings get different, stable ids. The shadcn toggle-group page still renders with React; other blockers remain. A page that uses such a child inside a list row renders with React.
        </li>
        {/* source: PR #320 (F305, F306) */}
        <li>
          <strong>Content that moves into a Provider&rsquo;s copy can read an import from the page&rsquo;s module.</strong> The shadcn wrapper&rsquo;s <code>className={'{'}cn(…){'}'}</code> is the example. A component imported from another package scope that is declared in the same module as the Provider (Radix <code>Switch.Thumb</code> beside <code>Switch.Root</code>) is read as the local one. A really foreign scope still renders with React.
        </li>
        {/* source: PR #318 (F340, F341); relaxes a refusal from alpha.17's progress page work */}
        <li>
          <strong>A <code>className</code> passed through <code>{'{'}...props{'}'}</code> no longer sends the page to React when the component also takes a function prop with a default.</strong> Only the function prop&rsquo;s own name is checked now, so <code>className={'{'}expr{'}'}</code> stays native.
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #321 (F345) */}
        <li>
          <strong>Props that a call site passes as constants stay fixed in every copy of a Provider.</strong> A copy made for the Provider, for children carried in its rest, or for a host element now pins the constant props its call site gives it, so a constant is no longer mistaken for a value that changes. The <code>Progress</code> page keeps 0 islands.
        </li>
        {/* source: PR #324 (F347) */}
        <li>
          <strong>A function prop is no longer assumed to travel through a path spread.</strong> <code>{'{'}...props.cfg{'}'}</code> delivers the members of <code>cfg</code>, not a prop named after the function, so the requirement that the caller may not pass a function now applies where the spread is written.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #331 (F358, ledger row; the wrong output needed PR #329, merged after v2.0.0-alpha.17, so no published version printed it: git merge-base, Dew's note on switch-provider-chain) */}
        <li>
          <strong>In a list built from state, a Radix-style root that spreads its rest renders with React when a row gives it a value.</strong> The case is a <code>Switch.Root</code>, or a component shaped like it, in <code>items.map(…)</code> over <code>useState</code> with a per-row <code>id</code>, <code>aria-label</code> or <code>data-*</code>. Compiled to native code, a row added in the browser showed the first row&rsquo;s value for those props. brust now refuses it by name (<code>frozen-prop</code>), so the page renders with React and shows each row&rsquo;s own value. No published version had this wrong output.
        </li>
        {/* source: PR #333 (F360; on main since PR #321, merged after the v2.0.0-alpha.17 tag, so no published version had it) */}
        <li>
          <strong>In a list built from state, a copy of a child made for its host element never keeps one row&rsquo;s value for another row.</strong> A row added in the browser could show the first row&rsquo;s value for a prop that differs per row. It was found and fixed before any release, so no published version printed it.
        </li>
        {/* source: PR #325 (F290, F316) */}
        <li>
          <strong>Two diagnostics are clearer.</strong> A diagnostic about a local that a custom hook creates names the variable you wrote and the hook it came from (<code>stylesRef</code>, from <code>usePresence</code>), not the generated name. The <code>snapshot-remount</code> hint lists every reason a component must mount once, not only the first.
        </li>
      </ul>

      <h2 id="alpha-17">2.0.0-alpha.17 · 17 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.16: #287–#316 (ledger rows F274, F276, F280, F282, F284–F287, F289, F293–F299, F304, F308, F309, F311, F318, F319, F324, F331, F333–F335; lanes roving-collection W1a–W1c, switch-native, presence-general, spread-live, carry-live, w1d-context-scope, w1d-root-type, specialise-children) */}
      <p>This version closes several cases where a compiled component showed stale or missing output, including a regression from 2.0.0-alpha.16, and it compiles more Radix patterns to native code, including the first shadcn page to move from a React island to static markup. Upgrade if you use a Provider that spreads its props or a component whose props change while the page is open.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #316 (progress-flip; READY notes @dd338fcd, ruling on callable props and prop-derived Provider members); docs/shadcn-coverage.md progress row (before: 1 island, 86 KiB gzip client JS; after: 0 islands, no client JS). The live member for a changing value is a follow-up. */}
        <li>
          <strong>The shadcn <code>Progress</code> page compiles with no React when its value is constant.</strong> It was one React island, about 86 KiB gzipped; it is now static markup with no client JavaScript, and its first paint equals React&rsquo;s. Radix Progress calls <code>getValueLabel</code>, a prop whose default is a plain function in its own module, while rendering, and brust now does the same when the call site passes none. The Provider&rsquo;s <code>value</code> and <code>max</code> are computed from the props through plain functions that return a string, number or boolean. A value that changes while the page is open (the animated demo) renders with React, and the output equals React&rsquo;s. A call site that passes its own function for <code>getValueLabel</code>, or forwards it through a spread, also renders with React.
        </li>
        {/* source: PR #288 (W1a); code: Radix's useId and useCallbackRef React-version checks */}
        <li>
          <strong>A context with a literal default value, and Radix&rsquo;s React-version checks in <code>useId</code> and <code>useCallbackRef</code>, compile.</strong> A context created with a literal default is read as that value. The check that picks the hook by React version is decided when brust builds, for React&rsquo;s own hooks only. A context declared in a hook module is read the same way.
        </li>
        {/* source: PR #292 (F284–F287) */}
        <li>
          <strong><code>useReducer</code>, arrow-function components, hooks inside a returned expression and <code>[literals].includes(x)</code> compile.</strong> <code>const X = (props) =&gt; {'{'}…{'}'}</code> is read like a function declaration. <code>useReducer</code> becomes a state value and one dispatch handler when the reducer is an inline function or a function in the same module that brust can prove has no side effects; otherwise the call site renders with React. An unconditional <code>useCallback</code>, <code>useMemo</code>, <code>useRef</code> or <code>useId</code> anywhere in the returned expression runs before it, in source order. <code>[&quot;a&quot;, &quot;b&quot;].includes(x)</code> on a literal array of at most 16 members compiles to a chain of equality tests.
        </li>
        {/* source: PR #294 (F296, F299); reviewed by Mellow */}
        <li>
          <strong>A live <code>style</code> or <code>className</code> passed through a component that spreads its props reaches the element.</strong> A parent that changes <code>style</code> or <code>className</code> on a wrapper that forwards <code>{'{'}...props{'}'}</code> no longer keeps the component from compiling. A wrapper that may render a <code>Slot</code> still renders with React, because a Slot merges both. The first paint of <code>style</code> matches react-dom: declarations in source order, React&rsquo;s unitless properties, and no attribute at all for an empty style.
        </li>
        {/* source: PR #295 (W1c, R34.140–R34.141) */}
        <li>
          <strong><code>@radix-ui/react-collection</code> 1.2.0 compiles to a small browser feature.</strong> brust recognises that exact version by the hash of its published file, so any other version, or a changed file, stays a React island. The items of a collection are the elements in the page, read when they are needed, so they are always current. Items inside an island or raw markup are left out, so a foreign widget never joins the focus order. The feature loads only on pages that use it.
        </li>
        {/* source: PR #297 (F304); reviewed by Mellow */}
        <li>
          <strong>A context field read inside an event handler or an effect compiles.</strong> <code>context.onItemActivate(…)</code> in a handler no longer sends the component to React. The context may appear only as a field read (<code>c.f</code>, <code>c?.f</code>, <code>c.f(…)</code>). Assigning through it, a computed key, destructuring it, or passing it on as a value still renders with React.
        </li>
        {/* source: PR #301 (W1d PR 2); reviewed by Mellow */}
        <li>
          <strong>Radix scoped context hooks compile.</strong> A context hook called with <code>props.__scope&lt;Name&gt;</code> is read from the scope that Radix&rsquo;s <code>createXScope()</code> made, identified by where it comes from and never by its name. Nested frames of the same name under a scope, and call sites whose scope brust cannot prove, render with React.
        </li>
        {/* source: PR #290 (W1b, R34.143, R34.144) */}
        <li>
          <strong><code>useIsHydrated</code> and a context destructured in the component body compile.</strong> <code>useSyncExternalStore(subscribe, () =&gt; true, () =&gt; false)</code> with an empty <code>subscribe</code> is <code>false</code> in the server HTML and in the first hydrated render, then <code>true</code> after mount, and the component&rsquo;s other effects see <code>false</code> first, as in React. <code>const {'{'} on, flip {'}'} = context</code> is read field by field. Every other <code>useSyncExternalStore</code> still renders with React.
        </li>
        {/* source: PR #308 (W1d PR 3) */}
        <li>
          <strong>Early-return chains compile.</strong> <code>if (a) return &lt;A /&gt;; if (b) return &lt;B /&gt;; …</code> becomes one nested conditional, and a <code>forwardRef</code> component with such a chain is read the same way.
        </li>
        {/* source: PR #291 (F293, F295) and PR #305 (F300) */}
        <li>
          <strong>A ref that nothing writes, seeded from a live value, is bound once per mount.</strong> Radix&rsquo;s hidden checkbox input (<code>useRef(checked)</code>) reaches the element through a forwarding spread, and <code>defaultChecked</code> or <code>defaultValue</code> are bound on the element so the first value equals React&rsquo;s. A component that mounts later than its parent, under a condition for example, is seeded from the parent&rsquo;s current props.
        </li>
        {/* source: PR #298 (F298) */}
        <li>
          <strong>Children passed to a component that spreads <code>...rest</code> are placed under the specialised Provider.</strong> The children can then read the Provider&rsquo;s context. This covers an unlinked static trigger; a native or linked trigger keeps rendering with React.
        </li>
        {/* source: PR #312 (W1d PR 4a, F326) */}
        <li>
          <strong>A local object that spreads the props can itself be spread onto a component.</strong> <code>const commonProps = {'{'} ...props, pressed {'}'}</code> followed by <code>&lt;Item {'{'}...commonProps{'}'} /&gt;</code> is read as the props spread plus the named entries, under the same rules as props written out. A local object that is reassigned or mutated, or that has an entry that is not a plain value, still renders with React.
        </li>
        {/* source: PR #313 (W1d PR 4b, F327) */}
        <li>
          <strong>A local object built from the rest props and used only as a spread compiles.</strong> <code>const commonProps = {'{'} role: &quot;group&quot;, dir, ...groupProps {'}'}</code>, where every use is <code>{'{'}...commonProps{'}'}</code> on a JSX element, is not read as a value. It is expanded where it is spread, and the children travel with the rest under the same rules as before.
        </li>
        {/* source: PR #316 (plan section 23 item 1, F324 real fix; battery row c-spec-rest-children, tests/server/spec-children.test.ts) */}
        <li>
          <strong>Children given to a Provider that spreads its rest are placed in the element that receives the rest.</strong> <code>&lt;Root&gt;&lt;span&gt;hello&lt;/span&gt;&lt;/Root&gt;</code>, with <code>Root</code> a Provider that writes <code>&lt;button {'{'}...rest{'}'} /&gt;</code>, compiles with <code>hello</code> inside the button and no React island. This holds when the rest is spread onto exactly one element and the Provider writes no children of its own; otherwise the call site renders with React.
        </li>
        {/* source: PR #315 (F307, host-specialise PR 1); cost range from the PR's measured pages */}
        <li>
          <strong>Slot content that uses the calling component&rsquo;s values, placed inside a child&rsquo;s root element, compiles with its own copy of the child.</strong> The content&rsquo;s bindings resolve to the caller, as in React, so <code>&lt;Label on={'{'}on{'}'}&gt;&lt;Thumb on={'{'}on{'}'} /&gt;&lt;/Label&gt;</code> stays live instead of rendering with React. Each such call site adds one clone of the child, measured at 193–396 bytes gzipped on the pages checked. Content that arrives through the child&rsquo;s <code>...rest</code> spread, and text-only content that cannot be proven equal to React&rsquo;s, still render with React.
        </li>
        {/* source: PR #289 (F297) */}
        <li>
          <strong>A condition on a state value whose server value is a known literal no longer needs a per-request computation.</strong> <code>const [control] = useState(null)</code> followed by <code>control ? control.closest(&quot;form&quot;) : true</code> compiles without the dead branch, while the browser still evaluates both branches live.
        </li>
        {/* source: PR #287 (F280) */}
        <li>
          <strong>A spread object may contain a conditional and calls of plain functions.</strong> A call of a function that brust has proven free of side effects, over plain reads, is read like a literal value.
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #302 (F324, fail closed) and PR #316 (F324 real fix, battery row c-spec-rest-children); regression since alpha.16 (PR #265, call-site specialisation) */}
        <li>
          <strong>A Provider that spreads its props no longer drops the children you pass it.</strong> In 2.0.0-alpha.16, <code>&lt;Root&gt;&lt;span&gt;hello&lt;/span&gt;&lt;/Root&gt;</code> printed an empty <code>&lt;button&gt;</code> when <code>Root</code> is a Provider that spreads its rest props onto the button. The children now show. When the rest is spread onto one element and the Provider writes no children of its own, the Provider stays native and the children are placed inside that element; in other cases the call site renders with React. If you used this pattern on alpha.16, upgrade.
        </li>
        {/* source: PR #300 (F319) and PR #304 (F320); the bug is present in every alpha since 2.0.0-alpha.1 (bisected on the published addons) */}
        <li>
          <strong>A prop that changes while the page is open no longer stays stale in a compiled component.</strong> The old value stayed in the rows of a list that is printed once, in a child component that brust does not link to its parent, and in a prop forwarded through a component&rsquo;s <code>{'{'}...props{'}'}</code> spread. It has been present since alpha.1 and printed no warning. A component with state, effects, handlers or refs now follows its changing props in all three places and stays native. For a component without state, and for <code>children</code> or the whole props object, a call site that passes a changing value (state, a store value or a function) renders with React; a constant is unaffected. A list whose source is an imported value or a module constant keeps that rule too.
        </li>
        {/* source: PR #293 (F309), then PR #315 (host-specialise makes the same example native) */}
        <li>
          <strong>Slot content inside a static child that is linked to its parent no longer keeps its first value.</strong> <code>&lt;Label on={'{'}on{'}'}&gt;&lt;Thumb on={'{'}on{'}'} /&gt;&lt;/Label&gt;</code> kept the first <code>Thumb</code> after <code>on</code> changed; the only sign was a console warning. This version first made such a call site render with React, and it now compiles with its own copy of the <code>Label</code> (see Slot content that uses the calling component&rsquo;s values, under New).
        </li>
        {/* source: PR #314 (F342); the bug was already on main before this version, from when it began is not measured */}
        <li>
          <strong>Slot content that reaches a child&rsquo;s element through the child&rsquo;s <code>...rest</code> spread no longer shows a stale or wrong value.</strong> A value of the calling component, used in content placed on the child&rsquo;s root element this way, stayed at its first value or was looked up on the child&rsquo;s instance, with no warning. Such a call site now renders with React.
        </li>
        {/* source: PR #309 (F289, F290) and PR #310 (F331) */}
        <li>
          <strong>A custom hook that returns an object with a handler no longer answers 500.</strong> <code>const t = useToggle()</code>, where the hook returns <code>{'{'} on, toggle {'}'}</code>, threw <code>ReferenceError: toggle_useToggle1 is not defined</code>. The object is now read member by member (<code>t.on</code>, <code>t.toggle</code>), as a destructuring is. A value the component computes from a handler a hook created, such as <code>{'{'} cb: t.toggle {'}'}</code> built per request, and a handler returned inside a computed result, render with React instead of answering 500. An object that holds the component&rsquo;s own arrow function or function declaration stays native.
        </li>
        {/* source: PR #296 (F282), PR #299 (F318), PR #311 (F333) */}
        <li>
          <strong>Objects keep JavaScript&rsquo;s key order.</strong> Keys were sorted in a style object handed to a React island, in an object read at request time (<code>Object.keys</code> and <code>Object.entries</code> over loader, job or store data), and in an object literal passed to a compiled child. <code>{'{'} marginTop: 5, margin: 0 {'}'}</code> printed <code>margin:0;margin-top:5px</code>, so the longhand won where React ends with <code>margin-top: 0</code>. The order now follows the source, and the first paint equals React&rsquo;s.
        </li>
        {/* source: PR #306 (F321, F322) */}
        <li>
          <strong>Two requests whose objects differ only in key order no longer share a cached render, and integer-like keys come first.</strong> The cache key sorted the keys, so a second request with the same keys in another order could be answered with the page printed in the first order. The cache key now includes the order when it matters. Keys such as <code>&quot;2&quot;</code> and <code>&quot;10&quot;</code> are listed first in ascending order, then the others in the order written, as JavaScript lists them.
        </li>
        {/* source: PR #296 (F311) */}
        <li>
          <strong><code>className</code> or <code>style</code> set to <code>undefined</code> or <code>null</code> leaves no attribute.</strong> The browser binder wrote <code>class=&quot;&quot;</code> and <code>style=&quot;&quot;</code>. An explicit <code>className=&quot;&quot;</code> keeps its empty class.
        </li>
        {/* source: PR #305 (F300, children-rest) */}
        <li>
          <strong>JSX children given to a component that passes its whole rest to a specialised Provider are no longer lost.</strong> They vanished, and an island child threw in a server job, which answered 500. Where the whole rest is handed to the Provider as data, those call sites render with React.
        </li>
        {/* source: PR #288 (W1a) */}
        <li>
          <strong>A prop named like a template word (<code>loop</code>, <code>range</code>) no longer collides.</strong> Radix&rsquo;s <code>loop</code> prop clashed with a name in the server template.
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #287 (F274, F276); reviewed by Mellow and Afrojack */}
        <li>
          <strong>The check for modules that write other modules at load time covers <code>[build] source_roots</code> and top-level calls.</strong> A write to another module from a file in a shared source root, or from a function the module calls at its top level (<code>function init() {'{'} B.x = 1 {'}'}; init()</code>), was missed. Both are now seen.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #303 (F308, F334) and PR #307 (F335); reviewed by Mellow and Afrojack */}
        <li>
          <strong>A <code>key</code> that changes, written outside a list, renders the component with React.</strong> React remounts the element when its key changes, which resets its state and effects; brust kept the instance. This covers a key written on an element or component, a call-site spread that may carry one (<code>{'{'}...{'{'} key: id {'}'}{'}'}</code>), and a path spread on a component tag (<code>{'{'}...props.cfg{'}'}</code>) that may carry one. A constant <code>key</code> and the keys of a list are unchanged. A spread on a plain HTML element stays as before, because React itself warns when a spread carries a key.
        </li>
        {/* source: PR #308 (W1d PR 3, render_error) */}
        <li>
          <strong>A literal <code>throw</code> in a compiled component answers 500, as React&rsquo;s server render does.</strong> The production response body carries no message; the server log does. Where the value that selects the throw is a literal at the call site, the throwing branch is dropped. A value that changes after mount renders with React.
        </li>
      </ul>

      <h2 id="alpha-16">2.0.0-alpha.16 · 16 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.15: #260–#285 (wave A 2c-1, 2c-2a, 2c-2b, 3a, 3b, S2; switch blockers F266/F269/F278/F279/F277; resolver F241–F245, F256, F272, F273; F205, F230, F232–F234, F147, F213, F223, F237, F248, F255; shadcn init F192/F193, F226–F228, F249, F251–F253, F261) */}
      <p>Relative imports are now confined to the app root, with a new setting for monorepos, and context Providers that hold state compile to native code. Several cases where the compiled JavaScript broke in the browser are fixed.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #265 (wave A PR 2c-2a, call-site specialisation) and PR #278 (F262, S2 hidden inputs) */}
        <li>
          <strong>A context Provider whose value holds state compiles to native code.</strong> A Provider built with <code>createContext</code>, <code>useState</code>, handlers and <code>useId</code> gets its own copy for each place it is used, so the components that read it bind to that copy, with no React island. The content you pass inside the Provider can read the calling component&rsquo;s props, state, locals and handlers. When brust cannot prove a case, the Provider stays a React island and the build prints <code>specialise-unsupported</code> with the reason; the rest of the page is unaffected.
        </li>
        {/* source: PR #270 (wave A PR 2c-2b, ruling Q5) */}
        <li>
          <strong><code>asChild</code> works on a component that reads the enclosing native Provider.</strong> In <code>&lt;CollapsibleTrigger asChild&gt;&lt;a /&gt;&lt;/CollapsibleTrigger&gt;</code>, the trigger&rsquo;s toggle handler, <code>aria-expanded</code> and <code>data-state</code> move onto the <code>&lt;a&gt;</code>, and the child&rsquo;s own props win, as in Radix&rsquo;s Slot. A handler written on the trigger or on the child, an <code>asChild</code> component outside any Provider, and a component child that spreads its props render with React.
        </li>
        {/* source: PR #263 (wave A PR 2c-1, R34.120); PR #268 (F235, F236) */}
        <li>
          <strong><code>useId()</code> inside an expression compiles.</strong> A call that runs on every render, such as <code>contentId={'{'}useId(){'}'}</code> in a JSX prop, now compiles. A call that runs only sometimes (a ternary branch, the right side of <code>&amp;&amp;</code>, <code>||</code>, <code>??</code> or <code>||=</code>, a <code>.map</code> callback, a nested function) or a call in a <code>key</code> renders with React.
        </li>
        {/* source: PRs #273 (F268), #276 (wave A PR 3a, B1–B5), #277 (PR 3b, B7), #281 (F266, F269), #282 (F278, F279), #285 (F277); docs/shadcn-coverage.md switch row unchanged */}
        <li>
          <strong>More of Radix&rsquo;s Switch compiles as written.</strong> Callback refs, render props, object spreads in values, an exported <code>useLayoutEffect</code> alias guarded by a <code>document</code> check, a spread of a local constant object into a Provider, Provider values derived from its state, and calls to module helpers that only return a plain value now compile, and state that nothing ever sets is read as a constant. The shadcn <code>switch</code> page itself does not change yet: it still loads one React island (89 KiB).
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #284 (F230, closes F219) */}
        <li>
          <strong>A value another module changes at load time renders like React.</strong> If one app module changed another module&rsquo;s exported object when it loaded (<code>LABELS.a = &quot;patched&quot;</code>), the page showed the declared value with no warning. Components that read such a value now render with React, and the output is the same as React&rsquo;s. Modules that only read the value stay compiled.
        </li>
        {/* source: PR #285 (F277) */}
        <li>
          <strong>A style object built from a parent&rsquo;s props stays up to date.</strong> A child element with <code>style={'{'}{'{'} ...props.style, k: v {'}'}{'}'}</code> or <code>Object.assign({'{'}{'}'}, ...)</code> could keep an old style after the parent changed. It now updates in the browser, and keys keep JavaScript&rsquo;s order, so in <code>{'{'} marginTop: 5, margin: 0 {'}'}</code> the later key wins, as in React. An element that appears later (under a condition or in a list) starts from the parent&rsquo;s current values.
        </li>
        {/* source: PR #272 (F233, F247, F257) */}
        <li>
          <strong>Components with names like brust&rsquo;s generated code work in the browser.</strong> A binding such as <code>signal</code>, <code>computed</code>, <code>props</code> or <code>_c1</code> clashed with a name brust generates, so the server page looked right but the component did nothing in the browser. Generated names now avoid every name the component uses.
        </li>
        {/* source: PR #267 (F147) */}
        <li>
          <strong>A variable named like a generated handler (<code>_h1</code>) no longer breaks the page.</strong> The wrong handler could run, or the JavaScript failed with a <code>SyntaxError</code>.
        </li>
        {/* source: PR #264 (F232) */}
        <li>
          <strong>A component variable named <code>a</code> works inside an event handler.</strong> The generated handler wrapper hid it (for example <code>const a = useRef(null)</code>).
        </li>
        {/* source: PR #264 (F234) */}
        <li>
          <strong>A prop you leave out takes its default.</strong> In a compiled child component, <code>{'{'} defaultOpen = false {'}'}</code> did not apply after hydration when the caller omitted <code>defaultOpen</code>, so an attribute such as <code>aria-expanded</code> disappeared. An omitted prop and an explicit <code>undefined</code> now take the default, as in React. An explicit <code>null</code> stays <code>null</code>.
        </li>
        {/* source: PR #265 (F248) */}
        <li>
          <strong>A context value used inside an effect or a handler no longer throws a <code>ReferenceError</code>.</strong> Such a component now renders with React.
        </li>
        {/* source: PR #268 (F237) and PR #283 (F255) */}
        <li>
          <strong>Hooks called in unusual ways no longer produce broken JavaScript.</strong> <code>(0, useId)()</code> and <code>(0, useState)(...)</code> compile as the hook. <code>useId.call(null)</code>, <code>.apply(...)</code> and any other use of a React hook that is not a direct call render with React.
        </li>
        {/* source: PR #264 (F223) */}
        <li>
          <strong>Cloudflare Worker builds resolve packages for Workers.</strong> The Worker bundle resolved packages with Bun&rsquo;s conditions instead of the <code>browser</code> and <code>workerd</code> ones, so it could pick the wrong build of a package.
        </li>
        {/* source: PR #269 (F244) */}
        <li>
          <strong>A package that imports <code>.</code> or <code>..</code> resolves to the directory&rsquo;s index file.</strong> It resolved to the package&rsquo;s own entry.
        </li>
        {/* source: PR #261 (F213) */}
        <li>
          <strong>Boolean attributes on custom elements match React.</strong> On a tag with a <code>-</code>, the server HTML and the browser now pass attributes through the way React does.
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #261 (F192, F193), #266 (F226–F228), #271 (F249, F251, F253), #275 (F261); reviewed by Mellow */}
        <li>
          <strong><code>brust shadcn init</code> checks where the shadcn CLI will write before it runs it.</strong> It reads the <code>components.json</code> aliases the way the CLI does, through the <code>tsconfig.json</code> <code>extends</code> chain, and refuses a target outside the project or behind a symbolic link. A registry URL item is fetched and checked the same way first, and resolver variables such as <code>TS_NODE_PROJECT</code> are removed from the CLI&rsquo;s environment. A URL item&rsquo;s <code>registryDependencies</code> and npm <code>dependencies</code> are not checked.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #269 (F243, behaviour change), #274 (F256), #283 (F272), #280 (F273); the Configuration page documents the key */}
        <li>
          <strong>Relative imports that leave the app root fail the build. Monorepos list shared directories in <code>[build] source_roots</code>.</strong> An import such as <code>../../shared/Button</code> now fails with <code>unresolved-import</code> (&ldquo;it leaves the app root&rdquo;). Add <code>source_roots = [&quot;../shared&quot;]</code> under <code>[build]</code> in <code>brust.toml</code>, and both the compiler and the bundler read that directory. An entry that is the app root or contains it (<code>.</code>, <code>..</code>) is refused: list the shared directory itself. <code>brust dev</code> rebuilds when a file in a listed directory changes. See <a href="/docs/configuration">Configuration</a>.
        </li>
        {/* source: PR #269 (F242) */}
        <li>
          <strong>The client and Cloudflare Worker bundles fail the build when brust cannot resolve a package import for the browser.</strong> Before, brust fell back to Bun&rsquo;s resolver, which could pick a Node-only build of the package. The <code>resolve-fallback</code> error names the import, the file that imports it and the reason. Builds for Bun keep the warning.
        </li>
        {/* source: PR #275 (F261) and #271 (F251); code: packages/brust/src/shadcn/init.ts resolveAlias */}
        <li>
          <strong><code>brust shadcn init</code> accepts only <code>@/...</code> and <code>~/...</code> aliases.</strong> Any other alias in <code>components.json</code>, including one shaped like a package name (<code>@scope/name</code>), is refused with the reason, because the shadcn CLI can resolve it to a workspace package instead of your <code>tsconfig.json</code> paths. Rename such aliases to <code>@/...</code> or <code>~/...</code>.
        </li>
        {/* source: PR #266 (F226), #271 (F252) */}
        <li>
          <strong>New dependency: <code>tsconfig-paths</code> 4.2.0</strong>, pinned exactly in <code>@brust/core</code>. It is the resolver the shadcn CLI uses, and only <code>brust shadcn</code> loads it.
        </li>
        {/* source: PR #262 */}
        <li>
          <strong>The pokedex template uses a global <code>app.css</code>, like the blank template.</strong> The layout imports <code>app.css</code> (Tailwind CSS v4), and brust builds it into one hashed stylesheet that each page links once. The prebuilt <code>public/app.css</code> and the step that regenerated it are gone, and <code>brust dev</code> swaps the stylesheet without a reload. The pages look the same.
        </li>
        {/* source: PR #260 (F205) */}
        <li>
          <strong>More children under plain wrappers compile again.</strong> Some children that rendered with React since alpha.14 compile again when brust can prove they are plain values: expressions over strings, numbers and booleans, fields of a module constant that is never changed, and calls to built-in methods that do not change their value.
        </li>
        {/* source: PR #265 (not in this PR: collapsible), ledger F229 (Presence); docs/shadcn-coverage.md collapsible row: react */}
        <li>
          <strong>The shadcn <code>collapsible</code> page still renders with React.</strong> Radix&rsquo;s <code>Presence</code> component, which mounts and unmounts the collapsible content, does not compile yet, so it stays a React island for now.
        </li>
      </ul>

      <h2 id="alpha-15">2.0.0-alpha.15 · 15 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.14: #253–#258 (F200/F203, F198/F199, F197, F214, F188/F189, F215/F219) */}
      <p>Four fixes for pages whose server HTML could differ from React, plus components from packages that compile in more places.</p>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #258 (F215, found by Mellow), allowlist + invariant ruled on the task */}
        <li>
          <strong>Code that runs when a module loads is no longer skipped on the server.</strong> If a component&rsquo;s file changed a value at the top level (<code>items.push(&quot;b&quot;)</code>, or a call that registers something), the server could render the value as it was before that line ran. Such a component now renders with React. Files that only declare values, components and functions are unaffected. Values wrapped in React&rsquo;s <code>forwardRef</code>, <code>memo</code> or <code>cache</code>, or in brust&rsquo;s <code>cache</code>, keep compiling.
        </li>
        {/* source: PR #256 (F214) */}
        <li>
          <strong>Children that show the parent&rsquo;s state update again.</strong> When a component passed children that read its own state to a child component that brust compiles to native code, the children did not update when the state changed. Such a component now renders with React.
        </li>
        {/* source: PR #254 (F198, F199) */}
        <li>
          <strong>Elements are no longer dropped from the server HTML.</strong> An element placed directly in a component&rsquo;s output, or an element passed as a prop, could be missing or wrong in the server-rendered page. brust now renders these itself only when it can prove the result, and otherwise renders with React.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #255 (F197) */}
        <li>
          <strong>Helpers imported from packages compile as children.</strong> A call such as <code>{'{'}formatDate(d){'}'}</code>, where <code>formatDate</code> comes from an npm package, compiles again when brust can prove from the package&rsquo;s source that the helper returns a string, number or boolean, including through re-exports in the package. In alpha.14 these rendered with React.
        </li>
        {/* source: PR #257 (F188, F189) */}
        <li>
          <strong>Package components that render as React islands use the package&rsquo;s published files.</strong> They were bundled from the package&rsquo;s source maps since alpha.12. The build now resolves packages with the same conditions as Bun&rsquo;s bundler, including production builds, and a context Provider and the components that read it always share one copy of the package.
        </li>
      </ul>

      <h2 id="alpha-14">2.0.0-alpha.14 · 15 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.13: #247–#251 (wave A 2b-hooks and 2b-handlers, F173/F190, F204, F201–F202, F206–F209) */}
      <p>The shadcn Toggle compiles to a static page, children that disappeared under plain wrappers render again, and attributes updated in the browser now match the server.</p>

      <h3>New</h3>
      <ul>
        {/* source: PR #250 (2b-handlers) and #247 (2b-hooks): Radix's own useControllableState and Toggle, compiled as written */}
        <li>
          <strong>The shadcn Toggle page is static: 87 KB → 5 KB of JavaScript, no React island.</strong> Radix&rsquo;s <code>useControllableState</code> hook and its <code>Toggle</code> now compile as written. When a component spreads its props onto an element and also sets values that change with state (<code>aria-pressed</code>, <code>data-state</code>) or an <code>onClick</code>, the parent binds them in the browser. Hooks that take an options object, call plain helper functions, use <code>useLayoutEffect</code> or <code>useInsertionEffect</code>, or log development-only warnings now compile too.
        </li>
      </ul>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #248 (F173, F190): plain wrappers on the total child predicate */}
        <li>
          <strong>Children of a plain wrapper no longer disappear.</strong> A child such as <code>{'{'}icons.home{'}'}</code>, <code>{'{'}list[0]{'}'}</code> or a call to an imported helper that returns JSX could render as nothing on the server. brust now renders a child itself only when it can prove the value is plain data, which still covers common cases such as <code>{'{'}price.toLocaleString(){'}'}</code> and <code>{'{'}new Date(d).toLocaleDateString(){'}'}</code>. Anything else renders with React.
        </li>
        {/* source: PR #250 (F206) */}
        <li>
          <strong><code>useRef(initialValue)</code> keeps its initial value</strong> in compiled components. It started as <code>undefined</code>, so an effect that compared against the previous value ran its change logic on mount.
        </li>
        {/* source: PR #251 (F201, F202) */}
        <li>
          <strong>Attributes updated in the browser match the server&rsquo;s HTML.</strong> Boolean and enumerated attributes such as <code>hidden</code>, <code>aria-*</code> and <code>data-*</code> follow the same table on both sides, and the safe-URL check now covers links inside SVG.
        </li>
        {/* source: PR #250 (F207, F208) */}
        <li>
          <strong>Two cases that broke the compiled JavaScript are fixed:</strong> reading the whole <code>props</code> object in a handler of a component that also spreads <code>...rest</code>, and a hook whose arguments are computed from other values.
        </li>
      </ul>

      <h3>Security</h3>
      <ul>
        {/* source: PR #249 (F204), reviewed by Mellow */}
        <li>
          <strong>Loader data cannot overwrite internal per-component values.</strong> A key returned by a loader with the shape of brust&rsquo;s per-instance data is dropped, as job results already were in alpha.13.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #248 (F197, F205) */}
        <li>
          <strong>Some children now render with React instead of being compiled:</strong> calls to helpers imported from packages, and method calls on state or list items that brust cannot prove are plain values. The output is the same.
        </li>
      </ul>

      <h2 id="alpha-13">2.0.0-alpha.13 · 15 October 2026</h2>
      {/* source: the pull requests merged after v2.0.0-alpha.12: #242–#245 (R42.2–R42.3, wave A PR 2a, F195–F196, F186–F187) */}
      <p>Fixes for attributes and event handlers that did not behave like React, plus internal hardening.</p>

      <h3>Fixed</h3>
      <ul>
        {/* source: PR #244 (F196, found by knock2 in the bubble-input spike); one classifier from React 19's table, checked against react-dom */}
        <li>
          <strong><code>aria-*</code> and <code>data-*</code> attributes set to <code>false</code> render like React.</strong> A dynamic <code>aria-pressed={'{'}false{'}'}</code>, <code>data-state</code> or another attribute that React prints as text was dropped from the HTML. It is now printed as <code>&quot;false&quot;</code>, on the server and when the value changes in the browser.
        </li>
        {/* source: PR #244 (F195) */}
        <li>
          <strong>Event handlers can call <code>isPropagationStopped()</code>.</strong> Compiled handlers receive the browser&rsquo;s event, which lacked the methods React adds. <code>event.isPropagationStopped()</code> threw a <code>TypeError</code>. The event now has React&rsquo;s <code>isPropagationStopped</code>, <code>isDefaultPrevented</code>, <code>persist</code>, <code>nativeEvent</code> and <code>isPersistent</code>.
        </li>
      </ul>

      <h3>Changes</h3>
      <ul>
        {/* source: PR #243 (wave A PR 2a): ctx_pkg fail-closed rule */}
        <li>
          <strong>The shadcn <code>select</code> page renders as a React page with one island</strong> (117 KB, was 118 KB), because more Radix package sources are now read for compilation (switch, checkbox, controllable state), and a context consumer from a package source inside an island keeps its caller in React.
        </li>
        {/* source: PR #242 (R42.3; R42.1 measured, not shipped) */}
        <li>
          <strong>The docs explain when islands become interactive.</strong> The time between the first paint and hydration equals a React server-rendered page, and islands keep loading right away by default. Preloading the React chunks was measured and not shipped: it made hydration slightly earlier but the first paint later on slow connections.
        </li>
        {/* source: PR #245 (F186, F187), reviewed by Mellow */}
        <li>
          <strong>Internal hardening.</strong> Server job modules can only be imported by the build&rsquo;s own job files, and job results live under a reserved prefix that loader data cannot overwrite.
        </li>
      </ul>

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
