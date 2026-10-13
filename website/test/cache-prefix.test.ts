// website/test/cache-prefix.test.ts — the /docs/caching prefix examples are real: the recorded transcripts (lib/cache-transcripts.json) are what a
// `brust start` of the fixture app prints today, and lib/cache-key.ts (the page's playground) predicts the same MISS/HIT/BYPASS sequence for every example.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture } from '../scripts/capture-cache-prefix'
import { CAPTURE_ENV, EXAMPLES, type Example, PROBES, type Step } from '../lib/cache-examples'
import { decide, keyString } from '../lib/cache-key'

const committed = JSON.parse(readFileSync(join(import.meta.dir, '../lib/cache-transcripts.json'), 'utf8')) as { id: string; steps: { command: string; output: string; outcome: string }[] }[]

/** What the playground says for a step, with a cache that remembers the keys it stored. */
function simulate(ex: Example, stored: Set<string>, s: Step): string {
  const pairs = (c: string): [string, string][] => c.split(';').map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])
  const path = s.path ?? ex.path
  const host = s.headers?.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? '127.0.0.1'
  const params: [string, string][] = ex.route.includes('{name}') ? [['name', path.split('/').pop()!]] : []
  const d = decide(ex.cache, { url: s.query ? `${path}?${s.query}` : path, headers: (s.headers ?? []).filter(([k]) => k.toLowerCase() !== 'host'), cookies: s.cookies ? pairs(s.cookies) : [], params, host }, { env: CAPTURE_ENV })
  if (d.outcome === 'BYPASS') return 'BYPASS'
  const k = keyString(d.key)
  if (stored.has(k)) return 'HIT'
  stored.add(k)
  return 'MISS'
}

test('every example and probe is in the committed transcripts, in order, with the outcome the data expects', () => {
  expect(committed.map((t) => t.id)).toEqual([...EXAMPLES, ...PROBES].map((e) => e.id))
  for (const ex of [...EXAMPLES, ...PROBES]) {
    const t = committed.find((x) => x.id === ex.id)!
    expect(t.steps.map((s) => s.outcome)).toEqual(ex.steps.map((s) => s.expect))
    for (const s of t.steps) expect(s.output).toContain(`x-brust-cache: ${s.outcome}`)
  }
  expect(EXAMPLES.length).toBeGreaterThanOrEqual(5)
})

test('the playground port predicts the real server: MISS / HIT / BYPASS for every example', () => {
  // one cache per route (the probes share /ex/lang with example 1 only in the capture; here each starts empty, like a fresh process per route)
  for (const ex of [...EXAMPLES, ...PROBES]) {
    const stored = new Set<string>()
    const got = ex.steps.map((s) => simulate(ex, stored, s))
    expect([ex.id, got]).toEqual([ex.id, ex.steps.map((s) => s.expect)])
  }
})

test('re-running the capture against a real brust start reproduces the committed transcripts', async () => {
  const fresh = await capture()
  expect(fresh).toEqual(committed)
}, 240_000)
