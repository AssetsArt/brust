import { useState } from 'react'
import { Price } from './parts'
// Review 05ee17fd (a): a non-root child whose prop its stateful parent changes: its branch is an x-if the client flips.
function Panel({ open }: { open: boolean }) {
  return <section>{open && <Price price={2} />}</section>
}
export default function StatefulPanelPage() {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <button onClick={() => setOpen(!open)}>t</button>
      <Panel open={open} />
    </main>
  )
}
