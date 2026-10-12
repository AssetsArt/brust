// A 30-line Worker that exposes the D1 TeamDb over HTTP, so the Bun-side contract suite can drive real D1 (local workerd).
import { env } from 'cloudflare:workers'
import { openTeamDb } from '../../../examples/pokedex/lib/team-db.d1'

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      const d1 = (env as unknown as { TEAM_DB: D1Database }).TEAM_DB
      if (url.pathname === '/reset') {
        await d1.prepare('DELETE FROM team').run()
        return Response.json({ ok: true })
      }
      if (url.pathname === '/call' && req.method === 'POST') {
        const { op, args } = (await req.json()) as { op: 'list' | 'add' | 'remove'; args: unknown[] }
        const db = openTeamDb(d1) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return Response.json(await db[op]!(...args))
      }
      return new Response('not found', { status: 404 })
    } catch (e) {
      return new Response(String((e as Error)?.stack ?? e), { status: 500 })
    }
  },
}
