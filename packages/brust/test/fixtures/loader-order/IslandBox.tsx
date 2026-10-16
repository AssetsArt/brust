import { useTransition } from 'react'

// A React island (`useTransition` is not supported natively): its props cross as JSON.
export default function IslandBox({ style, cfg }: any) {
  const [pending] = useTransition()
  return (
    <div data-testid="box" style={style} data-pending={String(pending)}>
      <code data-testid="cfg">{JSON.stringify(cfg)}</code>
    </div>
  )
}
