// The browser half of `brust dev`, served as `/_brust/dev/client.js?g=<gen>` and injected into every HTML
// response by the proxy. One WebSocket to the parent (`/_brust/dev/ws`):
//   hello  {gen, state, diag}  on every (re)connect — a page older than `gen` reloads (the catch-up), a failing
//                              build shows the overlay above the stale page
//   reload                      a new generation is serving
//   error  {diag}               a build/boot failed
//   css    {href, v}            a public/*.css changed: swap the <link>, keep the page
//   css-swap {gen, map}          only built stylesheets changed (L19/L21): a new generation serves; swap each
//                              data-brust-css link old href -> new href, keep the page (no reload)
// WS, not SSE: SSE holds one of the six per-host connections, so six tabs would stall (R13.2).
// The overlay lives in a shadow root, so page CSS cannot touch it and it cannot touch the page.
export const DEV_CLIENT_JS = String.raw`
let pageGen = Number(new URL(import.meta.url).searchParams.get('g') || 0)
let host = null
let delay = 150

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function clearOverlay() {
  host?.remove()
  host = null
}

function showOverlay(diag) {
  clearOverlay()
  host = document.createElement('brust-dev-overlay')
  const root = host.attachShadow({ mode: 'open' })
  const where = diag.file ? esc(diag.file) + (diag.line ? ':' + diag.line + (diag.col ? ':' + diag.col : '') : '') : ''
  root.innerHTML =
    '<style>:host{all:initial}.box{position:fixed;inset:0;z-index:2147483647;overflow:auto;background:rgba(20,0,0,.88);color:#fdd;font:14px/1.5 ui-monospace,Menlo,monospace;padding:32px}' +
    'h1{margin:0 0 8px;font-size:18px;color:#ff8a80}.where{color:#ffd180;margin-bottom:12px}pre{white-space:pre-wrap;margin:0;color:#fff}small{display:block;margin-top:24px;color:#bbb}</style>' +
    '<div class="box" role="alert" data-testid="brust-dev-overlay"><h1>brust: ' + esc(diag.rule || 'error') + '</h1>' +
    (where ? '<div class="where">' + where + '</div>' : '') +
    '<pre>' + esc(diag.raw || diag.message || '') + '</pre><small>The page below is the last good build. Fix the error and save: this overlay goes away on its own.</small></div>'
  document.documentElement.appendChild(host)
}

function swapCss(href, v) {
  for (const old of document.querySelectorAll('link[rel~="stylesheet"]')) {
    const u = new URL(old.href, location.href)
    if (u.origin !== location.origin || u.pathname !== href) continue
    const next = old.cloneNode()
    next.href = href + '?v=' + v
    next.onload = () => old.remove()
    next.onerror = () => next.remove()
    old.after(next)
  }
}

function swapBuiltCss(map) {
  for (const old of document.querySelectorAll('link[data-brust-css]')) {
    const to = map[new URL(old.href, location.href).pathname]
    if (!to) continue
    const next = old.cloneNode()
    next.href = to
    next.onload = () => old.remove()
    next.onerror = () => next.remove()
    old.after(next)
  }
}

function handle(m) {
  if (m.type === 'hello') {
    if (m.state === 'error' && m.diag) showOverlay(m.diag)
    else {
      clearOverlay()
      if (m.gen > pageGen) location.reload()
    }
  } else if (m.type === 'reload') location.reload()
  else if (m.type === 'error') showOverlay(m.diag)
  else if (m.type === 'css') swapCss(m.href, m.v)
  else if (m.type === 'css-swap') {
    pageGen = m.gen
    swapBuiltCss(m.map)
  }
}

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/_brust/dev/ws')
  ws.onopen = () => {
    delay = 150
  }
  ws.onmessage = (e) => handle(JSON.parse(e.data))
  ws.onclose = () => {
    setTimeout(connect, delay)
    delay = Math.min(delay * 2, 2000)
  }
}
connect()
`
