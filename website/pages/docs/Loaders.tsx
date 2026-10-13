// Loaders and params — the loader context, how results reach components, verdicts. This site is a static export
// (plan R7): the demo runs the page loader's lookup in the browser; the loader snippet stays the reference.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import LoaderDemo from '../../components/demos/LoaderDemo'
import { type Lookup, lookup } from '../../components/demos/loader-lookup'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Lead from '../../components/docs/Lead'

export interface LoadersData {
  toc: TocItem[]
  blocks: Record<'loader' | 'ctx' | 'page' | 'verdicts' | 'mine', CodeBlockData>
  demo: { initial: Lookup; names: string[] }
}

const LOADER = `import { type LoaderCtx, notFound } from '@brust/core/routes'
import { fetchPokemon } from './pokeapi'

export async function detailLoader({ params }: LoaderCtx<{ name: string }>) {
  const p = await fetchPokemon(params.name)
  if (!p) return notFound({ name: params.name })
  return { name: p.name, types: p.types, art: p.art }
}

// routes.tsx
{ path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader }`

const CTX = `interface LoaderCtx<P> {
  params: P        // decoded route params
  path: string     // the request path
  req: {
    method: string
    url: string
    headers: Record<string, string>
    cookies: Record<string, string>
    search: Record<string, string>   // query, url-decoded, + is a space
  }
}`

const PAGE = `export default function DetailPage({ name, types, art }) {
  return (
    <article>
      <img src={art} alt={name} />
      <h1>{name}</h1>
      <p>{types.join(' / ')}</p>
    </article>
  )
}`

const VERDICTS = `import { httpError, notFound, redirect } from '@brust/core/routes'

return notFound({ name })            // 404, renders this route's page with the data
return redirect('/pokedex', 308)     // Location header, nothing rendered (default 302)
httpError(429, 'slow down')          // throw-only: any 400-599 status and a body`

const MINE = `// pages/docs/Loaders.tsx on a brust server (this static site runs the lookup in the browser)
export async function loadersLoader({ req }: LoaderCtx): Promise<LoadersData> {
  const query = (req.search.pokemon ?? 'pikachu').trim().toLowerCase().slice(0, 30)
  const p = byName(query) // lib/pokemon.ts
  return { toc, blocks, demo: { query, found: p !== undefined, card: p ? cardOf(p) : unknownCard(query) } }
}`

const NAMES = ['pikachu', 'eevee', 'snorlax', 'mewtwo', 'agumon']

export async function loadersLoader(): Promise<LoadersData> {
  return {
    toc: [
      { id: 'write', title: 'Write a loader' },
      { id: 'ctx', title: 'What a loader gets' },
      { id: 'props', title: 'How the data reaches components' },
      { id: 'demo', title: 'Try a lookup' },
      { id: 'verdicts', title: 'Not found, redirect, errors' },
    ],
    blocks: {
      loader: codeBlock({ lang: 'ts', file: 'lib/loaders.ts', code: LOADER }),
      ctx: codeBlock({ lang: 'ts', file: '@brust/core/routes', code: CTX }),
      page: codeBlock({ lang: 'tsx', file: 'pages/DetailPage.tsx', code: PAGE }),
      verdicts: codeBlock({ lang: 'ts', file: 'lib/loaders.ts', code: VERDICTS }),
      mine: codeBlock({ lang: 'ts', file: 'pages/docs/Loaders.tsx', code: MINE }),
    },
    demo: { initial: lookup('pikachu'), names: NAMES },
  }
}

export default function Loaders({ blocks, demo }: LoadersData) {
  return (
    <>
      <h1>Loaders and params</h1>
      <Lead>A loader is an async function on a route. It runs in a Bun worker for each request, and what it returns becomes the props of the route's components.</Lead>

      <h2 id="write">Write a loader</h2>
      <CodeBlock code={blocks.loader.code} lang={blocks.loader.lang} file={blocks.loader.file} html={blocks.loader.html} />

      <h2 id="ctx">What a loader gets</h2>
      <CodeBlock code={blocks.ctx.code} lang={blocks.ctx.lang} file={blocks.ctx.file} html={blocks.ctx.html} />

      <h2 id="props">How the data reaches components</h2>
      <p>The page component receives the loader's object as its props:</p>
      <CodeBlock code={blocks.page.code} lang={blocks.page.lang} file={blocks.page.file} html={blocks.page.html} />
      <p>
        When layouts have loaders too, they run first, root to leaf, and their results are merged into one object that every component in the chain receives. A child's key wins over a parent's. A loader that returns nothing adds nothing.
      </p>
      <Note>
        The merge is flat, so name keys with care. On this site the layout loader returns <code>version</code> for the header; a page loader returning its own <code>version</code> would replace it on that page. Group page data under one key (this page uses <code>demo</code>).
      </Note>

      <h2 id="demo">Try a lookup</h2>
      <p>
        On a brust server, a loader like the one below reads <code>?pokemon=</code> from <code>req.search</code> and looks the name up in the site's Pokémon module, and the page is rendered again with the new data. This site is a static export, so the demo runs the same lookup in your browser and rewrites the address.
      </p>
      <LoaderDemo initial={demo.initial} names={demo.names} />
      <CodeBlock code={blocks.mine.code} lang={blocks.mine.lang} file={blocks.mine.file} html={blocks.mine.html} />
      <p>
        For a route param, open <code>/demo/pokemon/eevee</code>: its loader reads <code>params.name</code>, and on a brust server an unknown name such as <code>/demo/pokemon/agumon</code> returns <code>notFound()</code>. This site ships as static files and the route's cache rule reads the query string, so the static build leaves it out (<code>ssg: false</code>); run the docs locally with <code>bun run dev</code> to open it.
      </p>

      <h2 id="verdicts">Not found, redirect, errors</h2>
      <CodeBlock code={blocks.verdicts.code} lang={blocks.verdicts.lang} file={blocks.verdicts.file} html={blocks.verdicts.html} />
      <ul>
        <li>The first verdict stops the chain: loaders below it do not run.</li>
        <li>
          <code>notFound(data)</code> renders the route's own page with status 404, its data merged over the parent loaders' data.
        </li>
        <li>
          <code>httpError</code> takes a string body (plain text) or an object (JSON). A thrown <code>Error</code> is a 500, with the message in the server log.
        </li>
        <li>
          A response that carries <code>Set-Cookie</code> is never stored in the page cache.
        </li>
      </ul>
    </>
  )
}
