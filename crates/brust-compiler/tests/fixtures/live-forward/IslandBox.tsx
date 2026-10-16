import { useTransition } from 'react'

// A React island (`useTransition` is not supported natively): its props cross as JSON.
export default function IslandBox({ style, tone }: any) {
  const [pending] = useTransition()
  return <div style={style} data-tone={tone}>{String(pending)}</div>
}
