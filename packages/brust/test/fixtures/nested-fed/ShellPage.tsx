// F560: Bell inside Shell (its React copy there) and Bell placed in the page itself (native, fed by the page).
import Bell from './Bell'
import Shell from './Shell'
export default function ShellPage() {
  return (
    <main>
      <Shell title="top" tone="warn" />
      <Bell tone="direct" />
    </main>
  )
}
