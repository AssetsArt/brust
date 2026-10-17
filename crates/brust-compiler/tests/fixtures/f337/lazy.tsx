import { useState } from 'react'
import { Simple } from './Child'
// F337 (A5): a lazy initial value is not a seed the instance record binds: instance-prop-path stays.
export default function Page() {
  const [v, setV] = useState(() => 13)
  return (
    <main>
      <Simple v={v} />
      <button type="button" onClick={() => setV(v + 10)}>go</button>
    </main>
  )
}
