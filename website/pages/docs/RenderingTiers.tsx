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
  blocks: Record<'warning' | 'manifest', CodeBlockData>
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
      { id: 'runtime', title: 'What the browser loads' },
      { id: 'see', title: 'See what you got' },
    ],
    blocks: {
      warning: codeBlock({ lang: 'sh', cwd: '~/pokedex', code: '$ bun run build\nwarning hook-unsupported components/TeamBuilder.tsx:12:26 hook useReducer is not supported\nwarning hook-unsupported components/UnifiedIsland.tsx:11:25 hook useReducer is not supported\n[brust] built dist in 73ms' }),
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
            <td>Everything else: context, <code>useReducer</code>, <code>useDeferredValue</code>, <code>Suspense</code>, a component from a package, browser globals read during render.</td>
            <td>HTML rendered by React on the server, then a React island hydrates it.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The tier is decided per component, bottom-up. A React child inside a native parent becomes an island and the parent stays native, so one island never turns the whole page into React. A page made only of static components gets no <code>&lt;script&gt;</code> tag at all.
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
              <code>useState</code>, <code>useMemo</code>, <code>useCallback</code>, <code>useEffect</code>, <code>useLayoutEffect</code>, <code>useRef</code>, <code>useId</code>, <code>memo()</code>, event handlers, <code>useStore</code>, and a custom hook whose body uses only these (the compiler inlines it)
            </td>
            <td>
              <Tier t="native">native</Tier>
            </td>
          </tr>
          <tr>
            <td>
              <code>useReducer</code>, <code>useContext</code>, <code>useDeferredValue</code>, <code>useTransition</code>, <code>useSyncExternalStore</code>, <code>use(promise)</code>, <code>cloneElement</code>, <code>forwardRef</code> and other HOCs, spread props, <code>lazy</code>
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

      <h2 id="runtime">What the browser loads</h2>
      {/* source: packages/brust/src/build/features.ts:8-30 (the feature modules and the directive each binds), :41-54 (featuresOf: the set a template needs; an unbound directive is a build error), crates/brust-core/src/render.rs (modulepreload links), docs/plans/2026-10-14-runtime-split.md R35.1-R35.3 (L33, PR #201) */}
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
        The build works out the set for each component and the server links the modules of a route, preloaded in the page head. A static page with no island loads none of it. If a template uses a directive that no feature binds, the build stops with <code>runtime-feature-missing</code> instead of shipping a page that does nothing. Before, every page with a native component loaded the whole runtime (about 6 KB gzipped, <code>docs/plans/2026-10-14-runtime-split.md</code>).
      </p>

            <h2 id="see">See what you got</h2>
      <p>Every fallback is printed once per component by the build, with the rule and the line. This is the pokedex example's build:</p>
      <CodeBlock code={blocks.warning.code} lang={blocks.warning.lang} cwd={blocks.warning.cwd} html={blocks.warning.html} />
      <p>
        The full answer is in <code>dist/manifest.json</code>: each component has a <code>tier</code>, the <code>client</code> chunk it ships (<code>null</code> when nothing ships) and its server <code>jobs</code>.
      </p>
      <CodeBlock code={blocks.manifest.code} lang={blocks.manifest.lang} file={blocks.manifest.file} html={blocks.manifest.html} />
    </>
  )
}
