import { useState } from 'react'
import { useCallbackRef } from './rcbref'
import { useId } from './rid'

// two of Radix's own hooks, imported from other modules: the page is one native component
function Panel({ label }: { label: string }) {
  const id = useId()
  const [log, setLog] = useState('idle')
  const done = useCallbackRef(() => setLog('done'))
  return (
    <section>
      <button type="button" id={id} aria-describedby={`${id}-log`} onClick={() => done()}>
        {label}
      </button>
      <output id={`${id}-log`}>{log}</output>
    </section>
  )
}

export default function HooksPage() {
  return (
    <main>
      <Panel label="a" />
      <Panel label="b" />
    </main>
  )
}
