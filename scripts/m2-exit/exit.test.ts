// scripts/m2-exit/exit.test.ts — M2 exit criteria (spec §10) checked by code.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EXIT_REPORT, gatherInputs } from './run.ts'
import { LEDGER_RANGE, MAY_BE_REFILED, MUST_BE_CLOSED, PROBES, ROUTES, renderExitReport } from './exit.ts'

const inputs = await gatherInputs()   // runs `brust build` on examples/pokedex (≈10 s)

test('the committed exit report equals a fresh render', () => {
  expect(readFileSync(EXIT_REPORT, 'utf8')).toBe(renderExitReport(inputs))
})
test('the manifest serves exactly the pinned routes, with the pinned tiers', () => {
  expect(inputs.manifest.routes.map((r) => r.pattern)).toEqual(ROUTES.map((r) => r.pattern))
  for (const r of ROUTES) {
    const m = inputs.manifest.routes.find((x) => x.pattern === r.pattern)!
    const leaf = inputs.manifest.components[m.chain[m.chain.length - 1]!]!
    expect([r.pattern, leaf.tier]).toEqual([r.pattern, r.leafTier])
  }
})
test('bench: every pinned probe is in RESULTS.json and the bar reads from the numbers, never from prose', () => {
  expect(inputs.bench.probes.map((p) => p.id)).toEqual(PROBES.map((p) => p.id))
  const measured = inputs.bench.probes.every((p) => p.x01 !== null)
  const met = measured && inputs.bench.probes.every((p) => p.v2.rps >= p.x01!.rps)
  expect(inputs.bench.bar).toBe(!measured ? 'not measured' : met ? 'met' : 'not met')
  expect(inputs.bench.bar).toBe('met')                      // the M2 exit criterion itself
})
test('ledger F32–F49: every row has a state; the closed set is pinned', () => {
  const ids = LEDGER_RANGE.map((n) => `F${n}`)
  expect(inputs.ledger.map((r) => r.id)).toEqual(ids)
  expect(inputs.ledger.filter((r) => r.state === 'closed').map((r) => r.id)).toEqual(MUST_BE_CLOSED)
  for (const r of inputs.ledger.filter((r) => r.state === 'open')) expect([r.id, r.owner.length > 0, MAY_BE_REFILED.includes(r.id) || !MUST_BE_CLOSED.includes(r.id)]).toEqual([r.id, true, true])
})
