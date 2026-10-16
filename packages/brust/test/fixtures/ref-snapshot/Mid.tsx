import { useState } from 'react'
import Initial from './Initial'

// F277: a component that may mount later, whose own state starts from a prop, feeding a fixed cell below it.
export default function Mid({ init }: { init: string }) {
  const [v, setV] = useState(init)
  return (
    <section data-testid="mid" onClick={() => setV(`${v}!`)}>
      <Initial label={v} testid="mid-initial" />
    </section>
  )
}
