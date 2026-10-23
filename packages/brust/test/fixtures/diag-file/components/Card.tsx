export function Card({ title, ...rest }: { title: string; [k: string]: unknown }) {
  return (
    <section {...rest}>
      <h2>{title}</h2>
    </section>
  )
}
