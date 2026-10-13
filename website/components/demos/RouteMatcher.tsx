// Demo, native tier: type a path and see which route of the pokedex example answers it, with the decoded params.
// The matching runs in the input handler (route order, {param} segments, percent-decoding, the catch-all last).
import { useEffect, useRef, useState } from 'react'

export default function RouteMatcher({ initialPath, initialPattern, initialParams }: { initialPath: string; initialPattern: string; initialParams: string[] }) {
  const root = useRef<HTMLInputElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [path, setPath] = useState(initialPath)
  const [pattern, setPattern] = useState(initialPattern)
  const [params, setParams] = useState(initialParams)
  return (
    <div className="matcher grid min-w-0 gap-3">
      <label className="sr-only" htmlFor="rm-path">
        Path
      </label>
      <input
        ref={root}
        id="rm-path"
        className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]"
        value={path}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const p = e.target.value
          setPath(p)
          const clean = p.split('?')[0]!.split('#')[0]!
          const segs = clean.split('/').filter((s) => s !== '')
          const routes = ['/', '/pokedex', '/pokemon/{name}']
          let hit = '*'
          let found: string[] = []
          for (const r of routes) {
            const rs = r.split('/').filter((s) => s !== '')
            if (rs.length !== segs.length) continue
            const got: string[] = []
            let ok = true
            for (let i = 0; i < rs.length; i++) {
              const want = rs[i]!
              const seg = segs[i]!
              if (want.startsWith('{')) {
                let v = seg
                try {
                  v = decodeURIComponent(seg)
                } catch {}
                got.push(`${want.slice(1, -1)} = ${JSON.stringify(v)}`)
              } else if (want !== seg) ok = false
            }
            if (ok) {
              hit = r
              found = got
              break
            }
          }
          setPattern(hit)
          setParams(found)
        }}
      />
      <dl className="m-0 grid grid-cols-3 border border-rule max-narrow:grid-cols-1">
        <div className="min-w-0 border-l border-rule px-[.8rem] py-[.6rem] first:border-l-0 max-narrow:border-t max-narrow:border-l-0 max-narrow:first:border-t-0">
          <dt className="text-[12px] text-ink-2">Route</dt>
          <dd className="m-0 font-mono text-[12.5px]">{pattern}</dd>
        </div>
        <div className="min-w-0 border-l border-rule px-[.8rem] py-[.6rem] first:border-l-0 max-narrow:border-t max-narrow:border-l-0 max-narrow:first:border-t-0">
          <dt className="text-[12px] text-ink-2">Params</dt>
          <dd className={params.length === 0 ? 'm-0 font-mono text-[12.5px] text-ink-2' : 'm-0 font-mono text-[12.5px]'}>{params.length === 0 ? 'none' : params.join(', ')}</dd>
        </div>
        <div className="min-w-0 border-l border-rule px-[.8rem] py-[.6rem] first:border-l-0 max-narrow:border-t max-narrow:border-l-0 max-narrow:first:border-t-0">
          <dt className="text-[12px] text-ink-2">Status</dt>
          <dd className="m-0 font-mono text-[12.5px]">{pattern === '*' ? '404' : '200'}</dd>
        </div>
      </dl>
    </div>
  )
}
