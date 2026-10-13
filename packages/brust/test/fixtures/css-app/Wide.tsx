// Reads window during render ⇒ a client_only React island with a CSS Module.
import styles from './Island.module.css'

export default function Wide() {
  const wide = window.innerWidth > 800
  return (
    <p id="wide" className={styles.island}>
      {wide ? 'wide' : 'narrow'}
    </p>
  )
}
