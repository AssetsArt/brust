// The cache-prefix fixture: one cached route per docs example (lib/cache-examples.ts is the single source), each rendering how often its loader ran
// (per worker: the capture and the test start one worker). The page's transcripts are recorded from this app by scripts/capture-cache-prefix.ts.
import { defineRoutes } from '@brust/core/routes'
import { EXAMPLES, PROBES } from '../../../lib/cache-examples'
import Page from './Page'

const counters = new Map<string, number>()
const loader = (id: string) => (req: { params?: Record<string, string> }) => {
  const n = (counters.get(id) ?? 0) + 1
  counters.set(id, n)
  const p = req.params?.name
  return { label: p ? `${id} ${p}` : id, n }
}

const seen = new Set<string>()
export const routes = defineRoutes(
  [...EXAMPLES, ...PROBES]
    .filter((ex) => !seen.has(ex.route) && seen.add(ex.route))
    .map((ex) => ({ path: ex.route, Component: Page, loader: loader(ex.id), cache: ex.cache })),
)
