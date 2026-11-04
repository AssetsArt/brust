import type { Section } from './parts'

export const SECTIONS: Section[] = [
  { id: 's1', type: 'hero', data: { title: 'Welcome' } },
  { id: 's2', type: 'price', data: { price: '12.5' } },
  { id: 's3', type: 'promo', data: { title: 'skipped' } },
  { id: 's4', type: 'price', data: { price: '1000' } },
  { id: 's5', type: 'hero', data: { title: 'Fish & <chips>' } },
]
