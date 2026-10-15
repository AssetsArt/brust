import { createElement } from 'react'
function make() {
  return createElement('b', null, 'hi')
}
function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return <section><Badge icon={make()} /></section>
}
