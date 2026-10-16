import { useState } from 'react'
import Fwd from './Fwd'
import ClsOwn from './ClsOwn'
import FwdOwn from './FwdOwn'

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button data-testid="flip" onClick={() => setOn(!on)}>
        flip
      </button>
      <Fwd data-case="0" style={on ? { width: 5 } : { width: 0 }} />
      <Fwd data-case="1" style={on ? { opacity: 0, zIndex: 0, lineHeight: 1.5 } : { opacity: 0.5, zIndex: 3, lineHeight: 2 }} />
      <Fwd data-case="2" style={on ? { aspectRatio: 2, flexGrow: 0, WebkitLineClamp: 2 } : { aspectRatio: 1, flexGrow: 1, WebkitLineClamp: 3 }} />
      <Fwd data-case="3" style={on ? { '--gap': '2px' } : { '--gap': 7, '--z': 0 }} />
      <Fwd data-case="4" style={on ? {} : { color: 'red' }} />
      <Fwd data-case="5" style={on ? { color: 'blue' } : { color: undefined, width: null }} />
      <Fwd data-case="6" style={{ msTransform: on ? 'scale(2)' : 'none', MozAppearance: 'none', WebkitTransform: on ? 'none' : 'scale(2)' }} />
      <Fwd data-case="7" style={on ? { height: -3 } : { color: ' red ' }} />
      <Fwd data-case="8" style={on ? { marginTop: 1.5, width: 10 } : { marginTop: 5, margin: 0 }} />
      <FwdOwn data-case="9" style={on ? undefined : { width: 4 }} />
      <Fwd data-case="10" style={on ? { color: true, width: false, height: 2 } : { color: 'green' }} />
      <FwdOwn data-case="11" style={on ? { width: 7 } : { width: 4 }} />
      <Fwd data-case="12" className={on ? 'on big' : 'off'} />
      <ClsOwn data-case="13" className={on ? undefined : 'x'} />
      <Fwd data-case="14" className={on ? 'a' : ''} />
    </main>
  )
}
