import { useState } from 'react'

// Interactive fragment root: keeps <brust-host> and warns.
export default function Counter() {
  const [n, setN] = useState(0)
  return (
    <>
      <dt>{n}</dt>
      <dd>
        <button onClick={() => setN(n + 1)}>+</button>
      </dd>
    </>
  )
}
