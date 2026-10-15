import { Panel, PanelContent, PanelTrigger } from './Disclosure'

// The same Provider component nested in its own content: the inner consumers read the INNER frame, the outer ones the
// outer frame, and neither reaches the other instance's members.
export default function Nested() {
  return (
    <main>
      <Panel defaultOpen={true}>
        <PanelTrigger>Outer</PanelTrigger>
        <PanelContent>
          <Panel defaultOpen={false}>
            <PanelTrigger>Inner</PanelTrigger>
            <PanelContent>
              <p>inner body</p>
            </PanelContent>
          </Panel>
        </PanelContent>
      </Panel>
    </main>
  )
}
