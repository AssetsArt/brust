import { useEffect, useReducer, useState } from 'react'
import { useMachine } from './Machine'

const total = (s: number, a: number): number => s + a

export default function ReducerPage() {
  const [state, send] = useMachine('a', { a: { GO: 'b' }, b: { BACK: 'a', GO: 'c' }, c: {} })
  const [sum, add] = useReducer(total, 0)
  const [runs, setRuns] = useState(0)
  // a dispatch keeps one identity across renders, like a setter: this effect runs once
  useEffect(() => { setRuns((r) => r + 1) }, [send, add])
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => send('GO')}>go</button>
      <button type="button" data-testid="back" onClick={() => send('BACK')}>back</button>
      <button type="button" data-testid="add" onClick={() => add(3)}>add</button>
      <p data-testid="state">{state}</p>
      <p data-testid="sum">{`${sum}`}</p>
      <p data-testid="runs">{runs}</p>
    </main>
  )
}
