import * as React from 'react'
function useBox(p: { n: number }) {
  const [on, setOn] = React.useState(false)
  return { label: p.n > 1 ? 'many' : 'one', on, flip: () => setOn(!on) }
}
export default function P(p: { n: number }) {
  const t = useBox(p)
  return <button type="button" onClick={t.flip}>{t.label}{t.on ? 'Y' : 'N'}</button>
}
