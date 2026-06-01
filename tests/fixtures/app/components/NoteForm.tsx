import { useState } from 'react'
import { client } from '../../../../runtime/client/index.ts'
import type { Actions } from '../actions'

const api = client<Actions>()

export default function NoteForm() {
  const [text, setText] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        setErr(null)
        const { data, error } = await api.notes.post({ text })
        if (error) {
          setErr(`status ${error.status}`)
          return
        }
        setCreated(data.id)
        setText('')
      }}
    >
      <input
        data-testid="note-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="note text"
      />
      <button>Save</button>
      {created && <span data-testid="note-created">created {created}</span>}
      {err && <span data-testid="note-error">{err}</span>}
    </form>
  )
}
