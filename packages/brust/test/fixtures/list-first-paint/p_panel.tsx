import { useState } from 'react'
import Label from './Label'

// The live cloudSection shape: each hidden row holds a child component given the row's own texts.
const WAYS = [
  { id: 'github', th: 'เลือก repo', en: 'Pick a repo' },
  { id: 'zip', th: 'ลาก .zip', en: 'Drop a .zip' },
  { id: 'mcp', th: 'สั่งจาก editor', en: 'From your editor' },
]
export default function PPanel() {
  const [source, setSource] = useState('mcp')
  return (
    <main>
      <button type="button" data-testid="first" onClick={() => setSource('github')}>
        first
      </button>
      <p>
        {WAYS.map((w) => (
          <span key={w.id} hidden={source !== w.id}>
            <Label th={w.th} en={w.en} />
          </span>
        ))}
      </p>
    </main>
  )
}
