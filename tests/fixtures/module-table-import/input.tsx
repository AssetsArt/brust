// F564 D1/D4: module tables built from an imported literal table, read by a native component with state, in markup and
// in handlers; the served HTML and the hydrated component must match React. (A member of an imported table read as a
// CHILD is judged by the element rule, jsx-const-child: not this rule.)
import { useState } from 'react'
import { ICON } from './icons'

const OVERVIEW = { id: 'overview', icon: ICON.overview, path: '/' }
const APPS = { id: 'apps', icon: ICON.apps, path: '/apps' }
const LABEL = `${OVERVIEW.path}|${APPS.path}`

export default function Nav({ title }: { title: string }) {
  const [on, setOn] = useState(OVERVIEW.id)
  return (
    <nav data-label={LABEL}>
      <h1 id="t">{title}</h1>
      <p id="cur" data-icon={on === OVERVIEW.id ? OVERVIEW.icon : APPS.icon}>
        {on === APPS.id ? 'apps' : 'overview'}
      </p>
      <button id="b0" title={OVERVIEW.icon} onClick={() => setOn(OVERVIEW.id)}>
        overview
      </button>
      <button id="b1" title={APPS.icon} onClick={() => setOn(APPS.id)}>
        apps
      </button>
    </nav>
  )
}
