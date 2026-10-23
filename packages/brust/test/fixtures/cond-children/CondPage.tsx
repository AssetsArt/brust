import { useState } from 'react'
import { Panel, PanelTernary, Plain, Prov } from './lib'

export default function CondPage() {
  const [o, setO] = useState(false)
  return (
    <main>
      <button type="button" data-testid="plain-toggle" onClick={() => setO(!o)}>
        p
      </button>
      <Plain open={o}>
        <b>plain child</b>
      </Plain>
      <Prov>
        <Panel>
          <b>panel child</b>
        </Panel>
        <PanelTernary>
          <i>ternary child</i>
        </PanelTernary>
      </Prov>
    </main>
  )
}
