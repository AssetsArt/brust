import { useState } from 'react'
import { cn } from './cn'
import { KRoot, KThumb } from './Kit'
// the shadcn Switch wrapper's shape: the Thumb's className calls an import, over the page's state
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button data-testid="f" onClick={() => setOn(!on)}>f</button>
      <KRoot data-x="1">
        <KThumb className={cn('thumb', on && 'big')} />
      </KRoot>
    </main>
  )
}
