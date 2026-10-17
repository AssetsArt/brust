import * as React from 'react'
import { useState } from 'react'
import { Panel, PanelContent, PanelTrigger } from './Disclosure'

// F271: the component's own `children` read in the content of a specialised Provider.
export function Frame({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button id="n" type="button" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <Panel>
        <PanelTrigger>{children}</PanelTrigger>
        <PanelContent>
          <p>body</p>
        </PanelContent>
      </Panel>
    </main>
  )
}
