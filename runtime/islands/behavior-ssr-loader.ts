import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'

export interface BehaviorSsrModule {
  component: string
  directiveName: string
  moduleId: string
  source: string
  sourcePath: string
}

export function emitBehaviorSsrModule(entry: BehaviorSsrModule, outputPath: string): void {
  const temporaryEntry = `${entry.sourcePath}.brust-behavior-${randomUUID()}.tsx`
  writeFileSync(temporaryEntry, entry.source)
  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        'build',
        temporaryEntry,
        '--target=bun',
        '--format=esm',
        '--packages=external',
        `--outfile=${outputPath}`,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `failed to generate SSR behavior module "${entry.component}" (${entry.moduleId}): ${result.stderr.toString()}`,
      )
    }
  } finally {
    rmSync(temporaryEntry, { force: true })
  }
}
