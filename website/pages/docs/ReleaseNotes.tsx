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
        {/* source: PR #302 (F324); regression since alpha.16 (PR #265, call-site specialisation) */}
        <li>
          <strong>A Provider that spreads its props no longer drops the children you pass it.</strong> In 2.0.0-alpha.16, <code>&lt;Root&gt;&lt;span&gt;hello&lt;/span&gt;&lt;/Root&gt;</code> printed an empty <code>&lt;button&gt;</code> when <code>Root</code> is a Provider that spreads its rest props onto the button. Such a call site now renders with React and shows the children. If you used this pattern on alpha.16, upgrade.
        </li>
        {/* source: PR #300 (F319) and PR #304 (F320); the bug is present in every alpha since 2.0.0-alpha.1 (bisected on the published addons) */}
        <li>
          <strong>A prop that changes while the page is open no longer stays stale in a compiled component.</strong> The old value stayed in the rows of a list that is printed once, in a child component that brust does not link to its parent, and in a prop forwarded through a component&rsquo;s <code>{'{'}...props{'}'}</code> spread. It has been present since alpha.1 and printed no warning. A component with state, effects, handlers or refs now follows its changing props in all three places and stays native. For a component without state, and for <code>children</code> or the whole props object, a call site that passes a changing value (state, a store value or a function) renders with React; a constant is unaffected. A list whose source is an imported value or a module constant keeps that rule too.
        </li>
        {/* source: PR #293 (F309) */}
        <li>
          <strong>Slot content inside a static child that is linked to its parent no longer keeps its first value.</strong> <code>&lt;Label on={'{'}on{'}'}&gt;&lt;Thumb on={'{'}on{'}'} /&gt;&lt;/Label&gt;</code> kept the first <code>Thumb</code> after <code>on</code> changed; the only sign was a console warning. The call site now renders with React.
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
          <strong>JSX children given to a component that passes its whole rest to a specialised Provider are no longer lost.</strong> They vanished, and an island child threw in a server job, which answered 500. Those call sites render with React.
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
