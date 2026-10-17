// F362: a stateful child given a row value.
import { useState } from 'react'
export default function Tag({ id, on }: { id: number; on: boolean }) {
  const [n, setN] = useState(0)
  return <span data-testid={`t${id}`} data-id={id} data-on={on ? 1 : 0} data-n={n} onClick={() => setN(n + 1)}>t</span>
}
