// The A1/A2 actions entry (`[actions]` in brust.toml): the shared Elysia app on the brust() adapter.
import { brust } from '@brust/core/elysia'
import { actionsApp } from '../_shared/actions-app'

const app = actionsApp({ adapter: brust() })
export default app
export type App = typeof app
