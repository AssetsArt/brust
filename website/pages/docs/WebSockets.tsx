// WebSockets — Elysia `.ws()` in an actions app: the API, the [actions.ws] limits, pinning, topics, close codes, dev, and what is not supported.
// Source of truth: crates/brust-server/src/ws/ (handshake, hub, socket, upgrade), crates/brust-core/src/{actions,config}.rs (the cross-site rule,
// WsConfig), packages/brust/src/actions/ws.ts (the ServerWebSocket shim), packages/brust/src/dev/proxy.ts (the dev relay), packages/brust/src/build/
// {cf-entry,cloudflare}.ts (the Cloudflare refusal) and the served tests tests/server/ws.test.ts and ws-dev.test.ts, whose fixture is the code below.
// This page is static.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface WebSocketsData {
  toc: TocItem[]
  blocks: Record<'actions' | 'client' | 'guard' | 'topics' | 'config', CodeBlockData>
}

const ACTIONS = `// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

export default new Elysia({ adapter: brust() })
  .ws('/echo', {
    open(ws) {
      ws.send('hello')
    },
    message(ws, message) {
      ws.send(message)
    },
    close(ws, code, reason) {
      console.log('closed', code, reason)
    },
  })`

const CLIENT = `// in the browser, with [actions] prefix = "/api" and no base path
const socket = new WebSocket(\`\${location.origin.replace('http', 'ws')}/api/echo\`)
socket.addEventListener('message', (e) => console.log(e.data))
socket.addEventListener('open', () => socket.send('ping'))`

const GUARD = `new Elysia({ adapter: brust() })
  .derive(({ cookie }) => ({ user: cookie.sid?.value ?? null }))
  .guard({ beforeHandle: ({ user, status }) => (user ? undefined : status(401, 'sign in first')) })
  .ws('/private', {
    open(ws) {
      ws.send(\`hello \${ws.data.user}\`)
    },
  })`

const TOPICS = `new Elysia({ adapter: brust() })
  .ws('/room', {
    open(ws) {
      ws.subscribe('room')
    },
    message(ws, message) {
      ws.publish('room', String(message))   // to every other subscriber, on any worker
    },
    close(ws) {
      ws.publish('room', 'someone left')
    },
  })`

const CONFIG = `# brust.toml (every key optional; these are the defaults)
[actions]
prefix = "/api"

[actions.ws]
enabled = true
max_payload_bytes = 1048576
idle_timeout_s = 120
ping_interval_s = 30
max_connections = 10000
backpressure_bytes = 1048576`

export async function webSocketsLoader(): Promise<WebSocketsData> {
  return {
    toc: [
      { id: 'quickstart', title: 'A first socket' },
      { id: 'upgrade', title: 'The upgrade request' },
      { id: 'socket', title: 'The socket object' },
      { id: 'topics', title: 'Topics' },
      { id: 'limits', title: 'Limits' },
      { id: 'pinning', title: 'One socket, one worker' },
      { id: 'instances', title: 'More than one instance' },
      { id: 'close', title: 'Close codes, drain and restart' },
      { id: 'dev', title: 'brust dev' },
      { id: 'unsupported', title: 'What is not supported' },
    ],
    blocks: {
      actions: codeBlock({ lang: 'ts', file: 'actions.ts', code: ACTIONS }),
      client: codeBlock({ lang: 'ts', file: 'browser', code: CLIENT }),
      guard: codeBlock({ lang: 'ts', file: 'actions.ts', code: GUARD }),
      topics: codeBlock({ lang: 'ts', file: 'actions.ts', code: TOPICS }),
      config: codeBlock({ lang: 'text', file: 'brust.toml', code: CONFIG }),
    },
  }
}

