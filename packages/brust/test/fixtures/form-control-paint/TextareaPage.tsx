import { useState } from 'react'

// A controlled textarea shows its value as text content, escaped, with the leading newline kept (the parser drops the
// first one).
export default function TextareaPage() {
  const [v, setV] = useState('a<b & "c"')
  const [lead, setLead] = useState('\nx')
  return (
    <main>
      <textarea data-testid="ta" value={v} onChange={(e) => setV(e.target.value)} />
      <p data-testid="ta-echo">{v}</p>
      <textarea data-testid="lead" value={lead} onChange={(e) => setLead(e.target.value)} />
      <textarea data-testid="default" defaultValue="d &amp; d" />
      <textarea data-testid="empty" />
    </main>
  )
}
