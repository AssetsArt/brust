import type { BrustRequest, Middleware } from './routes.ts'
import type { StandardSchemaV1, InferOutput } from './standard-schema.ts'

const RESPOND = Symbol('brust.respond')
export interface ActionResponseSentinel {
  readonly [RESPOND]: true
  status: number
  body: unknown
  headers?: Record<string, string>
}
export function isRespondSentinel(v: unknown): v is ActionResponseSentinel {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[RESPOND] === true
}
export function makeRespond() {
  return (
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> },
  ): ActionResponseSentinel => ({
    [RESPOND]: true,
    status: init?.status ?? 200,
    body,
    headers: init?.headers,
  })
}

export interface ActionContext<
  Body = unknown,
  Params = Record<string, string>,
  Query = Record<string, string>,
> {
  req: BrustRequest
  body: Body
  params: Params
  query: Query
  headers: Record<string, string>
  respond: (
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> },
  ) => ActionResponseSentinel
}
type Handler<B, P, Q, R> = (ctx: ActionContext<B, P, Q>) => R | Promise<R>

export interface EndpointOptions {
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  middleware?: Middleware[]
}
export interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  path: string
  handler: (ctx: ActionContext) => unknown
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  middleware: Middleware[]
}

type ParamKeys<P extends string> = P extends `${string}{${infer K}}${infer Rest}`
  ? (K extends `*${infer C}` ? C : K) | ParamKeys<Rest>
  : never
type Params<P extends string> = [ParamKeys<P>] extends [never]
  ? Record<string, string>
  : { [K in ParamKeys<P>]: string }
type BodyOf<O> = O extends { body: infer S }
  ? S extends StandardSchemaV1
    ? InferOutput<S>
    : unknown
  : unknown
type QueryOf<O> = O extends { query: infer S }
  ? S extends StandardSchemaV1
    ? InferOutput<S>
    : unknown
  : Record<string, string>

export type EndpointEntry = { input: unknown; output: unknown }
export type EndpointMap = Record<string, Partial<Record<EndpointDef['method'], EndpointEntry>>>

export function isValidEndpointPath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && p.startsWith('/') && !/[\s?#]/.test(p)
}

// biome-ignore lint/complexity/noBannedTypes: `{}` is the intersection identity for `Acc & {...}` endpoint-type accumulation; Record<string,never> would poison the intersection
export interface ActionsBuilder<Acc extends EndpointMap = {}> {
  endpoints: EndpointDef[]
  use(mw: Middleware): ActionsBuilder<Acc>
  get<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { GET: { input: QueryOf<O>; output: Awaited<R> } } }>
  post<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { POST: { input: BodyOf<O>; output: Awaited<R> } } }>
  put<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { PUT: { input: BodyOf<O>; output: Awaited<R> } } }>
  patch<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { PATCH: { input: BodyOf<O>; output: Awaited<R> } } }>
  delete<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { DELETE: { input: BodyOf<O>; output: Awaited<R> } } }>
}

export function defineActions(): ActionsBuilder {
  const endpoints: EndpointDef[] = []
  const globalMw: Middleware[] = []
  const seen = new Set<string>()
  function add(
    method: EndpointDef['method'],
    path: string,
    handler: (c: ActionContext) => unknown,
    opts?: EndpointOptions,
  ) {
    if (!isValidEndpointPath(path))
      throw new Error(
        `defineActions: invalid endpoint path ${JSON.stringify(path)} (must start with '/', no whitespace/?#)`,
      )
    const key = `${method} ${path}`
    if (seen.has(key)) throw new Error(`defineActions: duplicate endpoint ${key}`)
    seen.add(key)
    endpoints.push({
      method,
      path,
      handler,
      body: opts?.body,
      query: opts?.query,
      middleware: [...globalMw, ...(opts?.middleware ?? [])],
    })
  }
  const builder = {
    endpoints,
    use(mw: Middleware) {
      globalMw.push(mw)
      return builder
    },
    get(p: string, h: any, o?: EndpointOptions) {
      add('GET', p, h, o)
      return builder
    },
    post(p: string, h: any, o?: EndpointOptions) {
      add('POST', p, h, o)
      return builder
    },
    put(p: string, h: any, o?: EndpointOptions) {
      add('PUT', p, h, o)
      return builder
    },
    patch(p: string, h: any, o?: EndpointOptions) {
      add('PATCH', p, h, o)
      return builder
    },
    delete(p: string, h: any, o?: EndpointOptions) {
      add('DELETE', p, h, o)
      return builder
    },
  }
  return builder as unknown as ActionsBuilder
}

export { RESPOND }
