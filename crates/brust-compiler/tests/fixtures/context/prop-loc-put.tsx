const el = <b>hi</b>
const slots: Record<string, unknown> = {}
function put(o: Record<string, unknown>, v: unknown) {
  o.icon = v
}
put(slots, el)
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={slots.icon} /></section>
}
