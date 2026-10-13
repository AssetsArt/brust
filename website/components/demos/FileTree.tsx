// Demo, native tier: the blank template's files; pick one to read what it is for.
import { useEffect, useRef, useState } from 'react'

export default function FileTree({ files }: { files: { path: string; role: string }[] }) {
  const root = useRef<HTMLUListElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [open, setOpen] = useState(files[0]!.path)
  return (
    <div className="tree grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-start gap-4 max-narrow:grid-cols-1">
      <ul className="tree-list m-0 grid list-none gap-[.15rem] pl-[1.2rem] font-mono text-[13px]" ref={root}>
        {files.map((f) => (
          <li key={f.path} className="my-[.3rem] max-w-[68ch]">
            <button
              type="button"
              aria-pressed={open === f.path}
              onClick={() => setOpen(f.path)}
              className="w-full cursor-pointer rounded-xs border border-transparent bg-transparent px-2 py-1 text-left text-ink-2 [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit] hover:text-ink aria-pressed:border-rule aria-pressed:bg-paper aria-pressed:text-ink"
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="tree-role" aria-live="polite">
        {files.map((f) => (
          <p key={f.path} hidden={open !== f.path} className="text-[15px]">
            <code>{f.path}</code> {f.role}
          </p>
        ))}
      </div>
    </div>
  )
}
