// The "Runtime" column of the scoreboards (L33, R35.5): which client-runtime modules a row's output needs and what
// loading them costs. Bytes are the gzip BUDGET of the core plus each module (docs/runtime-budget.json), not a fresh
// measurement: a bundler version must not move a generated, CI-diffed document. `packages/runtime-dom/scripts/size.ts
// --check` is what ties the budget to the real bytes (an upper bound, within 10% of them when set).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { featuresOf, type RuntimeFeature } from '../packages/brust/src/build/features.ts'

const budget = JSON.parse(readFileSync(join(import.meta.dir, '../docs/runtime-budget.json'), 'utf8')) as { core: number; features: Record<string, number> }

/** The union of the feature modules the rendered templates need (`react`: an island component), in load order. */
export function runtimeFeatures(templates: string[], react: boolean): RuntimeFeature[] {
  const need = new Set<RuntimeFeature>()
  templates.forEach((t, i) => { for (const f of featuresOf(`row:${i}`, t, i === 0 && react)) need.add(f) })
  if (react) need.add('island')
  return (['basics', 'if', 'for', 'model', 'html', 'island'] as const).filter((f) => need.has(f))
}

/** Core + the listed modules, gzip bytes (budget bound). */
export const runtimeGzip = (features: string[]): number => budget.core + features.reduce((n, f) => n + (budget.features[f] ?? 0), 0)

/** `core+basics+for · 5,100 B` (nothing to load: `—`). */
export function runtimeCell(features: string[], needsRuntime: boolean): string {
  return needsRuntime ? `core${features.map((f) => `+${f}`).join('')} · ${runtimeGzip(features)}` : '—'
}
