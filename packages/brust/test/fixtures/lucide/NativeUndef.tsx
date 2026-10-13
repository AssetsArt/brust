import { Heart } from 'lucide-react'
import { useState } from 'react'

export default function NativeUndefined() {
  const [n, setN] = useState<number | undefined>(undefined)
  return (
    <div>
      <button id="set" onClick={() => setN(8)}>
        set
      </button>
      <button id="unset" onClick={() => setN(undefined)}>
        unset
      </button>
      <Heart size={n} />
    </div>
  )
}
