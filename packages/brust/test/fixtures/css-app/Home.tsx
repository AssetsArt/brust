// Static page: a global CSS import and a CSS Module (styles.x is a precompute job without L20).
import styles from './Card.module.css'
import './home.css'

export default function Home() {
  return (
    <section>
      <h1>Home</h1>
      <h2>sub</h2>
      <p className={styles.title}>card</p>
    </section>
  )
}
