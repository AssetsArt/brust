import { useState } from 'react'
export default function Table(props: { rows: { id: string; name: string }[] }) {
  const [showTotal, setShowTotal] = useState(false)
  return (
    <div>
      <button onClick={() => setShowTotal(!showTotal)}>total</button>
      <table><tbody>
        {props.rows.map((r) => <tr key={r.id}><td>{r.name}</td></tr>)}
        {showTotal && <tr className="total"><td>{props.rows.length}</td></tr>}
      </tbody></table>
    </div>
  )
}
