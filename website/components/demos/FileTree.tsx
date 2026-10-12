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
    <div className="tree">
      <ul className="tree-list" ref={root}>
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" aria-pressed={open === f.path} onClick={() => setOpen(f.path)}>
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="tree-role" aria-live="polite">
        {files.map((f) => (
          <p key={f.path} hidden={open !== f.path}>
            <code>{f.path}</code> {f.role}
          </p>
        ))}
      </div>
    </div>
  )
}
