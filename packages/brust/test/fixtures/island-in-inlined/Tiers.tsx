import { useState } from 'react'
import Search from './Search'

// A native component (its own state, so an x-data host) that holds the island.
export default function Tiers({ title }: { title: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section>
      <h2 data-testid="tiers-title">{title}</h2>
      <button type="button" data-testid="toggle" onClick={() => setOpen(!open)}>
        {open ? 'open' : 'closed'}
      </button>
      <Search label="go" />
    </section>
  )
}
