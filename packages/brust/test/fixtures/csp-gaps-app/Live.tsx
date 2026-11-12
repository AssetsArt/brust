import { client } from '@brust/core/client'
import { useReducer, useTransition } from 'react'
import type { App } from './actions'

// A React island (useTransition): an action through client() and a WebSocket on the actions prefix.
export default function Live() {
  useTransition()
  const [out, show] = useReducer((_: string, next: string) => next, 'idle')
  const api = client<App>()
  return (
    <div>
      <button type="button" data-testid="echo" onClick={async () => show(JSON.stringify((await api.echo.post({ msg: 'hi' })).data))}>
        echo
      </button>
      <button
        type="button"
        data-testid="ws"
        onClick={() => {
          const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/shop/rpc/live`)
          ws.onmessage = (e) => show(`ws:${e.data}`)
          ws.onopen = () => ws.send('ping')
        }}
      >
        ws
      </button>
      <pre data-testid="out">{out}</pre>
    </div>
  )
}
