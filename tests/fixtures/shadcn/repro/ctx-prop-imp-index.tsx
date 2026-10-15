import { list } from './ctxlib/els'
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={list[0]} /></section>
}
