// Native: the class map reaches the client chunk too.
import { useState } from 'react'
import styles from './Btn.module.css'

export default function Native() {
  const [n, setN] = useState(0)
  return (
    <button id="btn" className={styles.btn} onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
