import { useState } from 'react'
function Counter({ start }: { start: number }) {
  const [c, setC] = useState(0)
  return <button onClick={() => setC(c + 1)}>{start + c}</button>
}
export default function T() {
  const [open, setOpen] = useState(false)
  const [n, setN] = useState(5)
  const [list, setList] = useState<string[]>([])
  return (
    <div>
      <button onClick={() => setOpen(!open)}>t</button>
      {open && <>a<b>bold</b></>}
      {open && 'text-branch'}
      {list && <p>has-list</p>}
      <Counter start={n} />
      <Counter start={n * 2} />
    </div>
  )
}
