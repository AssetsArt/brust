import { useState } from 'react'

// F369c (Mellow F1): a native child (state of its own) whose rest lands on a text <input>: a caller's `onChange` is the DOM
// `input` event there, as React's is.
export default function Field({ ...props }: any) {
  const [focused, setFocused] = useState(false)
  return <input {...props} data-focused={focused} onFocus={() => setFocused(true)} />
}