export default function WebSockets({ blocks }: WebSocketsData) {
  return (
    <>
      <h1>WebSockets</h1>
      <Lead>
        A WebSocket is an Elysia <code>.ws()</code> route in your actions app. The Rust server does the protocol work (the handshake, the frames, ping and pong, the limits, the topics, the drain on shutdown); Bun runs only your handlers.
      </Lead>
      <p>
        There is no second API to learn: <code>.ws()</code> is Elysia&rsquo;s, the handlers get Elysia&rsquo;s <code>ws</code>, and the route sits under the same <code>[actions] prefix</code> as your other actions. WebSockets run on the Bun target (
        <code>brust start</code> and <code>brust dev</code>). See <a href="#unsupported">What is not supported</a> for the rest.
      </p>

      <h2 id="quickstart">A first socket</h2>
      <CodeBlock code={blocks.actions.code} lang={blocks.actions.lang} file={blocks.actions.file} html={blocks.actions.html} />
      <CodeBlock code={blocks.client.code} lang={blocks.client.lang} file={blocks.client.file} html={blocks.client.html} />
      <ul>
        <li>
          The URL is the actions prefix plus the route path. When you set <code>[server] base_path</code>, an explicit <code>prefix</code> must lie under it: with <code>base_path = &quot;/app&quot;</code> and <code>prefix = &quot;/app/api&quot;</code> the
          socket is <code>/app/api/echo</code>.
        </li>
        <li>
          Only a <code>GET</code> with <code>Upgrade: websocket</code> under the actions prefix is a socket upgrade. Anywhere else the header is ignored and the request is the plain request it also is.
        </li>
        <li>Text and binary messages both arrive in <code>message</code> and go out through <code>ws.send</code>; a binary message is a <code>Buffer</code>.</li>
      </ul>

      <h2 id="upgrade">The upgrade request</h2>
      <p>
        Before a worker is called, Rust checks the handshake: <code>GET</code>, an <code>Upgrade: websocket</code> and a <code>Connection: upgrade</code> token, <code>Sec-WebSocket-Version: 13</code> and a 16-byte base64{' '}
        <code>Sec-WebSocket-Key</code>. A bad one is a <strong>400</strong>; a wrong version is a <strong>426</strong> with <code>Sec-WebSocket-Version: 13</code>. Then the upgrade is an ordinary request to your app: <code>derive</code>, validation,{' '}
        <code>beforeHandle</code>, guards and cookies all run on it, and <code>ws.data</code> is the Elysia context they built.
      </p>
      <CodeBlock code={blocks.guard.code} lang={blocks.guard.lang} file={blocks.guard.file} html={blocks.guard.html} />
      <ul>
        <li>A hook that returns a response refuses the upgrade with that response&rsquo;s status. The browser sees a failed connection; a client that is not a browser sees the status (401 above).</li>
        <li>
          <strong>Cross-site.</strong> A socket upgrade is judged like a mutation under <code>[actions] cross_site</code>: with <code>&quot;reject&quot;</code> (the default) an <code>Origin</code> from another site is a <strong>403</strong>, and a request with no{' '}
          <code>Origin</code> (a server-side client) is allowed. The <code>[cors] origins</code> list is honoured. Browsers always send an <code>Origin</code> with a WebSocket, so a page of another site cannot open your socket with the visitor&rsquo;s cookies.
        </li>
        <li>
          Upgrades are refused while the server drains (<strong>503</strong>), past <code>max_connections</code> (<strong>503</strong>), and with <code>enabled = false</code> (<strong>501</strong>).
        </li>
      </ul>

      <h2 id="socket">The socket object</h2>
      <p>
        <code>ws</code> is Elysia&rsquo;s <code>ElysiaWS</code> over a <code>ServerWebSocket</code> that brust provides: <code>data</code>, <code>send</code> (<code>sendText</code>, <code>sendBinary</code>), <code>close</code>, <code>terminate</code>,{' '}
        <code>ping</code>, <code>pong</code>, <code>subscribe</code>, <code>unsubscribe</code>, <code>isSubscribed</code>, <code>subscriptions</code>, <code>publish</code> (<code>publishText</code>, <code>publishBinary</code>), <code>cork</code>,{' '}
        <code>remoteAddress</code>, <code>readyState</code> and <code>binaryType</code>. The handlers are <code>open</code>, <code>message</code>, <code>drain</code>, <code>close</code>, <code>ping</code> and <code>pong</code>.
      </p>
      <ul>
        <li>
          <strong><code>send</code> returns a number</strong>, as in Bun: more than 0 is the bytes accepted; <strong>-1</strong> means the message was accepted but the socket&rsquo;s outbound queue is past <code>backpressure_bytes</code> (slow down);{' '}
          <strong>0</strong> means it was dropped, because the queue is over the limit (or the socket is closed). When the queue empties after a -1 or a 0, <code>drain</code> runs. With <code>closeOnBackpressureLimit: true</code> the socket is closed with 1013
          instead of dropping.
        </li>
        <li>
          Events of one socket reach your handlers in arrival order, with at most 8 in flight: a slow <code>message</code> handler stops the server reading that socket, and TCP back-pressure reaches the client.
        </li>
        <li>
          Every handler runs in the store context captured at the upgrade, so a <code>defineStore</code> store or a request-scoped value reads as it did in the upgrade request.
        </li>
      </ul>

      <h2 id="topics">Topics</h2>
      <CodeBlock code={blocks.topics.code} lang={blocks.topics.lang} file={blocks.topics.file} html={blocks.topics.html} />
      <ul>
        <li>
          A topic is a name. <code>ws.subscribe(topic)</code> joins it; <code>ws.publish(topic, data)</code> sends to every subscriber <strong>on any worker</strong>, except the publisher unless the route sets <code>publishToSelf: true</code>.
        </li>
        <li>
          Publish only with <code>ws.publish</code> inside a socket handler. <code>server.publish</code> does not reach the sockets in this release, both in an HTTP action (<code>server</code> is null) and from module scope (<code>app.server</code> is not set
          on your app, so a message-bus subscriber cannot publish into a topic).
        </li>
        <li>A message is queued once and shared by every subscriber&rsquo;s queue. A socket leaves its topics when it closes.</li>
      </ul>

      <h2 id="limits">Limits</h2>
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Default</th>
            <th>Range</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>enabled</code>
            </td>
            <td>
              <code>true</code>
            </td>
            <td>boolean</td>
            <td>
              <code>false</code> answers every upgrade 501.
            </td>
          </tr>
          <tr>
            <td>
              <code>max_payload_bytes</code>
            </td>
            <td>1048576</td>
            <td>1 – 67108864</td>
            <td>The largest message (after reassembling fragments). A bigger one closes the socket with 1009.</td>
          </tr>
          <tr>
            <td>
              <code>idle_timeout_s</code>
            </td>
            <td>120</td>
            <td>0 – 86400</td>
            <td>A socket that sends the server no frame for this long (a pong counts) is closed with 1001 &quot;idle timeout&quot;. 0 turns it off.</td>
          </tr>
          <tr>
            <td>
              <code>ping_interval_s</code>
            </td>
            <td>30</td>
            <td>0 – 86400</td>
            <td>The server pings this often, which keeps the idle timer fed by live clients. 0 turns it off.</td>
          </tr>
          <tr>
            <td>
              <code>max_connections</code>
            </td>
            <td>10000</td>
            <td>1 – 1000000</td>
            <td>Open sockets per server process. The next upgrade is a 503.</td>
          </tr>
          <tr>
            <td>
              <code>backpressure_bytes</code>
            </td>
            <td>1048576</td>
            <td>1 – 67108864</td>
            <td>The outbound queue of one socket, in bytes. See <code>send</code> above.</td>
          </tr>
        </tbody>
      </table>
      <p>
        These are the <strong>maxima</strong>. The Elysia options of your <code>.ws()</code> routes (<code>maxPayloadLength</code>, <code>idleTimeout</code> in seconds, <code>backpressureLimit</code>, <code>closeOnBackpressureLimit</code>,{' '}
        <code>publishToSelf</code>, <code>sendPings</code>) are sent with each upgrade and may <strong>lower</strong> a limit, never raise it. As in Bun there is one WebSocket configuration per app, so the options are app-wide. <code>perMessageDeflate</code>{' '}
        is ignored. A value out of range is a build error that names the key.
      </p>

      <h2 id="pinning">One socket, one worker</h2>
      <p>
        Your handlers are closures: they live in the memory of the Bun worker that ran the upgrade. So a socket stays on that worker for its whole life, and its events always run there. Workers are chosen by load: an upgrade goes to the worker with the{' '}
        <strong>fewest open sockets</strong> among those that can take it, so with <code>--workers 2</code> two sockets land on two workers.
      </p>
      <ul>
        <li>
          Module-level state is per worker. Two sockets on different workers do not see the same <code>Map</code>. To reach sockets of another worker, use a <a href="#topics">topic</a>; to share data, use a database or a cache.
        </li>
        <li>A worker that is busy with a long HTTP request does not slow a socket down: socket events do not use the render slots that pages and actions share.</li>
      </ul>

      <h2 id="instances">More than one instance</h2>
      <Note tag="Scope">
        Topics live inside one server process, and brust does not forward them to another process or machine. If you run several instances, carry messages between them yourself with a message bus (NATS, Redis pub/sub or the like), and have each
        instance deliver what it receives to the sockets it holds (a bus subscriber cannot publish into a topic yet, see <a href="#topics">Topics</a>, so keep those sockets in your handlers&rsquo; own state). A client that reconnects lands on whichever instance the load balancer picks.
      </Note>

      <h2 id="close">Close codes, drain and restart</h2>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1000</td>
            <td>A normal close, from either side.</td>
          </tr>
          <tr>
            <td>1001</td>
            <td>
              The server is shutting down (<code>SIGTERM</code> or <code>SIGINT</code>), or the socket was idle past <code>idle_timeout_s</code>.
            </td>
          </tr>
          <tr>
            <td>1002 / 1007</td>
            <td>A protocol error / text that is not UTF-8.</td>
          </tr>
          <tr>
            <td>1009</td>
            <td>
              A message over <code>max_payload_bytes</code>.
            </td>
          </tr>
          <tr>
            <td>1012</td>
            <td>
              <code>brust dev</code> restarted the app (see below).
            </td>
          </tr>
          <tr>
            <td>1013</td>
            <td>
              The outbound queue passed its limit and the route has <code>closeOnBackpressureLimit: true</code>.
            </td>
          </tr>
          <tr>
            <td>1006</td>
            <td>Seen by the client when the connection dropped with no close frame.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>Drain.</strong> On <code>SIGTERM</code> or <code>SIGINT</code> the server stops accepting connections, sends every open socket a close <strong>1001 &quot;going away&quot;</strong>, and waits for the peer&rsquo;s close frame or the rest of{' '}
        <code>BRUST_DRAIN_TIMEOUT_MS</code> (10 seconds by default), then drops what is left and exits. A socket counts as an open connection for the drain, so a deploy does not cut sockets without telling them. Write the client to reconnect on 1001 and 1006,
        with a delay and some jitter.
      </p>

      <h2 id="dev">brust dev</h2>
      <p>
        The dev server is a proxy in front of your app, and it relays a socket upgrade under the actions prefix to the app, so the same URL works in development: the base path, the cookies and the <code>Origin</code> check are the ones above. A refusal by your
        app (a guard&rsquo;s 401) reaches the browser as the HTTP status. When you save a file and the app restarts, open sockets are closed with <strong>1012 &quot;service restart&quot;</strong>; the page reloads and connects again. The proxy answers 421 for a
        Host it does not know, as it does for the page.
      </p>

      <h2 id="unsupported">What is not supported</h2>
      <ul>
        <li>
          <strong>Cloudflare Workers.</strong> A Worker has no sockets of this kind. <code>brust build --target cloudflare</code> prints <code>warning cf-websocket</code> for a source that calls <code>.ws(</code>, and the app fails to start with{' '}
          <code>WebSocket (.ws()) is not supported on --target cloudflare</code>; the build&rsquo;s own startup check stops with that message. <code>--target static</code> has no actions.
        </li>
        <li>
          <strong>Per-message deflate</strong> (compression is not negotiated) and <strong>subprotocols</strong> (<code>Sec-WebSocket-Protocol</code> is not answered, and the dev proxy does not forward it).
        </li>
        <li>
          <strong>HTTP/2.</strong> Browsers open WebSockets over HTTP/1.1. The extended CONNECT of RFC 8441 is not supported: an upgrade on an HTTP/2 connection is a 400.
        </li>
        <li>
          <strong>Sockets in page routes and loaders.</strong> Only the actions app has <code>.ws()</code>; an upgrade anywhere else is an ordinary request.
        </li>
        <li>
          <strong>Publishing into a topic from outside a socket handler.</strong> From an HTTP action or from module scope (a message-bus subscriber, a timer) there is no way to reach the sockets yet; see <a href="#topics">Topics</a>.
        </li>
        <li>
          <strong>Server-sent events and endless streamed responses.</strong> A response body is read in full before it is sent (limited by <code>max_response_bytes</code> and a 30 second deadline), so a stream that never ends is a 504. Use a WebSocket for
          pushing data to a page.
        </li>
        <li>
          <strong>Elysia version.</strong> <code>.ws()</code> relies on parts of Elysia 2 release candidates that are not public API; a test in brust fails when an update changes them.
        </li>
      </ul>
    </>
  )
}
