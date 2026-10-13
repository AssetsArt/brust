// Cookbook: Invalidate the cache — a cached route tagged "team" and an action that drops the tag. The header sequence
// is a real run of this code (MISS, HIT, POST, MISS, HIT) on one process.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'
import Lead from '../../../components/docs/Lead'

const SRC = {
  route: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `{ path: '/pokemon/{name}', Component: PokemonPage, loader: pokemonLoader,
  cache: { ttl_seconds: 60, tags: ['pokemon', 'team'] } },`,
  },
  actions: {
    lang: 'ts',
    file: 'actions.ts',
    code: `import { cache } from '@brust/core'
import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'

const team: number[] = []
const MAX = 6

const app = new Elysia({ adapter: brust() })
  .get('/team', () => ({ team, max: MAX }))
  .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body }) => {
    if (team.length >= MAX) return problem(409, { title: 'TeamFull', max: MAX })
    if (!team.includes(body.id)) {
      team.push(body.id)
      cache.invalidate({ tags: ['team'] })
    }
    return { team, max: MAX }
  })

export default app
export type App = typeof app`,
  },
  run: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ curl -si http://127.0.0.1:1337/pokemon/pikachu | grep -i x-brust-cache
x-brust-cache: MISS
$ curl -si http://127.0.0.1:1337/pokemon/pikachu | grep -i x-brust-cache
x-brust-cache: HIT
$ curl -s -X POST http://127.0.0.1:1337/_brust/action/team -H 'content-type: application/json' -d '{"id":25}'
{"team":[25],"max":6}
$ curl -si http://127.0.0.1:1337/pokemon/pikachu | grep -i x-brust-cache
x-brust-cache: MISS
$ curl -si http://127.0.0.1:1337/pokemon/pikachu | grep -i x-brust-cache
x-brust-cache: HIT`,
  },
} satisfies Record<string, CodeBlockInput>

export interface InvalidateCacheData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function invalidateCacheLoader(): Promise<InvalidateCacheData> {
  return {
    toc: [
      { id: 'route', title: 'Cache the route and tag it' },
      { id: 'invalidate', title: 'Invalidate from an action' },
      { id: 'watch', title: 'Watch it work' },
      { id: 'more', title: 'More than one process' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as InvalidateCacheData['blocks'],
  }
}

export default function InvalidateCache({ blocks }: InvalidateCacheData) {
  return (
    <>
      <h1>Invalidate the cache</h1>
      <Lead>Cache a Pokémon page for a minute, then drop it the moment the team changes.</Lead>

      <Step n={1} id="route" title="Cache the route and tag it" />
      <p>
        A route with <code>cache</code> is stored in the page cache for <code>ttl_seconds</code>. Tags name the data a page shows, so one call can drop every page that shows it.
      </p>
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />

      <Step n={2} id="invalidate" title="Invalidate from an action" />
      <p>
        <code>cache.invalidate</code> takes tags, paths or keys. It clears this process at once. Call it only after a real change, so a no-op request does not empty the cache.
      </p>
      <CodeBlock code={blocks.actions.code} lang={blocks.actions.lang} file={blocks.actions.file} html={blocks.actions.html} />

      <Step n={3} id="watch" title="Watch it work" />
      <p>
        The <code>x-brust-cache</code> header shows what happened. The first request renders (<code>MISS</code>), the second is served from the cache (<code>HIT</code>), the action drops the tag, and the next request renders again.
      </p>
      <CodeBlock code={blocks.run.code} lang={blocks.run.lang} cwd={blocks.run.cwd} html={blocks.run.html} />

      <Step n={4} id="more" title="More than one process" />
      <p>
        <code>cache.invalidate</code> clears the cache of the process that ran it. With several processes, or on Cloudflare Workers where every isolate has its own cache, the others keep serving the old page until its TTL runs out unless you add a cache adapter that broadcasts the invalidation.
      </p>
      <Note>
        See <a href="/docs/cache-adapters/overview">Cache adapters</a> for the shared tier, and <a href="/docs/cloudflare/cache">Cache on KV and DO</a> for why Workers need it.
      </Note>
    </>
  )
}
