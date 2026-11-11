import type { Node } from './NodeView'
import type { Section } from './SectionView'

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

export const sectionsPage: { sections: Section[] } = {
  sections: [
    { id: 's-hero', type: 'hero', title: 'Hello' },
    {
      id: 's-custom',
      type: 'custom',
      nodes: [
        {
          id: 'e-g1',
          kind: 'group',
          children: [
            { id: 'e-t1', kind: 'text', text: 't1' },
            { id: 'e-g2', kind: 'group', children: [{ id: 'e-img', kind: 'image', src: '/x.png' }, { id: 'e-deep', kind: 'text', text: 'deep' }] },
          ],
        },
        { id: 'e-t2', kind: 'text', text: 't2' },
      ],
    },
    { id: 's-inline', type: 'inline', nodes: [{ id: 'i-g', kind: 'group', children: [{ id: 'i-t', kind: 'text', text: 'inline deep' }] }] },
  ],
}
