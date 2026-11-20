import { useState } from 'react'
import { useShout } from './useShout'

// F579: the click runs the hook's exported helper in the browser; F578 D3: the omitted `mark` is its default there.
export default function Shout({ initial }: { initial: string }) {
  const [v, setV] = useState(initial)
  const say = useShout()
  return (
    <div>
      <button id="go" onClick={() => setV(say(v))}>
        go
      </button>
      <p id="out">{v}</p>
    </div>
  )
}
