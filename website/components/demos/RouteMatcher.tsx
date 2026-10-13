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
    <div className="matcher">
      <label className="sr" htmlFor="rm-path">
        Path
      </label>
      <input
        ref={root}
        id="rm-path"
        className="demo-in"
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
      <dl className="shipbar">
        <div>
          <dt>Route</dt>
          <dd>{pattern}</dd>
        </div>
        <div>
          <dt>Params</dt>
          <dd className={params.length === 0 ? 'no' : ''}>{params.length === 0 ? 'none' : params.join(', ')}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{pattern === '*' ? '404' : '200'}</dd>
        </div>
      </dl>
    </div>
  )
}
