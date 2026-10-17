import { useState } from 'react'
import { Panel, PanelContent, PanelTrigger } from './Disclosure'

// F271: a handler of the page that takes the event argument, written in a specialised Provider's content.
export default function InEventPage() {
  const [n, setN] = useState(0)
  return (
    <main>
      <Panel>
        <PanelTrigger>open</PanelTrigger>
        <button id="add" type="button" onClick={(e) => setN(n + e.detail)}>
          add
        </button>
        <p id="live">{n}</p>
        <PanelContent>
          <p>body</p>
        </PanelContent>
      </Panel>
    </main>
  )
}
