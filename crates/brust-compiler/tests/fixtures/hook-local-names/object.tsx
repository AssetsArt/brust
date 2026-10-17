import { useRef, useState } from 'react'
function useThing() {
  const stylesRef = useRef<any>(null)
  const [n, setN] = useState(0)
  return { stylesRef, n, bump: () => setN(n + 1) }
}
export default function C() {
  const t = useThing()
  return <button type="button" onClick={t.bump}>{t.stylesRef.current}{t.n}</button>
}
