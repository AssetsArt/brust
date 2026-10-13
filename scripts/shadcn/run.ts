// Surveys the shadcn fixture and writes the deterministic scoreboard `docs/shadcn-coverage.md`.
//   bun scripts/shadcn/run.ts            regenerate the doc
//   bun scripts/shadcn/run.ts --check    same, without writing; exit 1 when the doc on disk is stale
//   bun scripts/shadcn/run.ts --sizes    also print the measured island bundle bytes per row (not part of the doc)
import { readFileSync, writeFileSync } from 'node:fs'
import { surveyApp, type AppRow } from './app.ts'
import { surveyLibs, type LibPackage } from './lib.ts'
import { REPORT } from './paths.ts'
import { renderReport } from './report.ts'

export function survey(): { rows: AppRow[]; libs: LibPackage[] } {
  return { rows: surveyApp(), libs: surveyLibs() }
}

if (import.meta.main) {
  const { rows, libs } = survey()
  const doc = renderReport(rows, libs)
  const check = process.argv.includes('--check')
  if (process.argv.includes('--sizes')) for (const r of rows) console.log(`${r.id}\t${r.bundleBytes ?? '—'}`)
  if (check) {
    const stale = readFileSync(REPORT, 'utf8') !== doc
    console.log(`[shadcn] ${rows.length} rows, ${libs.length} packages: docs/shadcn-coverage.md ${stale ? 'is STALE (run bun run shadcn)' : 'is current'}`)
    process.exit(stale ? 1 : 0)
  }
  writeFileSync(REPORT, doc)
  console.log(`[shadcn] ${rows.length} rows, ${libs.length} packages -> docs/shadcn-coverage.md`)
}
