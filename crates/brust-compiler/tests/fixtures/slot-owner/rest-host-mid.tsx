import { useState } from 'react'

// F342 (Mellow F1, m1): an unlinked static intermediate forwards its rest to a native child whose rest carries the
// children onto its host.
function Box({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} onClick={() => setN(n + 1)} data-n={n} />
}
function Mid({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <section>
      <Box {...rest} />
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
