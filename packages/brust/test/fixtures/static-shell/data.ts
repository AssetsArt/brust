import type { Section } from './types'

export const sections: Section[] = [
  { id: 's1', type: 'title', title: 'Hello' },
  {
    id: 's2',
    type: 'custom',
    cls: 'grid',
    nodes: [
      { id: 'n1', kind: 'group', label: 'G', children: [{ id: 'l1', label: 'one' }, { id: 'l2', label: 'two' }] },
      { id: 'n2', kind: 'img', label: 'pic', src: '/n2.png' },
      { id: 'n3', kind: 'text', label: 'plain' },
    ],
  },
  { id: 's3', type: 'rule' },
]
