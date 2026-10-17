import { useState } from 'react'
// F376 (pre-existing on main): a prop default that is a module function, read by client code: the chunk must declare it.
function twice(n: number) {
  if (n > 100) return 0
  return n * 2
}
function Step({ start, next = twice }: { start: number; next?: (n: number) => number }) {
  const [n, setN] = useState(start)
  return <b data-n={n} onClick={() => setN(next(n))}>go</b>
}
export default function Page() {
  return <main><Step start={1} /></main>
}
