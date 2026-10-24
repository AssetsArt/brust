import { useState } from 'react'

// F369b step B: a native component (state of its own) that spreads its props onto the one element it renders,
// as `Toggle` does; the child of an `asChild` native parent.
export default function Pressable({ children, ...props }: any) {
  const [on, setOn] = useState(false)
  return (
    <button {...props} aria-pressed={on} onClick={() => setOn(!on)}>
      {children}
    </button>
  )
}
