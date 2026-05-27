/** Browser dev client. Inlined into the SSR first chunk via a <script
 * type="module">…</script> wrapper. Connects WS at /_brust/dev, handles
 * reload / css-update / error / ok messages, manages a red overlay.
 *
 * Keep this string short — it ships in every dev-mode SSR response. */
export const DEV_CLIENT_JS = String.raw`
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws;
function connect() {
  ws = new WebSocket(proto + '//' + location.host + '/_brust/dev');
  ws.onmessage = function (e) { handle(JSON.parse(e.data)); };
  ws.onclose = function () { setTimeout(connect, 1000); };
  ws.onerror = function () { /* swallow; onclose triggers reconnect */ };
}
function handle(msg) {
  switch (msg.type) {
    case 'reload': location.reload(); break;
    case 'css-update': swapCssLink(msg.href); break;
    case 'error': showOverlay(msg.message, msg.stack); break;
    case 'ok': hideOverlay(); break;
  }
}
function swapCssLink(href) {
  const url = new URL(href, location.origin);
  document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
    if (new URL(link.href).pathname === url.pathname) link.href = href;
  });
}
function showOverlay(msg, stack) {
  let el = document.getElementById('__brust_dev_overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__brust_dev_overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(180,30,30,0.96);color:#fff;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px;z-index:2147483647;white-space:pre-wrap;overflow:auto;';
    document.body.appendChild(el);
  }
  el.textContent = '[brust dev] build error\n\n' + msg + (stack ? '\n\n' + stack : '');
}
function hideOverlay() {
  const el = document.getElementById('__brust_dev_overlay');
  if (el) el.remove();
}
connect();
`.trim()

/** Build the full <script> tag that gets spliced before </head>. */
export function buildDevClientTag(): string {
  return '<script type="module">' + DEV_CLIENT_JS + '</script>'
}
