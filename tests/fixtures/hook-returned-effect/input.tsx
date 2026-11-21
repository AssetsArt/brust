import { useEffect } from 'react'
import { useDerived, usePlain } from './hooks'

// F589: a hook's returned function called from an effect, through the hook object and destructured. React runs the
// effect after the first paint; the browser case checks the text after mount.
export default function Effect() {
  const m = usePlain('eff')
  const { v, run } = useDerived('fx')
  useEffect(() => m.run(), [])
  useEffect(() => run(), [])
  return (
    <div>
      <p id="em">{m.v}</p>
      <p id="ed">{v}</p>
    </div>
  )
}
