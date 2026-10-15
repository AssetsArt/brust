import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <div onClick={() => setN(n + 1)} data-n={n}>{children}</div>
}

function Btn({ children, ...props }: React.ComponentProps<'button'>) {
  return <button {...props}>{children}</button>
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <Box>
        <Btn onClick={() => setOn(!on)}>flip</Btn>
      </Box>
      <p>{on ? 'yes' : 'no'}</p>
    </section>
  )
}
