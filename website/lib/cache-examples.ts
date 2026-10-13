// website/lib/cache-examples.ts — the /docs/caching prefix examples: ONE source for the page, the fixture routes
// (test/fixtures/cache-prefix/routes.tsx), the capture script (scripts/capture-cache-prefix.ts, which runs every step against a real
// `brust start` and records lib/cache-transcripts.json) and the tests (test/cache-prefix.test.ts replays them and cross-checks lib/cache-key.ts).

export type Outcome = 'MISS' | 'HIT' | 'BYPASS'

export interface Step {
  /** Sent as the Cookie header. */
  cookies?: string
  /** Extra request headers (a Host header here is sent as is). */
  headers?: [string, string][]
  /** Query string without the `?`. */
  query?: string
  /** Request path, when it differs from the example's `path` (a route with a param). */
  path?: string
  /** What `x-brust-cache` must say: asserted against the real server by the capture and the test. */
  expect: Outcome
}

export interface Example {
  id: string
  title: string
  /** One sentence: what it splits and why. */
  blurb: string
  /** The route pattern and the path the steps request. */
  route: string
  path: string
  cache: { ttl_seconds: number; prefix?: string; bypass?: string }
  /** Route params the playground needs for param(); the server reads them from `route`. */
  params?: [string, string][]
  steps: Step[]
}

/** Process env at `brust start` for the capture (the `env()` example). */
export const CAPTURE_ENV = { BUILD_ID: 'r1' }

export const EXAMPLES: Example[] = [
  {
    id: 'lang',
    title: 'One entry per language',
    blurb: 'The language comes from the query, then the cookie, then a default; lower() folds TH and th into one entry, and a visitor with no cookie shares the English entry with one who sent lang=en.',
    route: '/ex/lang',
    path: '/ex/lang',
    cache: { ttl_seconds: 60, prefix: "lower(or(query(lang), cookie(lang), 'en'))" },
    steps: [{ expect: 'MISS' }, { expect: 'HIT' }, { cookies: 'lang=th', expect: 'MISS' }, { cookies: 'lang=TH', expect: 'HIT' }, { cookies: 'lang=en', expect: 'HIT' }],
  },
  {
    id: 'tenant',
    title: 'One entry per tenant and language',
    blurb: 'One brust server behind several hostnames: the host is part of the prefix, so tenant a never serves tenant b a page, and the language still splits each tenant.',
    route: '/ex/tenant',
    path: '/ex/tenant',
    cache: { ttl_seconds: 60, prefix: "concat(request(host), '|', lower(or(cookie(lang), 'en')))" },
    steps: [
      { headers: [['Host', 'a.example.com']], expect: 'MISS' },
      { headers: [['Host', 'a.example.com']], expect: 'HIT' },
      { headers: [['Host', 'b.example.com']], expect: 'MISS' },
      { headers: [['Host', 'a.example.com']], cookies: 'lang=EN', expect: 'HIT' },
      { headers: [['Host', 'a.example.com']], cookies: 'lang=th', expect: 'MISS' },
    ],
  },
  {
    id: 'ab',
    title: 'A bounded A/B bucket',
    blurb: 'Only the cookie value b gets its own entry; any other value, including junk, lands in bucket a, so the cache holds two entries however many values arrive.',
    route: '/ex/ab',
    path: '/ex/ab',
    cache: { ttl_seconds: 60, prefix: "concat('ab:', or(eq(cookie(ab), 'b', 'b'), 'a'))" },
    steps: [{ expect: 'MISS' }, { cookies: 'ab=b', expect: 'MISS' }, { cookies: 'ab=b', expect: 'HIT' }, { cookies: 'ab=zzz', expect: 'HIT' }, { cookies: 'ab=a', expect: 'HIT' }],
  },
  {
    id: 'plan',
    title: 'Plan tier, and never cache a signed-in page',
    blurb: 'Anyone with a session cookie skips the cache altogether (bypass); everyone else is cached per tier, pro or free, and an unknown plan value is free.',
    route: '/ex/plan',
    path: '/ex/plan',
    cache: { ttl_seconds: 60, bypass: 'cookie(session)', prefix: "or(eq(cookie(plan), 'pro', 'pro'), 'free')" },
    steps: [
      { expect: 'MISS' },
      { expect: 'HIT' },
      { cookies: 'plan=pro', expect: 'MISS' },
      { cookies: 'plan=pro', expect: 'HIT' },
      { cookies: 'plan=enterprise', expect: 'HIT' },
      { cookies: 'session=s1', expect: 'BYPASS' },
      { cookies: 'session=s1; plan=pro', expect: 'BYPASS' },
    ],
  },
  {
    id: 'device',
    title: 'Device class',
    blurb: 'Client hints send ?1 for mobile and ?0 for everything else; eq() maps the one value that matters to a name and everything else, including no header, to desktop.',
    route: '/ex/device',
    path: '/ex/device',
    cache: { ttl_seconds: 60, prefix: "or(eq(header(sec-ch-ua-mobile), '?1', 'mobile'), 'desktop')" },
    steps: [{ expect: 'MISS' }, { expect: 'HIT' }, { headers: [['sec-ch-ua-mobile', '?1']], expect: 'MISS' }, { headers: [['sec-ch-ua-mobile', '?1']], expect: 'HIT' }, { headers: [['sec-ch-ua-mobile', '?0']], expect: 'HIT' }],
  },
  {
    id: 'deploy',
    title: 'Per deploy, per route param',
    blurb: 'env() is read once, when the route is installed: set BUILD_ID when you start the server and the key carries the deploy; param() adds the path parameter (already decoded).',
    route: '/ex/deploy/{name}',
    path: '/ex/deploy/pikachu',
    params: [['name', 'pikachu']],
    cache: { ttl_seconds: 60, prefix: "concat(env(BUILD_ID), ':', param(name))" },
    steps: [{ expect: 'MISS' }, { expect: 'HIT' }, { path: '/ex/deploy/eevee', expect: 'MISS' }],
  },
]

