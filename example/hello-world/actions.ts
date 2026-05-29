'use server'
import type { BrustRequest } from '../../runtime/index.ts'

/** Demo action used by the benchmark suite — exercises the full action
 * dispatch path (TCP → match_path → action envelope → tsfn → JS handler →
 * chunk channel → write). NOT measured by tests/fixtures/app to keep the
 * scenario list minimal; this lives in example/hello-world so `bun run bench`
 * has a real registered action against example app instead of hitting the
 * 404 short-circuit that gave the misleading 111k RPS in earlier benches.
 *
 * Body shape (per oha bench): JSON array `["hi"]` — server-function positional args.
 */
export async function createNote(_req: BrustRequest, text: string): Promise<{ id: string }> {
  if (typeof text !== 'string') throw new Error('text must be a string')
  return { id: 'n-' + Date.now() }
}
