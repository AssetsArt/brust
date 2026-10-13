// The Copy button on a code block (native tier): copies the block's text; a shell block copies its `$ ` commands only.
// Without the Clipboard API (a non-secure origin) or when the write is refused, it selects the code instead, so the
// reader can copy by hand. A second click within the label's 1.4 s restarts the reset timer (the old one is cleared).
import { useEffect, useRef, useState } from 'react'

export default function CopyButton({ text, lang }: { text: string; lang: string }) {
  const [label, setLabel] = useState('Copy')
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const self = useRef<HTMLSpanElement>(null)
  // mounted marker for tests, on the label span. A native effect runs BEFORE refs and handlers are bound (gap G9),
  // so the marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => self.current?.setAttribute('data-ready', ''))
  }, [])
  return (
    <button
      type="button"
      className={`cursor-pointer border-0 border-l border-term-rule bg-transparent px-[.9rem] py-0 [font:inherit] ${label === 'Copied' ? 'text-[#8fd694]' : 'text-term-dim hover:text-term-fg'}`}
      onClick={(e) => {
        const pre = e.currentTarget.closest('.code')?.querySelector('pre')
        const show = (next: string) => {
          setLabel(next)
          clearTimeout(reset.current)
          reset.current = setTimeout(() => setLabel('Copy'), 1400)
        }
        const selectCode = () => {
          const sel = getSelection()
          if (pre && sel) {
            const range = document.createRange()
            range.selectNodeContents(pre)
            sel.removeAllRanges()
            sel.addRange(range)
          }
          show('Select to copy')
        }
        const commands = text
          .split('\n')
          .filter((l) => l.startsWith('$ '))
          .map((l) => l.slice(2))
        const copy = lang === 'sh' && commands.length > 0 ? commands.join('\n') : text
        if (!navigator.clipboard) {
          selectCode()
          return
        }
        navigator.clipboard.writeText(copy).then(() => show('Copied'), selectCode)
      }}
    >
      <span ref={self}>{label}</span>
    </button>
  )
}
