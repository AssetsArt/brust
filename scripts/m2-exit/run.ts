// scripts/m2-exit/run.ts — `bun scripts/m2-exit/run.ts` regenerates docs/plans/m2-exit-report.md.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ExitInputs, LEDGER_RANGE, parseLedger, renderExitReport } from './exit.ts'
const ROOT = resolve(import.meta.dir, '../..')
export const EXIT_REPORT = join(ROOT, 'docs/plans/m2-exit-report.md')
export async function gatherInputs(): Promise<ExitInputs> {
  const app = join(ROOT, 'examples/pokedex')
  const b = Bun.spawnSync([join(ROOT, 'packages/brust/bin/brust'), 'build', 'routes.tsx', '--out-dir', 'dist-exit'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const manifest = JSON.parse(readFileSync(join(app, 'dist-exit/manifest.json'), 'utf8'))
  rmSync(join(app, 'dist-exit'), { recursive: true, force: true })
  return {
    manifest,
    bench: JSON.parse(readFileSync(join(ROOT, 'scripts/m2-exit/m2-bench-results.json'), 'utf8')),   // frozen M2 input (bench/RESULTS.json @ 1b5de6d)
    ledger: parseLedger(readFileSync(join(ROOT, 'docs/plans/m1a-followups.md'), 'utf8'), LEDGER_RANGE),
    ledger68: parseLedger(readFileSync(join(ROOT, 'docs/plans/m1a-followups.md'), 'utf8'), [68])[0]!,
    m3BarF68: readFileSync(join(ROOT, 'bench/RESULTS.md'), 'utf8').split('\n').find((l) => l.startsWith('bar F68'))?.replace(/\s+/g, ' ').trim() ?? null,
    runtimeDomPublishable: JSON.parse(readFileSync(join(ROOT, 'packages/runtime-dom/package.json'), 'utf8')).private !== true,
  }
}
if (import.meta.main) { writeFileSync(EXIT_REPORT, renderExitReport(await gatherInputs())); console.log(`wrote ${EXIT_REPORT}`) }
