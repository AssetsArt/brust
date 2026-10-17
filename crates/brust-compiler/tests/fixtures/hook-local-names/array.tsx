import { useRef, useState } from 'react'
function useThing() {
  const stylesRef = useRef<any>(null)
  const [n, setN] = useState(0)
  return [stylesRef, n, () => setN(n + 1)] as const
}
export default function C() {
  const [stylesRef, n, bump] = useThing()
  return <button type="button" onClick={bump}>{stylesRef.current}{n}</button>
}
