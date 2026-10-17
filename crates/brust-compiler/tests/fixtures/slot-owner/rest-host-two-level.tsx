import { useState } from 'react'

// F343: the page's children pass through two unlinked static rests before they land on a native child's host.
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
function Outer({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <article>
      <Mid {...rest} />
    </article>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button onClick={() => setOn(!on)}>flip</button>
      <Outer>
        <p>{on ? 'yes' : 'no'}</p>
      </Outer>
    </main>
  )
}
