// Surveys the shadcn fixture and writes the deterministic scoreboard `docs/shadcn-coverage.md`.
//   bun scripts/shadcn/run.ts            regenerate the doc
//   bun scripts/shadcn/run.ts --check    same, without writing; exit 1 when the doc on disk is stale
// Every run also writes tests/fixtures/shadcn/.rows/shadcn-sizes.json: exact raw + gzip client JS per built page (git-ignored; CI uploads it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { surveyApp, surveyRepro, type AppRow, type Repro } from './app.ts'
import { surveyLibs, type LibPackage } from './lib.ts'
import { FIXTURE, REPORT, REPORT_JSON } from './paths.ts'
import { renderJson } from './json.ts'
import { renderReport } from './report.ts'

export const SIZES = join(FIXTURE, '.rows/shadcn-sizes.json')

/** The exact numbers the doc rounds: per page, raw and gzip bytes of each client JS file it loads. */
export function writeSizes(rows: AppRow[]): void {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  const pages = rows.map((r) => (r.build.ok ? { id: r.id, built: true, raw: r.build.measured.jsRaw, gzip: r.build.measured.jsGzip, files: r.build.measured.files } : { id: r.id, built: false }))
  writeFileSync(SIZES, `${JSON.stringify({ bun: Bun.version, unit: 'bytes', pages }, null, 2)}\n`)
}

export function survey(): { rows: AppRow[]; libs: LibPackage[]; repro: Repro[] } {
  const rows = surveyApp()
  writeSizes(rows)
  return { rows, libs: surveyLibs(), repro: surveyRepro() }
}

if (import.meta.main) {
  const { rows, libs, repro } = survey()
  const doc = renderReport(rows, libs, repro)
  const json = renderJson(rows, libs)
  const check = process.argv.includes('--check')
  if (check) {
    const stale = readFileSync(REPORT, 'utf8') !== doc || readFileSync(REPORT_JSON, 'utf8') !== json
    console.log(`[shadcn] ${rows.length} rows, ${libs.length} packages: docs/shadcn-coverage.md + .json ${stale ? 'is STALE (run bun run shadcn)' : 'is current'}`)
    process.exit(stale ? 1 : 0)
  }
  writeFileSync(REPORT, doc)
  writeFileSync(REPORT_JSON, json)
  console.log(`[shadcn] ${rows.length} rows, ${libs.length} packages -> docs/shadcn-coverage.md, docs/shadcn-coverage.json`)
}
