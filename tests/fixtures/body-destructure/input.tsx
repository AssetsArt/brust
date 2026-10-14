import Sep from './Sep'
import Two from './Two'

export default function Page({ v }: { v: boolean }) {
  return (
    <div>
      <Sep orientation="vertical" className="a" />
      <Sep decorative id="d" />
      <Sep />
      <Two a="1" b="2" c="3" />
    </div>
  )
}
