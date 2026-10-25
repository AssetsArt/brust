// useTransition => React tier: an island that calls navigate() from @brust/core (F456).
import { navigate } from '@brust/core'
import { useTransition } from 'react'

export default function Go() {
  useTransition()
  return (
    <div data-page="go">
      <button type="button" id="go" onClick={() => navigate('/list').then(() => { (window as unknown as Record<string, number>).resolved = ((window as unknown as Record<string, number>).resolved ?? 0) + 1 })}>
        go
      </button>
      <button type="button" id="go-replace" onClick={() => navigate('/long', { replace: true })}>
        go replace
      </button>
    </div>
  )
}
