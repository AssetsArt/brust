import { useState } from 'react'

const START = 5
const TABS = ['one', 'two']

export default function Page() {
  const [n, setN] = useState(START)
  const [tab, setTab] = useState(TABS[0])
  return (
    <div>
      <button onClick={() => setN(n + 1)}>{n}</button>
      <span onClick={() => setTab('two')}>{tab}</span>
    </div>
  )
}
