// scripts/m2-exit/run.ts — `bun scripts/m2-exit/run.ts` regenerates docs/plans/m2-exit-report.md.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ExitInputs, type F68Numbers, LEDGER_RANGE, parseLedger, renderExitReport } from './exit.ts'
const ROOT = resolve(import.meta.dir, '../..')
export const EXIT_REPORT = join(ROOT, 'docs/plans/m2-exit-report.md')
/** D and I identity rps of `brust` and `brust-01x` in the M3-P suite (`bench/RESULTS.json`), null if any is missing. */
function m3F68Numbers(): F68Numbers | null {
  const ms: { app: string; probe: string; enc: string; nums: { rps: number } }[] = JSON.parse(readFileSync(join(ROOT, 'bench/RESULTS.json'), 'utf8')).measurements ?? []
  const rps = (app: string, probe: string) => ms.find((m) => m.app === app && m.probe === probe && m.enc === 'identity')?.nums.rps
  const [dv, dx, iv, ix] = [rps('brust', 'D'), rps('brust-01x', 'D'), rps('brust', 'I'), rps('brust-01x', 'I')]
  return dv && dx && iv && ix ? { D: { v2: dv, x01: dx }, I: { v2: iv, x01: ix } } : null
}
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
    m3F68: m3F68Numbers(),
    runtimeDomPublishable: JSON.parse(readFileSync(join(ROOT, 'packages/runtime-dom/package.json'), 'utf8')).private !== true,
  }
}
if (import.meta.main) { writeFileSync(EXIT_REPORT, renderExitReport(await gatherInputs())); console.log(`wrote ${EXIT_REPORT}`) }
