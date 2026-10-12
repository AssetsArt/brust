// Demo, native tier: set the pokedex server's port, workers and actions; the brust.toml and the equivalent
// environment override follow (env beats flags beats brust.toml beats defaults).
import { useEffect, useRef, useState } from 'react'

export default function ConfigBuilder() {
  const root = useRef<HTMLDivElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [port, setPort] = useState('1337')
  const [workers, setWorkers] = useState('4')
  const [actions, setActions] = useState(true)
  return (
    <div className="builder">
      <div className="fields" ref={root}>
        <label>
          Port
          <input className="demo-in" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
        </label>
        <label>
          Workers
          <input className="demo-in" inputMode="numeric" value={workers} onChange={(e) => setWorkers(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        </label>
        <label className="sw">
          <input type="checkbox" checked={actions} onChange={(e) => setActions(e.target.checked)} />
          <span className="knob" aria-hidden="true" />
          Actions
        </label>
      </div>
      <pre className="cmd">
        <code>{`# pokedex/brust.toml\n[server]\naddress = "127.0.0.1"\nport = ${port || '1337'}\n\n[workers]\ncount = ${workers || '1'}${actions ? '\n\n[actions]' : ''}`}</code>
      </pre>
      <pre className="cmd">
        <code>{`# the same, for one run, without editing the file\n$ BRUST_PORT=${port || '1337'} BRUST_WORKERS=${workers || '1'} bun run start`}</code>
      </pre>
    </div>
  )
}
