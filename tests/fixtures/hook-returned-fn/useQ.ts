import { useState } from 'react'

// F578 review: a function the hook returns reads the hook's (defaulted) parameter, a hook value and a hook-local
// function; the component uses it as a handler by member (`onClick={q.find}`).
export function useQ(sel = 'a, button', after: () => void = () => {}) {
  const [hit, setHit] = useState('')
  const mark = sel.length
  const find = () => {
    setHit(`${sel}#${mark}`)
    after()
  }
  return { hit, find }
}
