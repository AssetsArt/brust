// What happens when a page on one origin calls actions on another: the server's CORS preflight, the cross-site guard,
// and the browser's credentials rule, as plain functions the CrossOriginCheck demo runs in the browser. No request is
// sent. Every rule cites the server code it mirrors (files at v2 @00e116c, merged into docs-site @0689b0c).

export type Credentials = 'same-origin' | 'include' | 'omit'

export interface CrossOriginInput {
  /** The page's origin (`https://app.example.com`). */
  page: string
  /** The actions deployment's origin: `[actions] base_url` on the pages side. */
  actions: string
  /** `[cors] origins` on the actions side, one per line or comma separated; empty = no `[cors]`. */
  corsOrigins: string
  /** `[cors] credentials` on the actions side. */
  corsCredentials: boolean
  /** `[actions] credentials` on the pages side (the client's default `RequestInit.credentials`). */
  credentials: Credentials
  method: 'GET' | 'POST'
  /** `[actions] cross_site` on the actions side. */
  crossSite: 'reject' | 'allow'
}

export interface Step {
  /** Who decides: the actions server, or the visitor's browser. */
  who: 'server' | 'browser' | 'config'
  text: string
}

export interface CrossOriginResult {
  steps: Step[]
  /** The outcome in one word, for the badge and the tests. */
  outcome: 'ok' | 'blocked' | 'rejected' | 'boot-error' | 'invalid'
}

const origin = (s: string): string | null => {
  // source: packages/brust/src/actions/prefix.ts:28-41 (base_url is an absolute http(s) origin: no path, query, fragment or credentials)
  const v = s.trim()
  if (!/^https?:\/\/[^/?#@\\\s]+$/.test(v)) return null
  try {
    return new URL(v).origin
  } catch {
    return null
  }
}

export function checkCrossOrigin(i: CrossOriginInput): CrossOriginResult {
  const page = origin(i.page)
  const api = origin(i.actions)
  if (!page || !api) return { outcome: 'invalid', steps: [{ who: 'config', text: 'both origins must be absolute http(s) origins, such as https://api.example.com (no path)' }] }
  const list = i.corsOrigins
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter((o) => o !== '')
  const wildcard = list.includes('*')
  // source: crates/brust-core/src/config.rs:46-58 (credentials with a wildcard origin, or an empty origins list, is a boot error); docs/actions.md §8
  if (wildcard && i.corsCredentials)
    return { outcome: 'boot-error', steps: [{ who: 'config', text: "brust start refuses this [cors]: cors.credentials cannot be combined with a wildcard origin '*'" }] }
  const steps: Step[] = []
  if (page.toLowerCase() === api.toLowerCase()) {
    // source: crates/brust-core/src/actions.rs:136-147 (an Origin whose authority is the request host passes the guard)
    steps.push({ who: 'browser', text: 'same origin: no preflight, no CORS headers needed' })
    steps.push({ who: 'server', text: `${i.method} reaches your app: the Origin matches the host` })
    return { outcome: 'ok', steps }
  }
  // source: docs/actions.md §8 (Eden sends content-type: application/json, so every cross-origin call, GET included, is preflighted)
  steps.push({ who: 'browser', text: `cross-origin: the browser first sends OPTIONS ${api}/… (Eden's JSON content-type makes it a preflighted request)` })
  // source: crates/brust-core/src/cors.rs:87-98 (allow_origin_value: "*" under a wildcard, the echoed origin on an exact match, else none)
  const listed = list.includes(page)
  const acao = wildcard ? '*' : listed ? page : null
  if (list.length === 0 || acao === null) {
    // source: crates/brust-core/src/pipeline.rs:84-94 (only an allowed origin gets the Rust 204; any other preflight carries no CORS headers)
    steps.push({ who: 'server', text: list.length === 0 ? 'no [cors] on the actions server: the preflight gets no CORS headers' : `${page} is not in [cors] origins: the preflight gets no CORS headers` })
    steps.push({ who: 'browser', text: 'the browser stops here: the request is never sent, and the client resolves with an error' })
    return { outcome: 'blocked', steps }
  }
  steps.push({ who: 'server', text: `204 preflight from Rust, Access-Control-Allow-Origin: ${acao}${i.corsCredentials ? ', Access-Control-Allow-Credentials: true' : ''}` })
  if (i.credentials === 'include' && (acao === '*' || !i.corsCredentials)) {
    // Fetch standard: a credentialed request needs the exact origin echoed and Allow-Credentials: true.
    // source: docs/actions.md §11 ("credentials = include only works if [cors] lists the exact page origin, a wildcard does not count, with credentials = true")
    steps.push({ who: 'browser', text: acao === '*' ? 'credentials: include with Access-Control-Allow-Origin: * is refused by the browser' : 'credentials: include needs [cors] credentials = true: the browser refuses the response' })
    return { outcome: 'blocked', steps }
  }
  if (i.method === 'POST' && i.crossSite === 'reject') {
    // source: crates/brust-core/src/actions.rs:112-147 and cors.rs:101-107 (a cross-site mutation passes only if its Origin is listed by name; "*" never counts)
    if (!listed) {
      steps.push({ who: 'server', text: `POST: 403 CrossSiteRejected before the body is read (a wildcard in [cors] does not count; list ${page} or set cross_site = "allow")` })
      return { outcome: 'rejected', steps }
    }
    steps.push({ who: 'server', text: 'POST: the cross-site guard lets it through, the Origin is listed by name' })
  } else {
    // source: crates/brust-core/src/actions.rs:119-121 (GET/HEAD/OPTIONS, or cross_site = "allow", skip the guard)
    steps.push({ who: 'server', text: i.method === 'GET' ? 'GET: reads are never checked by the cross-site guard' : 'POST: cross_site = "allow" turns the guard off' })
  }
  steps.push({ who: 'server', text: 'your Elysia app answers; Rust stamps the CORS headers on the response' })
  if (i.credentials === 'include') {
    // source: docs/actions.md §11 (a cookie that must travel cross-site needs SameSite=None; Secure)
    steps.push({ who: 'browser', text: 'cookies travel both ways, if the action set them with SameSite=None; Secure' })
  } else {
    steps.push({ who: 'browser', text: i.credentials === 'omit' ? 'no cookies are sent or stored (credentials: omit)' : 'no cookies are sent: same-origin is the default, the actions are on another origin' })
  }
  return { outcome: 'ok', steps }
}
