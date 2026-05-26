import { useState } from 'react'
import { action, BrustActionError } from '../../../../runtime/client/index.ts'
import type * as srv from '../actions'

const createNote = action<typeof srv.createNote>('createNote')

export default function NoteForm() {
  const [text, setText] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        setErr(null)
        try {
          const { id } = await createNote(text)
          setCreated(id)
          setText('')
        } catch (caught) {
          if (caught instanceof BrustActionError) setErr(`status ${caught.status}: ${caught.message}`)
          else setErr(String(caught))
        }
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
