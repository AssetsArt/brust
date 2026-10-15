const slots: Record<string, unknown> = {}
function get() {
  return slots
}
get().icon = <b>hi</b>
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={slots.icon} /></section>
}
