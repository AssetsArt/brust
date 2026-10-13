import styles from './card.module.css'

export default function Card({ title }: { title: string }) {
  return (
    <section className={styles.card}>
      <h2 className={`${styles.title} lead`}>{title}</h2>
      <p className={styles['note']}>note</p>
    </section>
  )
}
