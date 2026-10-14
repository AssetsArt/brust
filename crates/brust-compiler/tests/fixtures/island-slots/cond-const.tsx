import { Card } from './ui'

const on = true
const mode = 'dark'

export default function Page() {
  return (
    <Card title="a">
      {on && <b>shown</b>}
      {!on && <b>hidden</b>}
      {mode === 'dark' ? <i>dark</i> : <u>light</u>}
    </Card>
  )
}
