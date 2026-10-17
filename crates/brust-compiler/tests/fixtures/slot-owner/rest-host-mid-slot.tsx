import { useState } from 'react'

// F342 (Mellow F1, m2): the same through the whole props, into a native child that prints `{children}` in its host.
function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div onClick={() => setN(n + 1)} data-n={n}>
      {children}
    </div>
  )
}
function Mid(props: { children?: React.ReactNode }) {
  return (
    <section>
      <Box {...props} />
    </section>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button onClick={() => setOn(!on)}>flip</button>
      <Mid>
        <p>{on ? 'yes' : 'no'}</p>
      </Mid>
    </main>
  )
}
