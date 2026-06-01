import { defineActions } from '../../../runtime/index.ts'
import { z } from 'zod'

/** Bench action — exercises the full server-action dispatch path (TCP →
 * match_path → action envelope → tsfn → JS handler → chunk channel → write).
 * The bench probe POSTs `{"text":"hi"}` to `/_brust/action/notes`; without a
 * registered action the path hits Rust's 404 short-circuit and reports a
 * misleading inflated RPS (see the 2026-05-29 honest-numbers fix). */
export const actions = defineActions().post('/notes', () => ({ id: 'n-' + Date.now() }), {
  body: z.object({ text: z.string() }),
})

export type Actions = typeof actions
