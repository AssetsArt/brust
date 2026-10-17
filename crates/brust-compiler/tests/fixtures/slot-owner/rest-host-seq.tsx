import { useState } from 'react'

// F343 tripwire for the Seq path (W1d 4b): the intermediate forwards the rest through a local object that spreads it
// (`const common = { role: 'group', ...rest }`, then `<Box {...common} />`), so the children reach the native child's host through
// the expanded parts, not through a plain rest spread.
function Box({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} onClick={() => setN(n + 1)} data-n={n} />
}
function Mid({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const common = { role: 'group', ...rest }
  return (
    <section>
      <Box {...common} />
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
