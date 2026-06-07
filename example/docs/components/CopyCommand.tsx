// NATIVE behavior component (react-free) — the hero "scaffold" command pill with a
// working Copy button. The behavior writes the command to the clipboard and flips
// the button label (x-text); a static lucide Copy icon stays put (no flash). Its
// directive chunk imports only brustjs/store.
import { Copy } from 'lucide-react'
import { signal } from 'brustjs/store'

const CMD = 'bun create brustjs@latest my-app'

export const behavior = () => {
  const label = signal('Copy')
  const copy = () => {
    navigator.clipboard?.writeText?.(CMD)
    label.set('Copied')
    setTimeout(() => label.set('Copy'), 1500)
  }
  return { label, copy }
}

export default function CopyCommand() {
  return (
    <div className="b-cmd">
      <span className="b-cmd__prompt">$</span>
      <code className="b-cmd__text">bun create brustjs@latest my-app</code>
      <button type="button" x-on-click="copy" className="b-cmd__copy" aria-label="Copy command">
        <Copy size={13} />
        <span x-text="label">Copy</span>
      </button>
    </div>
  )
}
