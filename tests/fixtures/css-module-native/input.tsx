import { useState } from 'react'
import styles from './btn.module.css'

export default function Toggle() {
  const [on, setOn] = useState(false)
  return (
    <button type="button" className={on ? styles.on : styles.off} onClick={() => setOn(!on)}>
      {on ? 'on' : 'off'}
    </button>
  )
}
