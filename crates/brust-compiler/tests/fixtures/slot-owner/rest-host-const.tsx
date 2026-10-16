import { useState } from 'react'

// F342 control: content with no directive of the page under the same child stays native.
function Box({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  const [n, setN] = useState(0)
  return <div {...rest} onClick={() => setN(n + 1)} data-n={n} />
}

export default function Page() {
  return (
    <section>
      <Box>
        <p>fixed</p>
      </Box>
    </section>
  )
}
