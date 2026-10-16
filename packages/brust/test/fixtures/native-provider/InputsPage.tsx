import { useState } from 'react'
import { Panel, PanelContent, PanelTrigger } from './Disclosure'

// S2: the page's state is read, and its handler is called, from the content of a specialised Provider.
export default function InputsPage() {
  const [n, setN] = useState(0)
  return (
    <main>
      <Panel>
        <PanelTrigger>open</PanelTrigger>
        <p id="live">{n}</p>
        <button id="inc" type="button" onClick={() => setN(n + 1)}>
          inc
        </button>
        <PanelContent>
          <p>body</p>
        </PanelContent>
      </Panel>
      <p id="outside">{n}</p>
    </main>
  )
}
