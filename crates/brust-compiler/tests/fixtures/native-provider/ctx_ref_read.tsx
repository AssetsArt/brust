import * as React from 'react'
import { P, PTrigger } from './Prov'

// The content of a state Provider reads `ref.current` in a style: it crosses into the clone as one input.
export default function Page() {
  const r = React.useRef(true)
  React.useEffect(() => {
    r.current = false
  }, [])
  return (
    <main>
      <P>
        <PTrigger>One</PTrigger>
        <p style={{ animationDuration: r.current ? '0s' : undefined }}>x</p>
      </P>
    </main>
  )
}
