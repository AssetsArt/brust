// F219 repro: React renders "patched x,y" (C ran before the render); the page imports C only for its effect.
import './f219/patch'
import Label from './f219/Label'
import LabelState from './f219/LabelState'
export default function Page() {
  return (
    <main>
      <Label />
      <LabelState />
    </main>
  )
}
