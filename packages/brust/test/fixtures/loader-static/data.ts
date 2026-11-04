import type { Row, Section } from './parts'

export const SECTIONS: Section[] = [
  { id: 's1', type: 'hero', data: { title: 'Welcome' } },
  { id: 's2', type: 'price', data: { price: '12.5' } },
  { id: 's3', type: 'promo', data: { title: 'skipped' } },
  { id: 's4', type: 'price', data: { price: '1000' } },
  { id: 's5', type: 'hero', data: { title: 'Fish & <chips>' } },
]

// F502: hero rows have no price; Amount's `price.toFixed(2)` throws on them.
export const ROWS: Row[] = [
  { id: 'r1', type: 'hero', data: { title: 'Top' } },
  { id: 'r2', type: 'price', data: { price: 12.5 } },
  { id: 'r3', type: 'promo', data: {} },
  { id: 'r4', type: 'price', data: { price: 1000 } },
  { id: 'r5', type: 'hero', data: { title: 'End' } },
]
