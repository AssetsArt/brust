import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'
import { emitBehaviorSsrModule } from './behavior-ssr-loader'

test('generated server module preserves relative imports and normal React rendering', () => {
  const dir = mkdtempSync(path.join(process.cwd(), '.brust-behavior-ssr-loader-'))
  try {
    writeFileSync(path.join(dir, 'label.ts'), `export const label = 'wired'`)
    const outputPath = path.join(dir, 'behavior.generated.tsx')
    emitBehaviorSsrModule(
      {
        component: 'BehaviorComp',
        directiveName: 'behaviorComp_deadbeef',
        moduleId: crypto.randomUUID().replaceAll('-', ''),
        sourcePath: path.join(dir, 'BehaviorComp.tsx'),
        source: `import { useState } from 'react'
import { label } from './label'
export default function BehaviorComp() {
  const [value] = useState(label)
  return <button x-data="behaviorComp_deadbeef">{value}</button>
}`,
      },
      outputPath,
    )

    const run = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { createElement } from 'react'; import { renderToString } from 'react-dom/server.node'; const loaded = await import(${JSON.stringify(outputPath)}); console.log(renderToString(createElement(loaded.default)))`,
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(run.stdout.toString().trim()).toBe(
      '<button x-data="behaviorComp_deadbeef">wired</button>',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
