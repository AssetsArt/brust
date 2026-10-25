// The `nav` asset (design §5.8): SPA navigation on every full brust document, also on a page that loads no runtime.
// Standalone: nothing under nav/ imports the runtime core. `navigate()` reaches it through `Symbol.for('brust.nav')`.
import { boot } from './nav'

boot()
