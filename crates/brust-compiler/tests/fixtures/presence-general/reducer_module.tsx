import { useReducer } from 'react'
type A = { type: 'inc' } | { type: 'dec' }
function reduce(s: { n: number }, a: A) {
  switch (a.type) {
    case 'inc':
      return { ...s, n: s.n + 1 }
    case 'dec':
      return { ...s, n: s.n - 1 }
    default:
      return s
  }
}
export default function P() {
  const [s, dispatch] = useReducer(reduce, { n: 0 })
  return <div><button type="button" onClick={() => dispatch({ type: 'inc' })}>+</button><i>{`${s.n}`}</i></div>
}
