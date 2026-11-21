// Rendering tiers — static, native, react: what each ships, what decides it, how to see it. The three demos below are
// real components of this site, and their tiers are read from this build's dist/manifest.json by the loader.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import CatchCard from '../../components/landing/demos/CatchCard'
import PokemonCard from '../../components/landing/demos/PokemonCard'
import PokemonSearch from '../../components/landing/demos/PokemonSearch'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { artworkUrl, byId, dexNo, displayName, POKEMON, shinyUrl, spriteUrl } from '../../lib/pokemon'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'
import Tier from '../../components/docs/Tier'

interface Shipped {
  tier: string
  client: string
}

export interface RenderingTiersData {
  toc: TocItem[]
  blocks: Record<'warning' | 'manifest' | 'committed' | 'assert' | 'tierError' | 'snapshot', CodeBlockData>
  tiers: { card: Shipped; catch: Shipped; search: Shipped }
  cards: { no: string; name: string; art: string; types: string[] }[]
  catchMon: { no: string; name: string; type: string; art: string; shinyArt: string }
  all: { id: number; no: string; label: string; name: string; sprite: string }[]
}

let manifest: { components: Record<string, { tier: string; client: string | null }> } | undefined
function shipped(prefix: string): Shipped {
  try {
    manifest ??= JSON.parse(readFileSync(join(process.env.BRUST_DIST_DIR ?? join(process.cwd(), 'dist'), 'manifest.json'), 'utf8'))
  } catch {
    return { tier: 'unknown', client: 'manifest not found' }
  }
  const hit = Object.entries(manifest!.components).find(([id]) => id.startsWith(`${prefix}_`))
  if (!hit) return { tier: 'unknown', client: 'not in this build' }
  return { tier: hit[1].tier, client: hit[1].client ?? 'none' }
}

export async function renderingTiersLoader(): Promise<RenderingTiersData> {
  const mon = (id: number) => {
    const p = byId(id)!
    return { no: dexNo(id), name: displayName(p.name), art: artworkUrl(id), types: p.types }
  }
  const pika = byId(25)!
  return {
    toc: [
      { id: 'three', title: 'Three tiers' },
      { id: 'live', title: 'The three, live' },
      { id: 'hooks', title: 'What decides the tier' },
      { id: 'expressions', title: 'What the template prints, and what runs as a job' },
      { id: 'runtime', title: 'What the browser loads' },
      { id: 'committed', title: 'When an island is ready' },
      { id: 'see', title: 'See what you got' },
    ],
    blocks: {
      warning: codeBlock({ lang: 'sh', cwd: '~/pokedex', code: '$ bun run build\nwarning hook-unsupported components/TeamBuilder.tsx:12:3 hook useTransition is not supported\nwarning hook-unsupported components/UnifiedIsland.tsx:11:3 hook useTransition is not supported\n[brust] built dist in 73ms' }),
      committed: codeBlock({
        lang: 'ts',
        code: "function ready(island: Element, run: () => void) {\n  // committed before this code ran: the attribute says so, the event will not come again\n  if (island.getAttribute('data-committed') === '1') return run()\n  island.addEventListener('brust:island', run, { once: true })\n}\n\ndocument.addEventListener('brust:island', (e) => {\n  const { id, phase } = (e as CustomEvent<{ id: string; phase: 'committed' }>).detail\n  console.log(id, phase, e.target) // e.target is the <brust-island> host\n})",
      }),
      // illustrative: the [tiers] keys and the patterns follow packages/brust/test/tiers.test.ts (fixture packages/brust/test/fixtures/tiers); the file components/widgets/Map.tsx is an example, the fixture has components/widgets/Wide.tsx
      assert: codeBlock({ lang: 'toml', file: 'brust.toml', code: '[tiers]\nsnapshot = "tiers.json"\n\n[tiers.max]\n"components/views/**" = "static"\n"components/widgets/Map.tsx#default" = "react"' }),
      // observed: the error packages/brust/test/tiers.test.ts asserts on the fixture's components/views/Counter.tsx with "components/views/**" = "static"
      tierError: codeBlock({
        lang: 'sh',
        cwd: '~/my-app',
        code: '$ brust build\nerror tier components/views/Counter.tsx:4:1 Counter compiles to native; [tiers.max] "components/views/**" allows static\n  state `count` is set (line 4)\n  an event handler (line 6)',
      }),
      // illustrative: the shape of the file (version 1, sorted path#Export keys); components/widgets/Map.tsx is an example, not a file of the test fixture
      snapshot: codeBlock({
        lang: 'json',
        file: 'tiers.json',
        code: '{\n  "version": 1,\n  "components": {\n    "components/views/Badge.tsx#Badge": "static",\n    "components/views/Counter.tsx#default": "native",\n    "components/widgets/Map.tsx#default": "react"\n  }\n}',
      }),
      manifest: codeBlock({ lang: 'json', file: 'dist/manifest.json', code: '"pokemonSearch_<hash>": {\n  "tier": "react",\n  "client": "client/react-pokemonSearch_<hash>-<hash>.js",\n  "jobs": [{ "kind": "ssr", … }]\n}' }),
    },
    tiers: { card: shipped('pokemonCard'), catch: shipped('catchCard'), search: shipped('pokemonSearch') },
    cards: [mon(1), mon(4), mon(7)],
    catchMon: { no: dexNo(25), name: displayName(pika.name), type: pika.types[0]!, art: artworkUrl(25), shinyArt: shinyUrl(25) },
    all: POKEMON.map((p) => ({ id: p.id, no: dexNo(p.id), label: displayName(p.name), name: p.name, sprite: spriteUrl(p.id) })),
  }
}

