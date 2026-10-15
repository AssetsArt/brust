import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <div onClick={() => setN(n + 1)} data-n={n}>{children}</div>
}

function Wrap({ children }: { children?: React.ReactNode }) {
  return (
    <section>
      <Box>constant</Box>
      <div>{children}</div>
    </section>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <Wrap>
      <p>{on ? 'yes' : 'no'}</p>
      <button onClick={() => setOn(!on)}>flip</button>
    </Wrap>
  )
}
