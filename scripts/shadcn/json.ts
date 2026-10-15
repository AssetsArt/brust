// docs/shadcn-coverage.json: the numbers of docs/shadcn-coverage.md as data, for the docs site (website/pages/docs/Shadcn.tsx).
// Deterministic like the markdown (no clock, no host); client JS is gzip KiB (1024 bytes) rounded to 1 KiB (the `jsGzipKb` keys keep their name: the website page reads them), `0` exact for a page with none.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppRow } from './app.ts'
import type { LibPackage } from './lib.ts'
import { FIXTURE } from './paths.ts'
import { classify, rankBlockers } from './report.ts'

const kb = (n: number): number => (n === 0 ? 0 : Math.max(1, Math.round(n / 1024)))
const version = (pkg: string): string => {
  try { return JSON.parse(readFileSync(join(FIXTURE, 'node_modules', pkg, 'package.json'), 'utf8')).version } catch { return '?' }
}

export function coverageJson(rows: AppRow[], libs: LibPackage[]) {
  const lock = JSON.parse(readFileSync(join(FIXTURE, 'shadcn.lock.json'), 'utf8')) as { cli: string; registry: string; items: string }
  const built = rows.filter((r) => r.build.ok)
  const sorted = built.map((r) => (r.build.ok ? r.build.measured.jsGzip : 0)).sort((a, b) => a - b)
  const tiers = { static: 0, native: 0, react: 0 }
  for (const r of built) if (r.build.ok) tiers[r.build.measured.tier]++
  const comps = libs.flatMap((p) => p.components)
  const lt = (t: string) => comps.filter((c) => c.result.tier === t).length
  return {
    pinned: {
      shadcnCli: lock.cli,
      registry: lock.registry,
      items: lock.items.split(' ').length,
      react: version('react'),
      radixUi: version('radix-ui'),
      lucideReact: version('lucide-react'),
    },
    summary: {
      pages: rows.length,
      measured: built.length,
      analysisOnly: rows.length - built.length,
      tier: tiers,
      islands: built.reduce((n, r) => n + (r.build.ok ? r.build.measured.islands : 0), 0),
      pagesWithNoJs: sorted.filter((n) => n === 0).length,
      pagesWithNoWorker: built.filter((r) => r.build.ok && r.build.measured.workerCalls === 0).length,
      jsGzipKb: { min: kb(sorted[0] ?? 0), median: kb(sorted[Math.floor(sorted.length / 2)] ?? 0), max: kb(sorted.at(-1) ?? 0) },
      libraries: {
        packages: libs.length,
        components: comps.length,
        exported: comps.filter((c) => c.exported).length,
        static: lt('static'),
        native: lt('native'),
        react: lt('react'),
        unresolved: lt('unresolved'),
        error: lt('error'),
      },
    },
    blockers: rankBlockers(rows, libs).map((b) => ({
      blocker: b.key,
      kind: b.kind,
      classification: classify(b),
      measuredRows: b.measuredRows,
      analysisOnlyRows: b.analysisRows,
      appComponents: b.appComponents,
      libraryComponents: b.libComponents,
    })),
    rows: rows.map((r) =>
      r.build.ok
        ? { id: r.id, basis: 'measured', tier: r.build.measured.tier, islands: r.build.measured.islands, components: r.build.measured.components, reactComponents: r.build.measured.reactComponents, jsGzipKb: kb(r.build.measured.jsGzip), workerCalls: r.build.measured.workerCalls, codes: r.codes }
        : { id: r.id, basis: 'analysis-only', tier: r.error ? 'error' : r.tier, codes: r.codes, refusal: r.build.refusal ? { rule: r.build.refusal.rule, at: r.build.refusal.at, construct: r.build.refusal.construct } : null },
    ),
  }
}

export const renderJson = (rows: AppRow[], libs: LibPackage[]): string => `${JSON.stringify(coverageJson(rows, libs), null, 2)}\n`
