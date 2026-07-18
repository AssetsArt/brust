import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

export interface BehaviorSsrDependency {
  sourcePath: string
  outputPath: string
}

export interface BehaviorSsrModule {
  component: string
  directiveName: string
  moduleId: string
  source: string
  sourcePath: string
  dependencies?: BehaviorSsrDependency[]
}

function rewriteBehaviorImports(entry: BehaviorSsrModule): string {
  if (!entry.dependencies || entry.dependencies.length === 0) return entry.source
  const dependencyBySource = new Map(
    entry.dependencies.map((dependency) => [resolve(dependency.sourcePath), dependency.outputPath]),
  )
  return entry.source.replace(
    /(\bfrom\s*['"])([^'"]+)(['"])/g,
    (statement, before: string, specifier: string, after: string) => {
      if (!specifier.startsWith('.')) return statement
      const importBase = resolve(dirname(entry.sourcePath), specifier)
      const candidates = [
        importBase,
        `${importBase}.tsx`,
        `${importBase}.ts`,
        resolve(importBase, 'index.tsx'),
        resolve(importBase, 'index.ts'),
      ]
      const dependencyOutput = candidates
        .map((candidate) => dependencyBySource.get(candidate))
        .find((candidate) => candidate !== undefined)
      if (!dependencyOutput) return statement
      const rewritten = relative(dirname(entry.sourcePath), dependencyOutput).replaceAll('\\', '/')
      return `${before}${rewritten.startsWith('.') ? rewritten : `./${rewritten}`}${after}`
    },
  )
}

export function emitBehaviorSsrModule(entry: BehaviorSsrModule, outputPath: string): void {
  const temporaryEntry = `${entry.sourcePath}.brust-behavior-${randomUUID()}.tsx`
  writeFileSync(temporaryEntry, rewriteBehaviorImports(entry))
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
