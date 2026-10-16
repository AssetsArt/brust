// useReducer ⇒ a hydrated React island with a CSS Module.
import { useReducer, useTransition } from 'react'
import styles from './Island.module.css'

export default function Counter() {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button id="island" className={styles.island} onClick={bump}>
      {n}
    </button>
  )
}
