// Cookbook: A React island — a component that uses a React-only hook (useDeferredValue) becomes a server-rendered
// React island. Build output and tiers are real (brust build on this exact code at v2 @00e116c, 2026-10-13; then
// Chromium: typing "ee" shows eevee). A custom hook made of useState/useEffect is NOT a reason for an island any more
// (lane custom-hooks, F100): the compiler inlines it and the component stays native.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  component: {
    lang: 'tsx',
    file: 'components/PokemonFinder.tsx',
    code: `import { useDeferredValue, useState } from 'react'
import { POKEMON } from '../lib/pokemon'

export default function PokemonFinder() {
  const [q, setQ] = useState('')
  // the list filters on the deferred text, so typing never waits for the filter
  const deferred = useDeferredValue(q)
  const hits = POKEMON.filter((p) => p.name.includes(deferred.toLowerCase()))
  return (
    <section>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a Pokémon" />
      <ul>{hits.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
    </section>
  )
}`,
  },
  route: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `{ path: '/finder', Component: PokemonFinder },`,
  },
  // observed: brust build on this exact component (v2 @00e116c, 2026-10-13)
  build: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ brust build routes.tsx
warning hook-unsupported components/PokemonFinder.tsx:7:20 hook useDeferredValue is not supported
[brust] built dist in 178ms`,
  },
  // observed: dist/manifest.json of the same build
  manifest: {
    lang: 'text',
    file: 'dist/manifest.json (components, abridged)',
    code: `pokemonFinder_3e4f4a6c   tier: react   jobs: [ssr]   client: client/react-pokemonFinder_3e4f4a6c-d5dea8c523.js`,
  },
  // a custom hook made of supported hooks stays native: the compiler inlines it (F100)
  hook: {
    lang: 'ts',
    file: 'lib/useDebounced.ts',
    code: `import { useEffect, useState } from 'react'

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}`,
  },
} satisfies Record<string, CodeBlockInput>

export interface ReactIslandData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function reactIslandLoader(): Promise<ReactIslandData> {
  return {
    toc: [
      { id: 'component', title: 'Use a React-only hook' },
      { id: 'build', title: 'Build and read the tier' },
      { id: 'custom', title: 'Custom hooks stay native' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as ReactIslandData['blocks'],
  }
}

export default function ReactIsland({ blocks }: ReactIslandData) {
  return (
    <>
      <h1>A React island</h1>
      <p className="lead">
        When a component needs something the native tier cannot express, such as <code>useDeferredValue</code>, <code>useReducer</code> or a component from a package, brust keeps it as real React: rendered on the server, then hydrated in the browser.
      </p>

      <Step n={1} id="component" title="Use a React-only hook" />
      <p>
        The finder filters Pokémon by the deferred text: <code>useDeferredValue</code> lets React keep the input responsive while the list catches up. Add it to <code>routes.tsx</code> like any page:
      </p>
      <CodeBlock code={blocks.component.code} lang={blocks.component.lang} file={blocks.component.file} html={blocks.component.html} />
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />

      <Step n={2} id="build" title="Build and read the tier" />
      <p>
        The native tier has no <code>useDeferredValue</code>, so the compiler falls back to <span className="tier react">react</span> and says why. The manifest records one <code>ssr</code> job (the server render) and a client chunk (the island).
      </p>
      <CodeBlock code={blocks.build.code} lang={blocks.build.lang} cwd={blocks.build.cwd} html={blocks.build.html} />
      <CodeBlock code={blocks.manifest.code} lang={blocks.manifest.lang} file={blocks.manifest.file} html={blocks.manifest.html} />
      <p>
        In the browser, typing <code>ee</code> narrows the list to <code>eevee</code>. The page works before hydration too: the first paint is the server-rendered list.
      </p>
      <Note>
        The warning is information, not an error. The hooks that keep a component native and the ones that make it an island are listed under <a href="/docs/rendering-tiers#hooks">What decides the tier</a>.
      </Note>

      <Step n={3} id="custom" title="Custom hooks stay native" />
      <p>
        A hook you write yourself is not a reason for an island. If its body uses only hooks the native tier supports, the compiler inlines it into the component, which stays <span className="tier native">native</span> and ships no React. This debounce hook is one:
      </p>
      <CodeBlock code={blocks.hook.code} lang={blocks.hook.lang} file={blocks.hook.file} html={blocks.hook.html} />
      <p>
        The same finder written with <code>useDebounced(q, 200)</code> instead of <code>useDeferredValue</code> builds with no warning and a <code>client/</code> chunk of a few hundred bytes. The landing page's search box is exactly that pair: <a href="/#p-react">the react panel</a> uses <code>useDeferredValue</code>.
      </p>
    </>
  )
}
