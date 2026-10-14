// A React island (useReducer keeps it one) that is given a per-row prop.
import { useReducer } from 'react'
export default function Tip({ t }: any) {
  const [n, hit] = useReducer((x: number) => x + 1, 0)
  return <button onClick={() => hit()}>{t}{n}</button>
}
