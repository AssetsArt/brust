import { useState } from 'react'

// F369c negative: the shape of Radix `Toggle` (native: state of its own, its rest spread through a static `Primitive.button`) given
// a handler for the event it binds itself: the order of the two is not proven, so the caller stays on React.
function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ onPressedChange, children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Prim
      type="button"
      aria-pressed={pressed}
      {...buttonProps}
      onClick={() => {
        setPressed(!pressed)
        onPressedChange?.(!pressed)
      }}
    >
      {children}
    </Prim>
  )
}

export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <Toggle onClick={() => setN(n + 1)}>
        t
      </Toggle>
      <p>{n}</p>
    </main>
  )
}
