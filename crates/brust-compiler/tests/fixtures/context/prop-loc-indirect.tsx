function renderIcon() {
  return <b>hi</b>
}
function wrapIcon() {
  return renderIcon()
}
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={wrapIcon()} /></section>
}
