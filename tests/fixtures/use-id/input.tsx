import { useId, useState } from 'react'
export default function Field(props: { label: string }) {
  const id = useId()
  const [v, setV] = useState('')
  return (
    <div>
      <label htmlFor={id}>{props.label}</label>
      <input id={id} value={v} onChange={(e) => setV(e.target.value)} />
    </div>
  )
}
