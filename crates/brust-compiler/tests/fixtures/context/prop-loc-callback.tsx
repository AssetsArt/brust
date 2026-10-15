import { icons } from './lib/els'
function call(f: () => unknown) {
  return f()
}
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={call(() => icons.home)} /></section>
}
