import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

const app = new Elysia({ adapter: brust() }).get('/rows', () => ({
  rows: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
}))

export default app
export type App = typeof app
