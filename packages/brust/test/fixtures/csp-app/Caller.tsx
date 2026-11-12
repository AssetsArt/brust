import { client } from '@brust/core/client'
import { useReducer, useTransition } from 'react'
import type { App } from './actions'

// A React island (useTransition): it calls the actions app through `client()`, which reads the injected
// __BRUST_ACTION_PREFIX__ / __BRUST_BASE_PATH__ globals (inline scripts the policy allows by hash).
export default function Caller() {
  useTransition()
  const [out, show] = useReducer((_: string, next: string) => next, 'idle')
  const api = client<App>()
  return (
    <div>
      <button type="button" data-testid="echo" onClick={async () => show(JSON.stringify((await api.echo.post({ msg: 'hi' })).data))}>
        echo
      </button>
      <pre data-testid="out">{out}</pre>
    </div>
  )
}
