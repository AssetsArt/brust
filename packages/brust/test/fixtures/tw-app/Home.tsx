// Utilities in .tsx are found by Tailwind's content scan; a module class composed with @apply.
import styles from './Card.module.css'

export default function Home() {
  return (
    <main>
      <h1 id="title" className="text-brand font-bold md:text-4xl hover:underline">Home</h1>
      <p id="card" className={styles.card}>
        card
      </p>
    </main>
  )
}