/** Pitfall probes (not among the six): what the evaluator sees for an encoded query, and the two ambiguous-request bypasses. */
export const PROBES: Example[] = [
  {
    id: 'decode',
    title: 'The query is decoded before an expression reads it',
    blurb: 'bypass: eq(query(mode), \'draft\', \'yes\'): an encoded name or value reaches the expression decoded.',
    route: '/ex/decode',
    path: '/ex/decode',
    cache: { ttl_seconds: 60, bypass: "eq(query(mode), 'draft', 'yes')" },
    steps: [{ query: 'mode=draft', expect: 'BYPASS' }, { query: 'mode=dr%61ft', expect: 'BYPASS' }, { query: 'mo%64e=draft', expect: 'BYPASS' }, { query: 'mode=live', expect: 'MISS' }],
  },
  {
    id: 'ambiguous',
    title: 'An ambiguous request is never cached',
    blurb: 'The language example again: a query name sent twice, or two cookies whose names differ only in case, is answered with BYPASS.',
    route: '/ex/lang',
    path: '/ex/lang',
    cache: { ttl_seconds: 60, prefix: "lower(or(query(lang), cookie(lang), 'en'))" },
    steps: [{ query: 'a=1&a=2', expect: 'BYPASS' }, { cookies: 'lang=th; Lang=en', expect: 'BYPASS' }],
  },
]

/** The route's `cache` object as shown on the page. */
export function cacheSource(c: Example['cache']): string {
  const lines = [`ttl_seconds: ${c.ttl_seconds}`]
  if (c.bypass !== undefined) lines.push(`bypass: ${JSON.stringify(c.bypass)}`)
  if (c.prefix !== undefined) lines.push(`prefix: ${JSON.stringify(c.prefix)}`)
  return `cache: {\n${lines.map((l) => `  ${l},`).join('\n')}\n}`
}

const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/** The curl command shown and run (`$BASE` is the server's address). */
export function curlCommand(ex: Example, s: Step): string {
  const parts = ['curl -si']
  if (s.cookies) parts.push(`-H ${sq(`Cookie: ${s.cookies}`)}`)
  for (const [k, v] of s.headers ?? []) parts.push(`-H ${sq(`${k}: ${v}`)}`)
  parts.push(`"$BASE${s.path ?? ex.path}${s.query ? `?${s.query}` : ''}"`)
  return `${parts.join(' ')} | grep -E 'x-brust-cache|render'`
}
