// Demo, native tier: the `brust dev` loop as five buttons. Browser-only: nothing is built or served, the lines are the ones `brust dev` prints (plain mode),
// stepped by the rules the Dev mode page cites. useState only, so the compiler lowers it to a native component (a signal in the browser).
import { useEffect, useRef, useState } from 'react'

const URL = 'http://127.0.0.1:1337'

export default function DevLoopDemo() {
  const root = useRef<HTMLDivElement>(null)
  // mounted marker for tests: the host binds right after the effects run, so wait one microtask (gap G9).
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  // gen: the build the browser is looking at. tries: builds attempted (a failed build still takes a number).
  const [gen, setGen] = useState(1)
  const [tries, setTries] = useState(1)
  const [failed, setFailed] = useState(false)
  const [what, setWhat] = useState('first load')
  const [log, setLog] = useState(`[brust] dev server on ${URL} — [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit\n[brust] ready ${URL} gen 1`)
  return (
    <div className="switch grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3" role="group" aria-label="Save an edit" ref={root}>
        <button
          type="button"
          className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber tabular-nums [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]"
          data-testid="dl-page"
          onClick={() => {
            setTries(tries + 1)
            setGen(tries + 1)
            setFailed(false)
            setWhat('reloaded: a new build is serving')
            setLog(`${log}\n[brust] change detected: pages/HomePage.tsx\n[brust] building ${URL} gen ${gen}\n[brust] ready ${URL} gen ${tries + 1}`)
          }}
        >
          Edit a page
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber tabular-nums [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]"
          data-testid="dl-css"
          onClick={() => {
            setWhat('stylesheet swapped, the page kept its state')
            setLog(`${log}\n[brust] css public/app.css (no reload)`)
          }}
        >
          Edit public/app.css
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber tabular-nums [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]"
          data-testid="dl-break"
          onClick={() => {
            setTries(tries + 1)
            setFailed(true)
            setWhat('overlay above the last good page')
            setLog(`${log}\n[brust] change detected: pages/HomePage.tsx\n[brust] building ${URL} gen ${gen}\n[brust] error ${URL} gen ${gen} — build Expected identifier but found end of file`)
          }}
        >
          Save a syntax error
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber tabular-nums [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]"
          data-testid="dl-fix"
          onClick={() => {
            setTries(tries + 1)
            setGen(tries + 1)
            setFailed(false)
            setWhat('overlay gone, new build serving')
            setLog(`${log}\n[brust] change detected: pages/HomePage.tsx\n[brust] building ${URL} gen ${gen}\n[brust] ready ${URL} gen ${tries + 1}`)
          }}
        >
          Fix it
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber tabular-nums [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold motion-safe:transition-transform motion-safe:duration-100 motion-safe:active:scale-[.97]"
          data-testid="dl-reset"
          onClick={() => {
            setTries(1)
            setGen(1)
            setFailed(false)
            setWhat('first load')
            setLog(`[brust] dev server on ${URL} — [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit\n[brust] ready ${URL} gen 1`)
          }}
        >
          Reset
        </button>
      </div>
      <table data-testid="dl-state">
        <tbody>
          <tr>
            <th scope="row">Serving</th>
            <td data-testid="dl-gen">gen {gen}</td>
          </tr>
          <tr>
            <th scope="row">Builds tried</th>
            <td data-testid="dl-tries">{tries}</td>
          </tr>
          <tr>
            <th scope="row">State</th>
            <td data-testid="dl-status">{failed ? 'error' : 'ready'}</td>
          </tr>
          <tr>
            <th scope="row">Browser</th>
            <td data-testid="dl-what">{what}</td>
          </tr>
        </tbody>
      </table>
      <pre className="m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg" data-testid="dl-log">
        <code>{log}</code>
      </pre>
    </div>
  )
}
