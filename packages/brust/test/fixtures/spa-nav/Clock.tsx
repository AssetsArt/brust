// useReducer + useTransition => React tier: an island. Its effect counts mounts and unmounts on window.
import { useEffect, useReducer, useTransition } from 'react'

export default function Clock(props: { name: string }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const w = window as unknown as Record<string, number>
    w[`mount:${props.name}`] = (w[`mount:${props.name}`] ?? 0) + 1
    return () => { w[`unmount:${props.name}`] = (w[`unmount:${props.name}`] ?? 0) + 1 }
  }, [props.name])
  return (
    <button type="button" data-count={props.name} onClick={bump}>
      {n}
    </button>
  )
}
