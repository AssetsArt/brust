// F471: the example under docs/actions.md "Typed routes" (and the website Actions page), compiled and run. If you
// change a snippet there, change it here: `bun check` is what keeps the docs honest.
import { expect, test } from 'bun:test'
import { Elysia, status, t } from 'elysia'
import { brust } from '../src/actions/elysia'
import { type ActionMiddleware, client } from '../src/actions/client'
import { mountActions } from '../src/actions/load'

// ---- actions/auth.ts
const checkLogin = async (_user: string, pass: string) => pass === 'open sesame'

export const auth = new Elysia().post(
  '/login',
  {
    body: t.Object({ user: t.String(), pass: t.String() }),
    cookie: t.Cookie({ sid: t.Optional(t.String()), csrf: t.Optional(t.String()) }),
    response: {
      200: t.Object({ user: t.String() }),
      401: t.Object({ error: t.Literal('bad credentials') }),
    },
  },
  async ({ body, cookie }) => {
    if (!(await checkLogin(body.user, body.pass))) return status(401, { error: 'bad credentials' })
    cookie.sid.set({ value: 'sid-1', httpOnly: true, path: '/' })
    cookie.csrf.set({ value: 'csrf-1', path: '/' })
    return { user: body.user }
  },
)

// ---- actions/index.ts
const app = new Elysia({ adapter: brust() }).use(auth)
export type App = typeof app

// ---- api.ts
const renew: ActionMiddleware = (req, next) => next(req) // the renewal recipe from Middleware
const api = client<App>({ middleware: [renew] })

export async function login(user: string, pass: string) {
  const r = await api.login.post({ user, pass })
  if (r.error?.status === 401) return r.error.value.error // 'bad credentials'
  return r.data?.user // string | undefined
}

test('the Typed routes example runs: a typed 401 with both cookies, a typed 200 with both cookies', async () => {
  const mounted = mountActions(app as never, '/_brust/action')
  const seen: string[][] = []
  const real = client<App>({
    baseUrl: 'http://l.test',
    fetch: ((u: RequestInfo | URL, i?: RequestInit) => mounted.fetch(new Request(u, i))) as typeof fetch,
    middleware: [
      async (req, next) => {
        const res = await next(req)
        seen.push(res.headers.getSetCookie().map((c) => c.split(';')[0]!).sort())
        return res
      },
    ],
  })
  const bad = await real.login.post({ user: 'ash', pass: 'x' })
  expect(bad.status).toBe(401)
  if (bad.error?.status === 401) {
    const e: 'bad credentials' = bad.error.value.error
    expect(e).toBe('bad credentials')
  } else throw new Error('expected a typed 401')
  const ok = await real.login.post({ user: 'ash', pass: 'open sesame' })
  expect(ok.data?.user).toBe('ash')
  expect(seen).toEqual([[], ['csrf=csrf-1', 'sid=sid-1']])
})
