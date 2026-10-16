import { useRef, useState } from 'react'

// B4: `snap` is never written and only read as `.current` in the render: the first render's `checked` for good.
export default function Field({ checked, defaultChecked }: { checked: boolean; defaultChecked?: boolean }) {
  const [n, setN] = useState(0)
  const snap = useRef(checked)
  return (
    <div data-testid="box" onClick={() => setN(n + 1)}>
      <b>{n}</b>
      <input type="checkbox" defaultChecked={defaultChecked ?? snap.current} />
    </div>
  )
}
