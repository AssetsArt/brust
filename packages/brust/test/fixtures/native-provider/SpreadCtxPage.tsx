import { Panel, PanelContent, PanelTrigger } from './Disclosure'

// F275 (F266, positive twin): a `const` object literal that is never written, spread into a Provider as its entries.
export default function SpreadCtxPage() {
  const attrs = { defaultOpen: true }
  return (
    <main>
      <Panel {...attrs}>
        <PanelTrigger>toggle</PanelTrigger>
        <PanelContent>
          <p>body</p>
        </PanelContent>
      </Panel>
    </main>
  )
}
