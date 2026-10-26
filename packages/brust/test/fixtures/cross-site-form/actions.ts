import { Elysia } from 'elysia'
import { brust } from '@brust/core/elysia'

// `/form` takes an HTML form post (urlencoded or multipart); `/hit` counts how often the worker was reached.
let hits = 0
const app = new Elysia({ adapter: brust() })
  .post('/form', async ({ request }) => {
    hits++
    const f = await request.formData()
    return `saved ${f.get('text') ?? ''}`
  })
  .get('/hits', () => ({ hits }))

export default app
export type App = typeof app
