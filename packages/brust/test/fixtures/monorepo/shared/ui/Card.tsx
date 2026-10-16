import type { ReactNode } from 'react'
import Button from '../Button'

// `../Button` goes up inside the source root: still inside it.
export default function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
      <Button label="Close" />
    </section>
  )
}
