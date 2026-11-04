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

// F502: a helper that throws where React never calls it (a row with no price). The job must run only for the rows whose
// branch renders <Amount>.
export type Row = { id: string; type: string; data: { title?: string; price?: number } }

export function Amount({ price }: { price: number }) {
  return <span className="amount">{price.toFixed(2)}</span>
}

export function IfRow({ s }: { s: Row }) {
  if (s.type === 'hero') return <Hero title={s.data.title} />
  if (s.type === 'price') return <Amount price={s.data.price!} />
  return null
}

export function SwitchRow({ s }: { s: Row }) {
  switch (s.type) {
    case 'hero':
      return <Hero title={s.data.title} />
    case 'price':
      return <Amount price={s.data.price!} />
    default:
      return null
  }
}

export function AndRow({ s }: { s: Row }) {
  return <div className="and">{s.type === 'price' && <Amount price={s.data.price!} />}</div>
}

export function TernaryRow({ s }: { s: Row }) {
  return <div className="ternary">{s.type !== 'price' ? <Hero title={s.data.title} /> : <Amount price={s.data.price!} />}</div>
}

// A condition outside what the server evaluates per row: no clone (the component keeps its own tier), the page renders.
export function GtRow({ s }: { s: Row }) {
  return <div className="gt">{(s.data.price ?? 0) > 0 && <Amount price={s.data.price!} />}</div>
}

export function IfList({ rows }: { rows: Row[] }) {
  return <div className="rows">{rows.map((s) => <IfRow key={s.id} s={s} />)}</div>
}

export function SwitchList({ rows }: { rows: Row[] }) {
  return <div className="rows">{rows.map((s) => <SwitchRow key={s.id} s={s} />)}</div>
}

export function AndList({ rows }: { rows: Row[] }) {
  return <div className="rows">{rows.map((s) => <AndRow key={s.id} s={s} />)}</div>
}

export function TernaryList({ rows }: { rows: Row[] }) {
  return <div className="rows">{rows.map((s) => <TernaryRow key={s.id} s={s} />)}</div>
}

export function GtList({ rows }: { rows: Row[] }) {
  return <div className="rows">{rows.map((s) => <GtRow key={s.id} s={s} />)}</div>
}
