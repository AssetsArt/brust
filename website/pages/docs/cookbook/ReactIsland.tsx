// Cookbook: A React island — a component the compiler cannot make native (a custom hook) becomes a server-rendered
// React island. Build output and tiers are real (brust build on this exact code, then Chromium: typing "ee" shows eevee).
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
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
  component: {
    lang: 'tsx',
    file: 'components/PokemonFinder.tsx',
    code: `import { useState } from 'react'
import { POKEMON } from '../lib/pokemon'
import { useDebounced } from '../lib/useDebounced'

export default function PokemonFinder() {
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 200)
  const hits = POKEMON.filter((p) => p.name.includes(settled.toLowerCase()))
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
  build: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ brust build routes.tsx
warning hook-unsupported components/PokemonFinder.tsx:7:19 hook useDebounced is not supported
[brust] built dist in 68ms`,
  },
  manifest: {
    lang: 'text',
    file: 'dist/manifest.json (components, abridged)',
    code: `pokemonFinder_3e4f4a6c   tier: react   jobs: [ssr]   client: client/react-pokemonFinder_3e4f4a6c-95db304564.js`,
  },
} satisfies Record<string, CodeBlockInput>

export interface ReactIslandData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function reactIslandLoader(): Promise<ReactIslandData> {
  return {
    toc: [
      { id: 'hook', title: 'Write the hook' },
      { id: 'component', title: 'Use it in a component' },
      { id: 'build', title: 'Build and read the tier' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as ReactIslandData['blocks'],
  }
}

export default function ReactIsland({ blocks }: ReactIslandData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>A React island</h1>
      <p className="lead">
        When a component needs something the native tier cannot express, such as your own hook, brust keeps it as real React: rendered on the server, then hydrated in the browser.
      </p>

      <Step n={1} id="hook" title="Write the hook" />
      <p>A debounce hook: the value settles after a delay. It is an ordinary React hook.</p>
      <CodeBlock code={blocks.hook.code} lang={blocks.hook.lang} file={blocks.hook.file} html={blocks.hook.html} />

      <Step n={2} id="component" title="Use it in a component" />
      <p>The finder filters Pokémon by the debounced text. Add it to <code>routes.tsx</code> like any page:</p>
      <CodeBlock code={blocks.component.code} lang={blocks.component.lang} file={blocks.component.file} html={blocks.component.html} />
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />

      <Step n={3} id="build" title="Build and read the tier" />
      <p>
        The compiler does not know <code>useDebounced</code>, so it falls back to <span className="tier react">react</span> and says why. The manifest records one <code>ssr</code> job (the server render) and a client chunk (the island).
      </p>
      <CodeBlock code={blocks.build.code} lang={blocks.build.lang} cwd={blocks.build.cwd} html={blocks.build.html} />
      <CodeBlock code={blocks.manifest.code} lang={blocks.manifest.lang} file={blocks.manifest.file} html={blocks.manifest.html} />
      <p>
        In the browser, typing <code>ee</code> narrows the list to <code>eevee</code> after the 200 ms delay. The page works before hydration too: the first paint is the server-rendered list.
      </p>
      <Note>
        The warning is information, not an error. If the same component used only <code>useState</code> and handlers, it would be <span className="tier native">native</span> and ship no React. See <a href="/docs/rendering-tiers">Rendering tiers</a>.
      </Note>
    </section>
  )
}
