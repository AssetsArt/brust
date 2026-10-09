import { notFound } from '@brust/core/routes'

export async function itemLoader({ params }: { params: { id: string } }) {
  if (params.id === 'nothing') return notFound({ item: { id: 'nothing', name: 'missing', price: 0, rows: [] }, unit: '', team: [] })
  return {
    item: { id: params.id, name: `Item ${params.id}`, price: 12.5, rows: [{ id: 'a', price: 1 }, { id: 'b', price: 2.25 }] },
    unit: '€',
    team: ['ann', 'bob'],
  }
}
