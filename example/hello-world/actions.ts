import { defineActions } from '../../runtime/index.ts'
import { z } from 'zod'

/** Demo action used by the benchmark suite — exercises the full action
 * dispatch path (TCP → match_path → action envelope → tsfn → JS handler →
 * chunk channel → write). Wired into brust.run({ actions }) in index.ts.
 *
 * Wire: `POST /_brust/action/notes` with a JSON object body `{"text":"hi"}`.
 * Reach it from the client via `client<Actions>().notes.post({ text })`. */
export const actions = defineActions().post('/notes', () => ({ id: 'n-' + Date.now() }), {
  body: z.object({ text: z.string() }),
})

export type Actions = typeof actions
