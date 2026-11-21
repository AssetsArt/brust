import { useCounted, useDefaulted, useDerived, useLocalFn, useObject, usePlain } from './hooks'

/** Calls the function it is handed (cell 6 variant: a hook function passed on as an argument). */
const go = (f: () => void) => f()

// F589: each hook's returned function called from an inline handler, through the hook object (I-M, `m*`:
// `onClick={() => s.run()}`) and destructured at the call site (I-D, `d*`: `onClick={() => run()}`). Extra member
// forms: passed on as an argument (`go(s.run)`), read as a value and called (`const f = s.run; f()`), called in a
// nested arrow. The browser case clicks each and compares with what React renders.
export default function Inline({ title, items }: { title: string; items: string[] }) {
  const m1 = usePlain('lit')
  const { v: v1, run: run1 } = usePlain('lit2')
  const m2 = usePlain(title)
  const { v: v2, run: run2 } = usePlain(title)
  const m2d = useDefaulted(title)
  const { v: v2d, run: run2d } = useDefaulted()
  const m3 = useObject({ sel: title })
  const { v: v3, run: run3 } = useObject({ sel: title })
  const m5 = useDerived(title)
  const { v: v5, run: run5 } = useDerived(title)
  const m6 = useLocalFn(title)
  const { v: v6, run: run6 } = useLocalFn(title)
  const m9 = useCounted()
  const { v: v9, run: run9 } = useCounted()
  const ma = useDerived(title)
  return (
    <div>
      <button id="m1" onClick={() => m1.run()}>{m1.v}</button>
      <button id="d1" onClick={() => run1()}>{v1}</button>
      <button id="m2" onClick={() => m2.run()}>{m2.v}</button>
      <button id="d2" onClick={() => run2()}>{v2}</button>
      <button id="m2d" onClick={() => m2d.run()}>{m2d.v}</button>
      <button id="d2d" onClick={() => run2d()}>{v2d}</button>
      <button id="m3" onClick={() => m3.run()}>{m3.v}</button>
      <button id="d3" onClick={() => run3()}>{v3}</button>
      <button id="m5" onClick={() => m5.run()}>{m5.v}</button>
      <button id="d5" onClick={() => run5()}>{v5}</button>
      <button id="m6" onClick={() => m6.run()}>{m6.v}</button>
      <button id="d6" onClick={() => run6()}>{v6}</button>
      <button id="m9" onClick={() => m9.run()}>{m9.v}</button>
      <button id="d9" onClick={() => run9()}>{v9}</button>
      <button id="ma" onClick={() => go(ma.run)}>{ma.v}</button>
      <ul>
        {items.map((it) => (
          <li key={it}>
            <button className="m10" onClick={() => m1.run()}>{it}</button>
            <button className="d10" onClick={() => run9()}>{it}</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
