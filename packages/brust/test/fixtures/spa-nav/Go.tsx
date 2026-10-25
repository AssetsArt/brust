// useTransition => React tier: an island that calls navigate() from @brust/core (F456), and a mutation through
// @brust/core/client, which clears the page cache (§10.1). The fixture has no actions app: the POST gets a 404, still a
// response, which is all the client needs to clear it.
import { navigate } from '@brust/core'
import { client } from '@brust/core/client'
import { useTransition } from 'react'

export default function Go() {
  useTransition()
  return (
    <div data-page="go">
      <button type="button" id="go" onClick={() => navigate('/list').then(() => { (window as unknown as Record<string, number>).resolved = ((window as unknown as Record<string, number>).resolved ?? 0) + 1 })}>
        go
      </button>
      <button type="button" id="mutate" onClick={() => (client() as unknown as { bump: { post(): Promise<unknown> } }).bump.post().then(() => { (window as unknown as Record<string, number>).mutated = 1 })}>
        mutate
      </button>
      <button type="button" id="go-replace" onClick={() => navigate('/long', { replace: true })}>
        go replace
      </button>
    </div>
  )
}
