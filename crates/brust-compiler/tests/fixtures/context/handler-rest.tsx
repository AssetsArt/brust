import { useState } from 'react'

// F369c: the shape of Radix `Toggle` (native: state of its own, its rest spread through a static `Primitive.button`) given
// event handlers by its caller for events it does not bind itself: the element binds them, read live.
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
      <Toggle onMouseDown={() => setN(n + 1)} onKeyDown={() => setN(n + 10)}>
        t
      </Toggle>
      <p>{n}</p>
    </main>
  )
}
