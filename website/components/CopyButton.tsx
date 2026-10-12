// The Copy button on a code block (native tier): copies the block's text; a shell block copies its `$ ` commands only.
import { useState } from 'react'

export default function CopyButton({ text, lang }: { text: string; lang: string }) {
  const [label, setLabel] = useState('Copy')
  return (
    <button
      type="button"
      className={label === 'Copied' ? 'done' : ''}
      onClick={() => {
        const lines = text.split('\n')
        const commands = lines.filter((l) => l.startsWith('$ ')).map((l) => l.slice(2))
        const copy = lang === 'sh' && commands.length > 0 ? commands.join('\n') : text
        navigator.clipboard.writeText(copy).then(
          () => setLabel('Copied'),
          () => setLabel('Select to copy'),
        )
        setTimeout(() => setLabel('Copy'), 1400)
      }}
    >
      {label}
    </button>
  )
}
