const slots: Record<string, unknown> = {}
Object.assign(slots, { icon: <b>hi</b> })
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={slots.icon} /></section>
}
