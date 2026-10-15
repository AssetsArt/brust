// F143: the gzip bytes of the client runtime the browser build ships: the core, and each feature module a page links only
// when its components need it (`packages/brust/src/build/features.ts`). Built once with the real `buildRuntime`, in a
// throwaway dist, and printed as JSON for `run.ts` (which stays synchronous). Run: `bun scripts/battery/runtime-sizes.ts`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildRuntime } from '../../packages/brust/src/build/bundle.ts'
import { RUNTIME_FEATURES } from '../../packages/brust/src/build/features.ts'

export interface RuntimeSizes {
  core: number
  features: Record<string, number>
}

export async function measureRuntime(): Promise<RuntimeSizes> {
  const dist = mkdtempSync(join(tmpdir(), 'battery-runtime-'))
  try {
    const a = await buildRuntime(dist, { sourceOf: new Map(), appRoot: dist, serverOnly: [] })
    const gz = (file: string): number => gzipSync(readFileSync(join(dist, file))).length
    return { core: gz(a.core), features: Object.fromEntries(RUNTIME_FEATURES.map((f) => [f, gz(a.features[f]!)])) }
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
}

if (import.meta.main) console.log(JSON.stringify(await measureRuntime()))
