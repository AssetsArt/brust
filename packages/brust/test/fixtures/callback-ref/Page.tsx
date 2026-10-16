import { useCallback, useState } from 'react'

// B1: `ref={fn}` with a function that is not a `useRef` binding. React calls it with the node at mount, and with
// null at unmount; brust binds a synthetic ref and a mount effect that does the same.
declare global {
  interface Window {
    __refs: string[]
  }
}

export default function Page() {
  const [n, setN] = useState(0)
  const rec = useCallback((node: HTMLButtonElement | null) => {
    window.__refs.push(node ? node.tagName : 'null')
  }, [])
  return (
    <button ref={rec} data-testid="btn" onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
