// F494: stateless components a page feeds only loader data (fixed props). Each is compiled once for every caller; the page's
// call site gets a clone with every prop fixed, which lowers static.
export type Section = { id: string; type: string; data: { title?: string; price?: string } }

const formatPrice = (n: number) => `฿${n.toFixed(2)}`

export function Hero({ title }: { title?: string }) {
  return <h2 className="hero">{title}</h2>
}

export function Price({ price }: { price?: string }) {
  return <span className="price">{formatPrice(Number(price))}</span>
}

export function List({ sections }: { sections: Section[] }) {
  return (
    <div className="list">
      {sections.map((s) => (
        <div key={s.id}>
          <Hero title={s.data.title} />
        </div>
      ))}
    </div>
  )
}

export function PriceList({ sections }: { sections: Section[] }) {
  return (
    <ul>
      {sections.map((s) => (
        <li key={s.id}>
          <Price price={s.data.price} />
        </li>
      ))}
    </ul>
  )
}

export function SectionView({ s }: { s: Section }) {
  if (s.type === 'hero') return <Hero title={s.data.title} />
  if (s.type === 'price') return <Price price={s.data.price} />
  return null
}

export function PageView({ sections }: { sections: Section[] }) {
  return (
    <div className="page">
      {sections.map((s) => (
        <SectionView key={s.id} s={s} />
      ))}
    </div>
  )
}
