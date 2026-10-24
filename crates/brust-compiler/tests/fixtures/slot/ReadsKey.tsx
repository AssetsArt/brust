import { useState } from 'react'

// F369c negative: the child spreads its props AND reads the handler key from them in its own code, so an element binding
// could not stand for the prop.
export default function ReadsKey(props: any) {
  const [on, setOn] = useState(false)
  return <button {...props} aria-pressed={on} onClick={() => { setOn(!on); props.onMouseDown?.() }} />
}
