import { icons } from './ctxlib/els'
function pickIcon() {
  return icons.home
}
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={pickIcon()} /></section>
}
