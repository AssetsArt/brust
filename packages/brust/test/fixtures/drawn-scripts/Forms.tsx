import { useState } from 'react'
import { summary } from './lib/forms'

export default function Forms() {
  const [s, setS] = useState('')
  return (
    <button type="button" id="forms" onClick={() => setS(summary())}>
      forms {s}
    </button>
  )
}
