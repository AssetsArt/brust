import { Price } from './Price'
type Section = { id: string; type: string; data: { title: string; price: string } }
export function PriceList({ sections }: { sections: Section[] }) {
  return <ul>{sections.map((s) => <li key={s.id}><Price price={s.data.price} /></li>)}</ul>
}
