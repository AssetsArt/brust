// website/components/landing/snippets.ts — every code block on the landing, built in the page loader (ruling dd484eca: a CodeBlock never highlights its own literal).
// The demo components' blocks are the real source files of components/landing/demos/*, so the code beside each live demo is the code that runs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../lib/highlight'

const here = import.meta.dir

/** A block whose source carries ①②③④ markers: the copied text drops them, the highlighted HTML turns them into the canon's numbered pins. */
function pinned(input: CodeBlockInput): CodeBlockData {
  const b = codeBlock(input)
  const pin = (s: string) => s.replace(/[①②③④]/g, '')
  return { ...b, code: pin(b.code), html: b.html.replace(/[①②③④]/g, (m) => `<span class="pin">${'①②③④'.indexOf(m) + 1}</span>`) }
}

const source = (file: string) => readFileSync(join(here, 'demos', file), 'utf8').trimEnd()

export interface LandingCode {
  create: CodeBlockData
  write: CodeBlockData
  run: CodeBlockData
  staticDemo: CodeBlockData
  nativeDemo: CodeBlockData
  reactDemo: CodeBlockData
  route: CodeBlockData
  invalidate: CodeBlockData
  actions: CodeBlockData
  client: CodeBlockData
  store: CodeBlockData
  teamCount: CodeBlockData
  selfHost: CodeBlockData
  workers: CodeBlockData
}

export function landingCode(): LandingCode {
  return {
    create: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun create @brust/app@latest my-app\n$ cd my-app && bun install' }),
    write: codeBlock({
      lang: 'tsx',
      file: 'pages/HomePage.tsx',
      code: 'export default function HomePage() {\n  return <h1>Hello from brust</h1>\n}',
    }),
    run: codeBlock({
      lang: 'sh',
      cwd: '~/my-app',
      code: '$ bun run dev\n[brust] built dist in 16ms\n[brust] listening on 127.0.0.1:1337 (io: hyper(tokio))\n[brust] ready (10 workers)',
    }),
    staticDemo: codeBlock({ lang: 'tsx', file: 'components/PokemonCard.tsx', code: source('PokemonCard.tsx') }),
    nativeDemo: codeBlock({ lang: 'tsx', file: 'components/CatchCard.tsx', code: source('CatchCard.tsx') }),
    reactDemo: codeBlock({ lang: 'tsx', file: 'components/PokemonSearch.tsx', code: source('PokemonSearch.tsx') }),
    route: pinned({
      lang: 'tsx',
      file: 'routes.tsx',
      code: "{\n  path: '/pokemon/{name}',①\n  Component: DetailPage,\n  loader: detailLoader,②\n  cache: { ttl_seconds: 60, tags: ['pokemon', 'team'] },③\n}",
    }),
    invalidate: pinned({
      lang: 'ts',
      file: 'actions.ts',
      code: "import { cache } from '@brust/core'\n\n// after the roster changes:\nawait cache.invalidate({ tags: ['team'] })④",
    }),
    actions: codeBlock({
      lang: 'ts',
      file: 'actions.ts',
      code: "import { brust } from '@brust/core/elysia'\nimport { Elysia, t } from 'elysia'\n\nconst app = new Elysia({ adapter: brust() })\n  .get('/hello', { query: t.Object({ name: t.String() }) },\n    ({ query }) => ({ message: `Hello, ${query.name}!` }))\n\nexport default app\nexport type App = typeof app",
    }),
    client: codeBlock({ lang: 'ts', file: 'in the browser', code: "const api = client<App>()\nconst { data } = await api.hello.get({ query: { name: 'ash' } })" }),
    store: codeBlock({
      lang: 'ts',
      file: 'stores/team.ts',
      code: "import { defineStore, signal } from '@brust/core/store'\n\nexport const team = defineStore('team', () => ({\n  members: signal([]),\n  max: signal(6),\n}))",
    }),
    teamCount: codeBlock({
      lang: 'tsx',
      file: 'components/TeamCount.tsx',
      code: "import { useStore } from '@brust/core/store/react'\nimport { team } from '../stores/team'\n\nexport default function TeamCount() {\n  const s = useStore(team)\n  return <span>{s.members.length} / {s.max}</span>\n}",
    }),
    selfHost: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ bun run build\n$ brust start --port 8080 --workers 4' }),
    workers: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ brust build routes.tsx --target cloudflare\n$ wrangler deploy -c dist/cf/wrangler.jsonc' }),
  }
}
