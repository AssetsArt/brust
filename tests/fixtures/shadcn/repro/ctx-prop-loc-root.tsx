const el = <b>hi</b>

function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  const on = true
  return <section><Badge icon={el} /></section>
}
