import { el } from './lib/els'

function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  const on = true
  return <section><Badge icon={on ? el : null} /></section>
}
