const icons = { home: <b>hi</b> }
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={icons.home} /></section>
}