export default function RenderingTiers({ blocks, tiers, cards, catchMon, all }: RenderingTiersData) {
  return (
    <>
      <h1>Rendering tiers</h1>
      <Lead>The compiler reads each component and picks the cheapest output that still behaves the same. You never pick it; you can always see what it picked.</Lead>

      <h2 id="three">Three tiers</h2>
      <table>
        <thead>
          <tr>
            <th>Tier</th>
            <th>When</th>
            <th>The browser gets</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Tier t="static">static</Tier>
            </td>
            <td>No hooks, no handlers, no refs. Props in, markup out.</td>
            <td>HTML only. No JavaScript.</td>
          </tr>
          <tr>
            <td>
              <Tier t="native">native</Tier>
            </td>
            <td>Only the supported hooks, and event handlers.</td>
            <td>HTML, plus a small React-free chunk: signals bound to the server's markup.</td>
          </tr>
          <tr>
            <td>
              <Tier t="react">react</Tier>
            </td>
            <td>Everything else: context, <code>useTransition</code>, <code>useDeferredValue</code>, <code>Suspense</code>, a component from a package, browser globals read during render.</td>
            <td>HTML rendered by React on the server, then a React island hydrates it.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The tier is decided per component, bottom-up. A React child inside a native parent becomes an island and the parent stays native, so one island never turns the whole page into React. A page made only of static components gets no <code>&lt;script&gt;</code> tag at all.
      </p>
      {/* source: crates/brust-compiler/src/analyze/passes/children.rs:4259 (fixed_call: a stateless child, every prop a value the client never changes there), :4304 (specialise_fixed: the clone is kept only when it is static) */}
      <p>
        It is also decided per call site. A component without state used by a page that has none either (say a <code>List</code> that maps the page&rsquo;s loader data to a <code>Hero</code> per row) is compiled once for every caller,
        and a caller could pass values that change, so on its own it may need the runtime for its rows, or React for a value it derives from a prop. Where a call site passes only fixed values (the page&rsquo;s loader data, literals, the rows of a
        list that never changes on the client), brust makes a copy of the component for that call site with every prop fixed, and that copy renders static: plain HTML, no script. The same component used from a component with state keeps its own tier.
        Nothing to write: the compiler proves it from the call site.
      </p>

      <h2 id="live">The three, live</h2>
      <p>These are the landing page's three demo components. The tier and the shipped chunk under each one come from this build's manifest, read by the page's loader.</p>
      <Frame title="PokemonCard" label={`tier ${tiers.card.tier} · client ${tiers.card.client}`}>
        <div className="grid grid-cols-3 gap-3 max-narrow:grid-cols-2">
          {cards.map((c) => (
            <PokemonCard key={c.no} no={c.no} name={c.name} art={c.art} types={c.types} />
          ))}
        </div>
      </Frame>
      <Frame bare title="CatchCard" label={`tier ${tiers.catch.tier} · client ${tiers.catch.client}`}>
        <CatchCard no={catchMon.no} name={catchMon.name} art={catchMon.art} shinyArt={catchMon.shinyArt} />
      </Frame>
      <Frame bare title="PokemonSearch" label={`tier ${tiers.search.tier} · client ${tiers.search.client}`}>
        <PokemonSearch all={all} />
      </Frame>

      <h2 id="hooks">What decides the tier</h2>
      <table>
        <thead>
          <tr>
            <th>You use</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Props only, or <code>useId</code></td>
            <td>
              <Tier t="static">static</Tier>
            </td>
          </tr>
          <tr>
            <td>
              <code>useState</code>, <code>useMemo</code>, <code>useCallback</code>, <code>useEffect</code>, <code>useLayoutEffect</code>, <code>useRef</code>, <code>useId</code>, <code>useReducer</code> (a state cell and one stable <code>dispatch</code>; the reducer must be a pure function, written inline or in the same module), <code>memo()</code>, event handlers, <code>useStore</code>, and a custom hook whose body uses only these, in the same module or an imported one (the compiler inlines it)
            </td>
            <td>
              <Tier t="native">native</Tier>
            </td>
          </tr>
          <tr>
            <td>
              <code>useContext</code>, <code>useDeferredValue</code>, <code>useTransition</code>, <code>useSyncExternalStore</code>, <code>use(promise)</code>, <code>cloneElement</code>, <code>forwardRef</code> and other HOCs, spread props, <code>lazy</code>
            </td>
            <td>
              <Tier t="react">react</Tier>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        In a native component, effect dependency arrays are not needed: signals track what an effect reads. A missing dependency still prints <code>effect-deps</code> as a warning, and the tier stays native.
      </p>
      <Note>
        Falling back to React is never a build failure, and that includes passing a function or a changing value to a React child (<code>island-prop</code>): the component that passes it renders with React. Some things are: server-only code reachable from the browser (<code>server-only-in-client</code>), and a list without keys (<code>list-key</code>).
      </Note>
      {/* source: crates/brust-compiler/src/analyze/passes/helpers.rs (local_arrows, arrows_of); crates/brust-compiler/tests/local_arrow_calls.rs (F560) */}
      <p>
        A small function you declare in the component and call in the markup does not cost the tier: for <code>const label = (n: number) =&gt; n + &apos; items&apos;</code>, the call <code>{'{'}label(count){'}'}</code> is compiled as the
        expression itself. This holds for an arrow whose body is one expression, called with arguments that contain no call. An arrow with a block body, or one that calls a method of an imported object, stays a function, and a value computed per request
        from it makes the component a React island (<code>client-function-in-job</code>).
      </p>
      {/* source: crates/brust-compiler/src/analyze/module_effects.rs (module_effect, Values::why, receiver_writes, plain_import_read), analyze/passes/mod.rs (module-side-effect);
          crates/brust-compiler/tests/module_effects.rs (F564: each accepted and refused form); tests/browser/cases/module-table-import.test.ts */}
      <p>
        <strong>Module-level code.</strong> The code brust compiles for a component copies the declarations of its module that it reads, not code that runs when the module loads. So a component that reads a value of its own module, or an import,
        keeps its tier only when that module provably runs nothing at load; otherwise it is a React island and the build says <code>module-side-effect</code>, naming the declaration and its line. Accepted at module scope: imports, types,
        functions and arrows that change no module value, and <code>const</code>s built from literals, other accepted constants, functions, template strings and operators, regex literals (without the <code>g</code> or <code>y</code> flag),{' '}
        <code>{'Array.from({ length: 24 }, (_, i) => `${i}:00`)'}</code> (a callback that builds a string or number), package calls, and reads of a table another module of your app exports: <code>{"{ icon: ICON.overview }"}</code> is
        accepted when <code>ICON</code> is <code>{'export const ICON = { … }'}</code> (an object or array literal, also through a re-export) with no getter, spread or computed key on the way to the value, and nothing changes it. A
        value read that way is not converted to a string or a number at load (<code>{'`${ICON.overview}`'}</code> is not accepted). Not accepted: a class, a <code>let</code> or <code>var</code> a function changes, a statement that runs at
        load, a call of your own function at load, a <code>const</code> read before it is declared. A function changes a module value when it assigns one, or calls <code>push</code>, <code>sort</code>, <code>delete</code> and the
        like on an object the module may own (a module constant, what a function of the module returns, or a value brust cannot name, such as the result of{' '}
        <code>{'(c ? a : b)(…)'}</code>); the same call on the result of an imported function (<code>{'api(id).delete(id)'}</code>) does not.
      </p>
      {/* source: crates/brust-compiler/src/analyze/passes/mod.rs (run_passes, react_request), children.rs (want_react, react_copy), pipeline.rs (an unused copy is left out); crates/brust-compiler/tests/nested_fed.rs (F560 tests) */}
      <p>
        The server runs the precomputed values of a component (a class built by a helper, a <code>useId</code>) for the route&apos;s page and layouts and for the components placed directly in them. A component with such a value placed inside
        another component that has one too is out of that reach. The outer component keeps its tier: at that place the inner one renders as a React island, a copy of it compiled for this purpose, and the build says so with a{' '}
        <code>nested-fed-child</code> warning on the inner component. Everywhere else the inner component keeps its own tier. Before 2.0.0-alpha.53 the outer component became the island (<code>nested-instance</code>), which it still does when the
        copy would not help, for example when the inner component is given a function.
      </p>
      {/* source: packages/brust/src/handlers.ts (toJson), tests/server/job-bigint.test.ts (F585) */}
      <p>
        A precomputed value travels from the worker to the server as JSON. A <code>bigint</code> is sent as its decimal digits, so text and attributes print what React prints; in a test the digits are a non-empty string, so{' '}
        <code>0n</code> counts as true there where JavaScript reads it as false. <code>NaN</code> and <code>Infinity</code> arrive as <code>null</code> and print nothing. A <code>bigint</code> in loader data is not converted: the page answers 500.
      </p>
      {/* source: crates/brust-compiler/src/analyze/passes/children.rs (nested-instance -> island-client-only), recursion.rs (islands_client_only), tests/server/rc-client-islands.chromium.test.ts (F548) */}
      <p>
        A React island with per-row props in nested lists, or in the rows of a component inlined into its callers, cannot be server-rendered row by row, so the component around it becomes one React island (<code>nested-instance</code>). Two cases cannot
        do that: a component that renders itself (a tree, compiled to one template macro) and one that holds a <code>{'<Dynamic>'}</code> slot (React cannot render it). There the island is <strong>client-only</strong> instead: the page prints its
        host with that row&apos;s props and nothing inside, the browser mounts it, the component keeps its tier, and the build says so with an <code>island-client-only</code> warning.
      </p>

      <h2 id="expressions">What the template prints, and what runs as a job</h2>
      {/* source: crates/brust-compiler/src/analyze/passes/server_expr.rs:6-17 (METHODS), :19-20 (MAX_RANGE), :26-62 (check: the node kinds), :64-117 (includes_chain: at most 16 members), :120-165 (call: Object.keys / entries / assign, Array.from, methods with literal arguments, join with a string literal), :168-172 (is_range), :175-182 (literal_only); crates/brust-compiler/src/ir/expr.rs:40-65 (BinOp, UnOp); crates/brust-compiler/src/analyze/passes/placement.rs:1550-1580 (Place::Server when the expression is in the subset, Place::Slot otherwise, Place::Code for a function, JSX or a browser value) */}
      <p>
        The compiler prints an expression into the page&rsquo;s template when it is in a small subset. It does not translate anything else: an expression outside the subset runs as your own JavaScript, in a server job, so its meaning cannot change. The
        price is a worker call: the jobs of a page go to the worker together (<code>jobs</code> in <code>dist/manifest.json</code>). A value that needs the browser, or a function, makes the component render with React instead.
      </p>
      <p>The template prints these, with no job:</p>
      <ul>
        <li>member reads and indexes with a literal key (<code>user.name</code>, <code>items[0]</code>);</li>
        <li>
          <code>!</code>, unary <code>-</code>, every binary operator (arithmetic, comparison, <code>&amp;&amp;</code>, <code>||</code>, <code>??</code>) and <code>?:</code>;
        </li>
        <li>template strings, and array and object literals;</li>
        <li>
          <code>Object.keys(x)</code>, <code>Object.entries(x)</code>, <code>{'Object.assign({}, a, b)'}</code> (which is what an object spread reads as) and <code>{'Array.from({ length: 3 })'}</code>, where the length is a literal number from 0 to 1024;
        </li>
        <li>
          <code>[&apos;a&apos;, &apos;b&apos;].includes(x)</code> on an array of literals with at most 16 members;
        </li>
        <li>
          these methods, with literal arguments only: <code>toUpperCase</code>, <code>toLowerCase</code>, <code>trim</code>, <code>slice</code>, <code>startsWith</code>, <code>endsWith</code>, <code>includes</code> and <code>join</code> (the separator is a string literal).
        </li>
      </ul>
      {/* source: crates/brust-compiler/src/analyze/passes/server_expr.rs (call: "method arguments must be literals" when an argument is not a literal, an array of literals or an object of literals; "join needs a string literal"), crates/brust-compiler/tests/server_expr.rs */}
      <p>
        The arguments of those methods must be literals. <code>s.slice(0, 3)</code> and <code>{"xs.join(', ')"}</code> are printed by the template; <code>s.slice(0, n)</code> and <code>xs.join(sep)</code>, with a name or any other expression as an argument, are not, and the call runs as a job.
      </p>
      <p>
        These run as a job instead, because they are outside the subset: <code>n.toLocaleString()</code>, <code>n.toPrecision(3)</code>, <code>s.padStart(6, &apos;*&apos;)</code>, <code>s.trimEnd()</code> and <code>new Date(x).toISOString()</code>. The output is the same as
        React&rsquo;s; the page costs a worker call.
      </p>
      {/* source: scripts/battery/ssr-compare.ts (header: the HTML the server paints for a native or static row is compared with React's renderToString), .github/workflows/ci.yml (bun scripts/battery/ssr-compare.ts --check); scripts/battery/rows.ts b-plain-wrapper-methods (jobs 1) */}
      <p>
        How this is checked: in CI, the HTML the server prints for every native and static row of the compiler&rsquo;s battery is compared with React&rsquo;s <code>renderToString</code> of the same source and props. A difference fails the build unless a list of known differences explains it.
      </p>

      <h2 id="runtime">What the browser loads</h2>
      {/* source: packages/brust/src/build/features.ts:8-30 (the feature modules and the directive each binds), :41-54 (featuresOf: the set a template needs; an unbound directive is a build error), crates/brust-core/src/render.rs (modulepreload links), runtime-split plan R35.1-R35.3 (L33, PR #201) */}
      <p>
        A native component or an island needs a small piece of JavaScript in the browser. It is not one file. The runtime is a core (signals, <code>mount</code>, the directive registry) plus feature modules, and a page loads the core and only the features its components use:
      </p>
      <ul>
        <li><code>basics</code>: <code>x-text</code>, <code>x-show</code>, <code>x-ref</code>, and the <code>x-bind-*</code> and <code>x-on-*</code> directives; nearly every native page needs it.</li>
        <li><code>if</code>, <code>for</code>, <code>model</code>, <code>html</code>: conditionals, lists, form models and raw HTML, each only for pages that use it.</li>
        <li><code>island</code>: the glue that hydrates React islands, only for pages that have one.</li>
        <li><code>store</code>: the shared store, only for pages whose components read one.</li>
      </ul>
      <p>
        The build works out the set for each component and the server links the modules of a route, preloaded in the page head. A static page with no island loads none of it. If a template uses a directive that no feature binds, the build stops with <code>runtime-feature-missing</code> instead of shipping a page that does nothing. Before, every page with a native component loaded the whole runtime (about 6 KB gzipped).
      </p>
      {/* source: crates/brust-core/src/render.rs (inject_document_assets_full_into, printed_hosts), packages/brust/src/build/manifest.ts (chunkHosts), crates/brust-compiler/src/analyze/const_fold.rs (load_clean), crates/brust-compiler/src/analyze/module_effects.rs (the load-time forms, F597), crates/brust-compiler/tests/load_clean.rs, tests/server/drawn-scripts.chromium.test.ts (F591; case 13 forms, F597; F599: module_effects.rs import_data and DATA_METHODS, use_scan.rs written_in_module, parse/mod.rs the loader by extension) */}
      <h3 id="drawn">Only the components the page drew</h3>
      <p>
        Each native component has its own chunk. A response carries the chunk of a native component only when the page it sends contains that component: the server looks for the component&rsquo;s element in the finished HTML before it writes the
        script tags. A page whose loader picks one widget out of six loads the chunk of that one. Markup the browser may still show later is part of the HTML too, so its chunks stay: the other branch of a condition over state or over a prop that
        can change, and the row of a list that is empty on the server (it is sent as a hidden template). A client-side navigation loads the chunks the next page lists before it swaps the page in.
      </p>
      <p>
        A chunk is always sent, as before, when it bundles an app module that runs code when it loads (a statement at the top level, a class, a constructor other than the ones below, a call that may run code the build cannot
        follow), so that code runs on every page of the route, as it would in React. A module that only builds its own values when it loads does not count: <code>new Set(…)</code> and <code>new Map(…)</code> of an array literal or of
        another such value, a spread of one (<code>{'[...BASE, x]'}</code>), <code>filter</code>, <code>map</code>, <code>flatMap</code>, <code>reduce</code> and the other array methods with an inline callback on such a value, a call of a
        function of the same module whose body only builds values, and a template of a string or number const imported from your own module. Plain data is one idea: an <code>export const</code> of one of your modules whose value is a literal of strings, numbers, booleans, <code>null</code>, arrays and plain objects (no function, no computed
        key, no spread), and which every module of the app only reads. Reading means <code>THEME.page.maxW</code>, <code>ROWS[0].label</code>, <code>ROWS.length</code>, <code>{"'named' in row"}</code>, a spread of it into an
        array or object literal, <code>for…of</code> over it, and a built-in method that takes no function (<code>find</code>, <code>filter</code>, <code>map</code>, <code>some</code>, <code>join</code>, <code>split</code>,
        <code>startsWith</code>, <code>padStart</code>, <code>replace</code> with two strings and the like) with the result only read the same way. Anything else makes it not data for every module: an assignment into it,
        <code>sort</code> or <code>push</code> on it, handing it or one of its objects to a function, returning it or one of its objects, storing one in another value (<code>{'{ list: ROWS }'}</code>, <code>const first = ROWS[0]</code>),
        <code>import()</code> of its module, a <code>import * as ns</code> object used other than as <code>ns.name</code>. A number or a string taken out of it may go anywhere. With plain data, reading it,
        spreading or copying the numbers and strings, arithmetic on it, <code>KEYS[key]</code> and <code>{'{ [key]: value }'}</code> with a plain key, and the string, number and array methods above build values too. Built-in
        prototypes are assumed unpatched.
        An imported value brust cannot read as plain data (a function result, an object that is not a
        literal) keeps the chunk. A function the module declares runs nothing until it is called and does not count, but handing one to a package call at load does (the package may run it then). Code outside the app root and its{' '}
        <code>[build] source_roots</code> (packages) is not checked: such a module imported only by components a page does not draw is not loaded on that page, and a package call your module makes at load with data only runs only on pages that carry the chunk. React
        islands, the runtime and its feature modules are linked as before. <code>[build] component_scripts = &quot;route&quot;</code> in <code>brust.toml</code> sends every chunk the route can draw, as earlier versions did (see{' '}
        <a href="/docs/configuration#other">Configuration</a>).
      </p>
      {/* source: packages/runtime-dom/src/island.ts (idle hydrate, IDLE_TIMEOUT_MS), hydration-timing plan §2.2 and ruling Q3, tests/server/hydration-timing.chromium.test.ts (R42.2, R42.3) */}
      <Note>
        Before an island hydrates, its server HTML is visible but not interactive. The island hydrates once its chunk has loaded and the browser is idle (waiting at most 250 ms for an idle moment). A click on an island&apos;s server HTML in that window is dropped, not replayed; the same control works on the next click. A React server-rendered page behaves the same way, because React attaches no listeners before <code>hydrateRoot</code>. On a slow connection the window is longer: in our measurements (slow 4G, a 4x slower CPU) it was about half a second, and with no throttling about 20 ms.
      </Note>

      {/* source: packages/runtime-dom/src/island.ts (hydrateHost, committed), packages/brust/src/build/bundle.ts (islandShim, __Commit), tests/server/island-committed.chromium.test.ts (F545) */}
      <h2 id="committed">When an island is ready</h2>
      <p>
        <code>data-hydrated=&quot;1&quot;</code> on a <code>&lt;brust-island&gt;</code> means its hydrate call has run, not that React has finished: <code>hydrateRoot</code> and <code>createRoot().render()</code> only schedule the render. Once the island&apos;s root has committed (its layout effects have run, its event handlers work), the host gets <code>data-committed=&quot;1&quot;</code> and dispatches a <code>brust:island</code> event that bubbles, with <code>detail: {'{'} id, phase: &apos;committed&apos; {'}'}</code>. <code>id</code> is the host&apos;s <code>data-id</code>. It fires once per host, for hydrated islands and <code>client_only</code> ones alike, after <code>data-hydrated</code>, and never for a host that left the page first.
      </p>
      <p>
        The signal covers the island&apos;s root, not every <code>&lt;Suspense&gt;</code> boundary inside it: React may hydrate the content of an inner boundary after the root commits, and that later hydration sends no event.
      </p>
      <p>Code that may run after the event checks the attribute first:</p>
      <CodeBlock code={blocks.committed.code} lang={blocks.committed.lang} html={blocks.committed.html} />

            <h2 id="see">See what you got</h2>
      <p>Every fallback is printed once per component by the build, with the rule and the line. This is the pokedex example's build:</p>
      <CodeBlock code={blocks.warning.code} lang={blocks.warning.lang} cwd={blocks.warning.cwd} html={blocks.warning.html} />
      <p>
        The full answer is in <code>dist/manifest.json</code>: each component has a <code>tier</code>, the <code>client</code> chunk it ships (<code>null</code> when nothing ships) and its server <code>jobs</code>.
      </p>
      <CodeBlock code={blocks.manifest.code} lang={blocks.manifest.lang} file={blocks.manifest.file} html={blocks.manifest.html} />

      {/* source: packages/brust/src/build/tiers.ts (checkTiers: [tiers.max] over every app component, clones and React copies under their component; reportTiers: one error rule `tier`), crates/brust-compiler/src/analyze/passes/tier.rs native_because (the native lines, at most 8) */}
      <h3 id="assert">Assert a tier</h3>
      <p>
        A warning is easy to miss, and a component&rsquo;s tier can change with an ordinary edit. To make the build fail instead, say in <code>brust.toml</code> how heavy each part of the app may get (the keys are in{' '}
        <a href="/docs/configuration#tiers">Configuration</a>):
      </p>
      <CodeBlock code={blocks.assert.code} lang={blocks.assert.lang} file={blocks.assert.file} html={blocks.assert.html} />
      <p>
        A component that compiles heavier than its pattern allows stops <code>brust build</code> with one <code>tier</code> error that lists every such component. Each starts with the file, line and name, then the reasons:
        for <code>react</code>, every fallback rule with its message and the fix; for <code>native</code> where <code>static</code> is required, what makes it interactive (state that is set, an event handler, an effect, a
        ref, a store read), with lines.
      </p>
      <CodeBlock code={blocks.tierError.code} lang={blocks.tierError.lang} cwd={blocks.tierError.cwd} html={blocks.tierError.html} />
      <p>
        The compiler may make a copy of a component for some call sites (a React copy where the server cannot render it inside its parent). A copy is checked against its component&rsquo;s pattern, and the error says which
        component places it. <code>brust dev</code> prints these as <code>warning tier</code> lines and keeps running.
      </p>
      {/* source: packages/brust/src/build/index.ts (compileApp throws a compile error before checkTiers runs: "the final compile against [tiers]"); packages/brust/test/tiers.test.ts (a build error, list-key, stops the build before [tiers.max] is read) */}
      <p>
        The check runs after the compile has succeeded. A build error, such as <code>list-key</code> for a list whose items have no <code>key</code>, stops the build first and is the only thing printed. <code>[tiers.max]</code> guards a tier that changes,
        not code that does not build.
      </p>
      {/* source: packages/brust/src/build/tiers.ts (checkTiers: the snapshot; writeTierSnapshot runs after the build succeeded; never in dev), packages/brust/test/tiers.test.ts (written, unchanged, heavier, lighter, --update-tiers) */}
      <h3 id="snapshot">Keep a tier snapshot</h3>
      <p>
        <code>[tiers] snapshot</code> names a file that records every component&rsquo;s tier. Commit it. The first build writes it (<code>tiers: wrote tiers.json (… components)</code>); every later build compares:
      </p>
      <ul>
        <li>a component heavier than the file records fails the build, with the same reasons as above (<code>… compiles to native; tiers.json records static</code>);</li>
        <li>
          a lighter, new or removed component prints one line (<code>tiers: components/views/Card.tsx#default native -&gt; static</code>), and the file is left as it is;
        </li>
        <li>
          when the change is wanted, <code>brust build --update-tiers</code> rewrites the file and prints each difference; review it like any other diff.
        </li>
      </ul>
      <CodeBlock code={blocks.snapshot.code} lang={blocks.snapshot.lang} file={blocks.snapshot.file} html={blocks.snapshot.html} />
      <p>
        The snapshot lists the components of your app&rsquo;s source, one entry per component, keyed <code>path#Export</code>. The copies the compiler makes for single call sites are checked against <code>[tiers.max]</code> but are not listed. Components
        compiled at run time with <code>compileComponent</code> (see <a href="/docs/runtime-components#compile">Runtime components</a>) are outside the check, which runs in <code>brust build</code>. <code>brust dev</code> never writes the file.
      </p>
      {/* source: packages/brust/src/build/tiers.ts (tierKey: relPosix(appRoot, file); ruleFor matches the same path), packages/brust/test/tiers.test.ts (a source_roots component keys as ../shared/Stateful.tsx#Stateful in the snapshot and matches "../shared/**") */}
      <p>
        A component in a directory you list in <code>[build] source_roots</code> outside the app is keyed by its path from the app root, which starts with <code>../</code>: <code>{'"../shared/Stateful.tsx#Stateful"'}</code> in the snapshot, and a pattern such as{' '}
        <code>{'"../shared/**"'}</code> in <code>[tiers.max]</code>.
      </p>
    </>
  )
}
