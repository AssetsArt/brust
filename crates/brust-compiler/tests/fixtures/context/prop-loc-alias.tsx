const slots: Record<string, unknown> = {}
function fill() {
  const s = slots
  s.icon = <b>hi</b>
}
fill()
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={slots.icon} /></section>
}
