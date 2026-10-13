import s from './card.module.css'

export default function Static() {
  return (
    <main>
      <p className={s.card} data-hero={s['hero']}>
        card
      </p>
      <p className={`${s.card} extra`}>joined</p>
    </main>
  )
}
