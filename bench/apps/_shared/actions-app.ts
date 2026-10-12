// bench/apps/_shared/actions-app.ts — the ONE Elysia 2 app of probes A1/A2, imported by both sides (brust's
// actions.ts and elysia-bun/index.ts), so the route code is byte-identical. Function handlers on purpose (R6): the Bun
// adapter would promote a value handler to a native static route that runs no JS per request. The counter sits in
// the handlers (not a hook) so the per-process balance check costs both sides the same.
import { Elysia, t } from 'elysia'
import data from './data.json'

let served = 0
export const servedCount = (): number => served

export function actionsApp(config: ConstructorParameters<typeof Elysia>[0] = {}) {
  return new Elysia(config)
    .get('/types', () => {
      served++
      return data.types
    })
    .post('/team', { body: t.Object({ id: t.Number() }) }, ({ body }) => {
      served++
      return { ok: true, id: body.id }
    })
}
