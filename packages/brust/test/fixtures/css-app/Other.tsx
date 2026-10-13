// Shares Card.module.css with Home: one file, one URL.
import styles from './Card.module.css'
import './other.css'

export default function Other() {
  return (
    <section>
      <h2>other</h2>
      <p className={styles.card}>card</p>
    </section>
  )
}
