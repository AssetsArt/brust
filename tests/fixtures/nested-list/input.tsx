import { useState } from 'react'
import { fmt } from './money'

type Row = { id: string; cells: number[] }

export default function Grid({ rows, unit }: { rows: Row[]; unit: string }) {
  const [scale, setScale] = useState(2)
  return (
    <table onClick={() => setScale(scale + 1)}>
      {rows.map((row, ri) => (
        <tr key={row.id}>
          {row.cells.map((c) => (
            <td key={c}>{fmt(c * scale, unit)} #{ri}</td>
          ))}
        </tr>
      ))}
    </table>
  )
}
