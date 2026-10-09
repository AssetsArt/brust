import { useState, useEffect, useRef } from 'react'

export default function PaintRules({ size = 3, label, rows }: { size?: number; label?: string; rows: number[] }) {
  const [on, setOn] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    document.title = String(on)
  }, [on])
  return (
    <div ref={ref} className={on && 'on'} style={{ color: on ? 'red' : 'blue', fontSize: size, opacity: on ? 1 : 0.5 }} onClick={() => setOn(!on)}>
      <span>{on && 'Loading'}</span>
      <b>{size * 2}</b>
      <i title={label}>{label ?? 'none'}</i>
      <svg viewBox="0 0 10 10" strokeWidth={2}><path d="M0 0" /></svg>
      <ul>{rows.map((r) => <li key={r}>{r > 1 && 'big'}</li>)}</ul>
    </div>
  )
}
