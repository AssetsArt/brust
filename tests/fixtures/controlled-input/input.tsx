import { useState } from 'react'

export default function Search({ placeholder }: { placeholder: string }) {
  const [q, setQ] = useState('')
  return (
    <label>
      <input value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} />
      {q.length > 0 ? <small>Searching for {q}</small> : null}
    </label>
  )
}
