import type { Node } from './NodeView'

export const tree: Node[] = [
  {
    id: 'a',
    kind: 'group',
    label: 'A',
    children: [
      { id: 'a1', kind: 'text', label: 'a1' },
      { id: 'b', kind: 'group', label: 'B', children: [{ id: 'c', kind: 'group', label: 'C', children: [{ id: 'c1', kind: 'text', label: 'deep' }] }] },
    ],
  },
  { id: 'z', kind: 'text', label: 'z' },
]
