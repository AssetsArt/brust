import { useState } from 'react'

export default function Motion({ tag }: { tag: string }) {
  const [on, setOn] = useState(false)
  return (
    <button type="button" className="motion" data-tag={tag} onClick={() => setOn(!on)}>
      {on ? 'moving' : 'still'}
    </button>
  )
}
