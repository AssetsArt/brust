import { Live } from './Live'

export function Section({ id }: { id: string }) {
  return (
    <section>
      <Live id={id} />
    </section>
  )
}
