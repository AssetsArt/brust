import { client } from '@brust/core/client'
import { useReducer } from 'react'
import type { App } from '../api/actions'

// A React island (useReducer): it calls the actions app on another origin through `client()`, which reads the page's
// injected __BRUST_ACTION_BASE__ / __BRUST_ACTION_CREDENTIALS__.
export default function Caller() {
  const [out, show] = useReducer((_: string, next: string) => next, 'idle')
  const api = client<App>()
  return (
    <div>
      <button type="button" data-testid="save" onClick={async () => show(JSON.stringify((await api.team.post({ name: 'ash' })).data))}>
        save
      </button>
      <button type="button" data-testid="load" onClick={async () => show(JSON.stringify((await api.team.get()).data))}>
        load
      </button>
      <pre data-testid="out">{out}</pre>
    </div>
  )
}
