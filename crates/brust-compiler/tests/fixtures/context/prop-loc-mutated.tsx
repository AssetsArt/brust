const slots: Record<string, unknown> = {}
function fill() {
  slots.icon = <b>hi</b>
}
fill()
function pick() {
  return slots.icon
}
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={pick()} /><Badge icon={slots.icon} /></section>
}
