import Wrapper from './Wrapper'
import Cell from './Cell'
export default function Page({ t }: { t?: string }) {
  return (
    <main>
      <table><tbody><tr>
        <Wrapper tone="a" />
        <Wrapper />
        <Cell tone="direct">d</Cell>
        <Wrapper tone={t} />
      </tr></tbody></table>
    </main>
  )
}
