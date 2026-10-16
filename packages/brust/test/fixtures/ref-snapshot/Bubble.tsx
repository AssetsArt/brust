import { useRef } from 'react'

// F277: `snap` is a cell nothing sets; `checked` is read only for its first value, so a parent whose `checked` changes
// never needs to reach this component (no link, no directive): React keeps the first render's value too.
export default function Bubble({ checked, defaultChecked }: { checked: boolean; defaultChecked?: boolean }) {
  const snap = useRef(checked)
  return <input type="checkbox" data-testid="bubble" aria-hidden defaultChecked={defaultChecked ?? snap.current} />
}
