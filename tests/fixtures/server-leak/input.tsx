import { useState } from 'react'
import { readFileSync } from 'node:fs'

export default function Leak({ path }: { path: string }) {
  const [text, setText] = useState('')
  return (
    <div>
      <button type="button" onClick={() => setText(readFileSync(path, 'utf8'))}>
        Load
      </button>
      <pre>{text}</pre>
    </div>
  )
}
