import { Island } from './Island'

export function Section({ id }: { id: string }) {
  return (
    <section>
      <Island id={id} />
    </section>
  )
}
