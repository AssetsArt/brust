import { useState } from 'react'
import { Price } from './parts'
export default function StatePage() {
  const [on, setOn] = useState(false)
  return <main><button onClick={() => setOn(!on)}>t</button>{on && <Price price={1} />}</main>
}
