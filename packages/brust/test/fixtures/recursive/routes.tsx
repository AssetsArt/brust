import type { RuntimeComponents } from '@brust/core'
import { compileComponent } from '@brust/core/compile'
import { defineRoutes } from '@brust/core/routes'
import BuiltTree from './BuiltTree'
import { tree } from './data'
import { rcSource } from './rcSource'
import SlotTree from './SlotTree'
import Tree from './Tree'

// F523 C8: the `tree` ref compiles StaticNode's source text at runtime; its artifact paints through <Dynamic>.
export const components: RuntimeComponents = {
  async resolve(ref) {
    if (ref !== 'tree') return null
    const r = await compileComponent({ source: rcSource, filename: 'el/StaticNode.tsx' })
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.diagnostics)}`)
    return r.artifact
  },
}

export const routes = defineRoutes([
  { path: '/', Component: Tree, loader: () => ({ nodes: tree }) },
  { path: '/built', Component: BuiltTree, loader: () => ({ nodes: tree }) },
  { path: '/slot', Component: SlotTree, loader: () => ({ nodes: tree }) },
])
