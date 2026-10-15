import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div onClick={() => setN(n + 1)} data-n={n}>
      {children}
    </div>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button onClick={() => setOn(!on)}>flip</button>
      <Box>
        <p>{on ? 'yes' : 'no'}</p>
      </Box>
    </section>
  )
}
