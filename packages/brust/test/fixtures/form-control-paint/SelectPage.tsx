import { useState } from 'react'

// A controlled select picks its option by value; a multiple one by an array; defaultValue the same; the options of a
// list and a group too. React paints `selected` on the match, so the browser shows it before hydration.
export default function SelectPage() {
  const [one, setOne] = useState('b')
  const [many, setMany] = useState(['a', 'c'])
  const [n, setN] = useState(2)
  const [word, setWord] = useState('two')
  return (
    <main>
      <select data-testid="one" value={one} onChange={(e) => setOne(e.target.value)}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
      <p data-testid="one-echo">{one}</p>
      <select data-testid="many" multiple value={many} onChange={() => setMany(['b'])}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
      <select data-testid="num" value={n} onChange={(e) => setN(Number(e.target.value))}>
        {[1, 2, 3].map((k) => (
          <option key={k} value={k}>{`n${k}`}</option>
        ))}
      </select>
      <select data-testid="text" value={word} onChange={(e) => setWord(e.target.value)}>
        <optgroup label="words">
          <option>one</option>
          <option>two</option>
        </optgroup>
      </select>
      <select data-testid="default" defaultValue="c">
        <option value="a">A</option>
        <option value="c">C</option>
      </select>
      <select data-testid="plain">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    </main>
  )
}
