import IslandBox from './IslandBox'
import { literal } from './data'

export default function Page({ box }: { box: { style: Record<string, any>; table: Record<string, string> } }) {
  return (
    <main>
      <p data-testid="plain" style={box.style}>
        plain
      </p>
      <IslandBox style={box.style} cfg={box.table} />
      <ul data-testid="table">
        {Object.entries(box.table).map((e) => (
          <li key={e[0]}>
            {e[0]}={e[1]}
          </li>
        ))}
      </ul>
      <ul data-testid="literal">
        {Object.entries(literal).map((e) => (
          <li key={e[0]}>
            {e[0]}={e[1]}
          </li>
        ))}
      </ul>
    </main>
  )
}
