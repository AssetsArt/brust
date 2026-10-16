import { useState } from 'react'

// F342: Box prints no `{children}`, but its `...rest` carries the page's children onto its host element.
function Box({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} onClick={() => setN(n + 1)} data-n={n} />
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
