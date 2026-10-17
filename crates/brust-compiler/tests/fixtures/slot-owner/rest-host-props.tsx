import { useState } from 'react'

// F342: the same through the whole props object.
function Box(props: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...props} onClick={() => setN(n + 1)} data-n={n} />
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
