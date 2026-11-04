import { Hero } from './Hero'
import { Price } from './Price'
type Section = { id: string; type: string; data: { title: string; price: string } }
export function SectionView({ s }: { s: Section }) {
  if (s.type === 'hero') return <Hero title={s.data.title} />
  if (s.type === 'price') return <Price price={s.data.price} />
  return null
}
