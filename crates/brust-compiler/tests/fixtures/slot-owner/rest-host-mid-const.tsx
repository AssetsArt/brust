import { useState } from 'react'

// F342 control: the same chain with content that has no directive of the page stays native.
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
  return (
    <main>
      <Mid>
        <p>fixed</p>
      </Mid>
    </main>
  )
}
