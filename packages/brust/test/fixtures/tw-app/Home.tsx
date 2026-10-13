// Utilities in .tsx are found by Tailwind's content scan; a module class composed with @apply.
import styles from './Card.module.css'

export default function Home() {
  return (
    <main>
      <h1 id="title" className="text-brand font-bold md:text-4xl hover:underline">Home</h1>
      <p id="card" className={styles.card}>
        card
      </p>
      {/* L32 R33.6(b): pbs-* exists only from Tailwind 4.2.0 (changelog 4.2.0 "Added", #19601), so it proves the compiler is the app's */}
      <p id="logical" className="pbs-4">
        logical
      </p>
    </main>
  )
}
