import { useEffect, useState } from 'react'
import { action } from '../../../runtime/client/index.ts'
import type * as srv from '../actions'

const whoAmI = action<typeof srv.whoAmI>('whoAmI')

export default function WhoAmI() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    whoAmI().then((r) => setUser(r.user))
  }, [])
  return <p data-testid="whoami">user: {user === undefined ? '...' : (user ?? '(anonymous)')}</p>
}
