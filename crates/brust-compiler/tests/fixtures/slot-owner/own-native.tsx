import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <div onClick={() => setN(n + 1)} data-n={n}>{children}</div>
}

function Badge({ label }: { label: string }) {
  const [k, setK] = useState(0)
  return <b onClick={() => setK(k + 1)}>{label}{k}</b>
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>
      <Box>
        <Badge label="constant" />
      </Box>
    </section>
  )
}
