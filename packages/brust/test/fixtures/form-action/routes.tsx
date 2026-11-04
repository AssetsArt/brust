import { defineRoutes } from '@brust/core/routes'
import AddToTeam from './components/AddToTeam'

export default function Home() {
  return (
    <main>
      <AddToTeam />
    </main>
  )
}

export const routes = defineRoutes([{ path: '/', Component: Home }])
