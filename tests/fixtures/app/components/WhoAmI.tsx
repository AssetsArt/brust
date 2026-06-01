import { useEffect, useState } from 'react'
import { client } from '../../../../runtime/client/index.ts'
import type { Actions } from '../actions'

const api = client<Actions>()

export default function WhoAmI() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    api.whoami.get().then(({ data }) => setUser(data?.user ?? null))
  }, [])
  return <p data-testid="whoami">user: {user === undefined ? '...' : (user ?? '(anonymous)')}</p>
}
