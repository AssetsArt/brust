'use server'
import type { BrustRequest } from '../../../runtime/index.ts'

/** Bench action — exercises the full server-function dispatch path (TCP →
 * match_path → action envelope → tsfn → JS handler → chunk channel → write).
 * The `/_brust/action/createNote` probe POSTs `["hi"]`; without a registered
 * action the path hits Rust's 404 short-circuit and reports a misleading
 * inflated RPS (see the 2026-05-29 honest-numbers fix). */
export async function createNote(_req: BrustRequest, text: string): Promise<{ id: string }> {
  if (typeof text !== 'string') throw new Error('text must be a string')
  return { id: 'n-' + Date.now() }
}
