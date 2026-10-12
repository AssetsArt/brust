// Demo, native tier: the blank template's files; pick one to read what it is for.
import { useState } from 'react'

export default function FileTree({ files }: { files: { path: string; role: string }[] }) {
  const [open, setOpen] = useState(files[0]!.path)
  return (
    <div className="tree">
      <ul className="tree-list">
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
