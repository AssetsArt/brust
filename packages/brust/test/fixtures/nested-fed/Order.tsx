import Kids from './Kids'
import Cell from './Cell'
export default function Order() {
  return (
    <main>
      <table><tbody><tr>
        <Kids tone="w1"><Cell tone="slot1">s1</Cell></Kids>
        <Kids tone="w2"><Cell tone="slot2">s2</Cell></Kids>
      </tr></tbody></table>
    </main>
  )
}
