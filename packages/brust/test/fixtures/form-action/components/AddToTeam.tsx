import { useState } from 'react'
import { api } from '../lib/api'

export default function AddToTeam() {
  const [id, setId] = useState('25')
  const [msg, setMsg] = useState('')
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    const r = await api.team.post({ id: Number(id) })
    if (r.error) setMsg(r.error.status === 409 ? 'The team is full' : `Failed with ${r.error.status}`)
    else setMsg(`Team: ${r.data.team.length}/${r.data.max}`)
  }
  return (
    <form onSubmit={submit}>
      <input name="id" value={id} onChange={(e) => setId(e.target.value)} />
      <button type="submit">Add to team</button>
      <p>{msg}</p>
    </form>
  )
}
