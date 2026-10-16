import { version, useState } from 'react'

// `typeof version === 'function'` is not decided: `version` is a string, not one of React's hooks
function useThing() {
  if (typeof version === 'function') {
    const [a] = useState(1)
    return a
  }
  return 2
}
export default function P() {
  const n = useThing()
  return <button onClick={() => {}}>{n}</button>
}
