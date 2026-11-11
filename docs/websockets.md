# WebSockets in an actions app

A WebSocket is an Elysia `.ws()` route in your actions app. The Rust server does the protocol work (handshake, frames, ping and pong, limits, topics, the drain on shutdown); Bun runs only your handlers. There is no second API: `.ws()` is Elysia's, the handlers get Elysia's `ws`, and the route sits under the same `[actions] prefix` as your other actions. WebSockets run on the Bun target (`brust start`, `brust dev`).

The same text, with the dev and Cloudflare notes, is on the docs site at `/docs/websockets`.

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

export default new Elysia({ adapter: brust() })
  .ws('/echo', {
    open(ws) { ws.send('hello') },
    message(ws, message) { ws.send(message) },
    close(ws, code, reason) { console.log('closed', code, reason) },
  })
```

With `[actions] prefix = "/api"` the socket is `ws://host/api/echo`; with `[server] base_path = "/app"` it is `ws://host/app/api/echo`. Only a `GET` with `Upgrade: websocket` under the prefix is an upgrade; anywhere else the header is ignored.

## The upgrade request

Rust checks the handshake before a worker is called: `GET`, `Upgrade: websocket`, a `Connection: upgrade` token, `Sec-WebSocket-Version: 13` and a 16-byte base64 `Sec-WebSocket-Key`. A bad one is **400**; a wrong version is **426** with `Sec-WebSocket-Version: 13`. The upgrade is then an ordinary request to your app: `derive`, validation, `beforeHandle`, guards and cookies run on it, and `ws.data` is the Elysia context they built. A hook that returns a response refuses the upgrade with that status.

- **Cross-site.** An upgrade is judged like a mutation under `[actions] cross_site`: with `"reject"` (the default) an `Origin` of another site is **403**; no `Origin` (a server-side client) is allowed; the `[cors] origins` list is honoured.
- **503** while the server drains and past `max_connections`; **501** with `[actions.ws] enabled = false`.

## The socket

`ws` has `data`, `send` (`sendText`, `sendBinary`), `close`, `terminate`, `ping`, `pong`, `subscribe`, `unsubscribe`, `isSubscribed`, `subscriptions`, `publish` (`publishText`, `publishBinary`), `cork`, `remoteAddress`, `readyState` and `binaryType`. Handlers: `open`, `message`, `drain`, `close`, `ping`, `pong`.

`send` returns a number as in Bun: more than 0 is the bytes accepted; **-1** means accepted but the outbound queue is past `backpressure_bytes`; **0** means dropped (queue over the limit, or the socket is closed). When the queue empties after a -1 or 0, `drain` runs. With `closeOnBackpressureLimit: true` the socket closes with 1013 instead of dropping.

Events of one socket reach your handlers in order, at most 8 in flight: a slow `message` handler stops the server reading that socket, so TCP back-pressure reaches the client. Every handler runs in the store context captured at the upgrade.

## Topics

`ws.subscribe(topic)` joins a topic. `ws.publish(topic, data)` sends to every subscriber **on any worker**, except the publisher unless the route sets `publishToSelf: true`. Publishing is done from a socket handler; an HTTP action cannot publish into a topic in this release. A message is queued once and shared by every subscriber's queue. A socket leaves its topics when it closes.

## Limits

```toml
[actions.ws]            # every key optional; these are the defaults
enabled = true
max_payload_bytes = 1048576
idle_timeout_s = 120
ping_interval_s = 30
max_connections = 10000
backpressure_bytes = 1048576
```

| Key | Default | Range | |
|---|---|---|---|
| `enabled` | `true` | boolean | `false` answers every upgrade 501 |
| `max_payload_bytes` | 1048576 | 1 – 67108864 | largest message after reassembly; a bigger one closes with 1009 |
| `idle_timeout_s` | 120 | 0 – 86400 | no frame from the client for this long closes with 1001 "idle timeout"; 0 = off |
| `ping_interval_s` | 30 | 0 – 86400 | server pings this often; 0 = off |
| `max_connections` | 10000 | 1 – 1000000 | open sockets per server process; the next upgrade is 503 |
| `backpressure_bytes` | 1048576 | 1 – 67108864 | one socket's outbound queue, in bytes |

These are maxima. The Elysia options of your `.ws()` routes (`maxPayloadLength`, `idleTimeout` in seconds, `backpressureLimit`, `closeOnBackpressureLimit`, `publishToSelf`, `sendPings`) are sent with each upgrade and may lower a limit, never raise it. As in Bun there is one WebSocket configuration per app, so they are app-wide. `perMessageDeflate` is ignored. A value out of range is a build error naming the key.

## One socket, one worker

Your handlers are closures in the memory of the worker that ran the upgrade, so a socket stays on that worker for its whole life. An upgrade goes to the worker with the fewest open sockets among those that can take it. Module-level state is per worker: reach sockets of another worker through a topic, and share data through a database or cache. Socket events do not use the render slots pages and actions share.

Topics live inside one process. To fan out across instances, carry messages between them with a message bus (NATS, Redis pub/sub) and deliver what arrives to the sockets each instance holds.

## Close codes, drain and restart

| Code | When |
|---|---|
| 1000 | normal close |
| 1001 | server shutting down, or idle past `idle_timeout_s` |
| 1002 / 1007 | protocol error / text that is not UTF-8 |
| 1009 | message over `max_payload_bytes` |
| 1012 | `brust dev` restarted the app |
| 1013 | outbound queue over its limit with `closeOnBackpressureLimit: true` |

On `SIGTERM` or `SIGINT` the server stops accepting, sends every open socket close **1001 "going away"**, waits for the peer's close or the rest of `BRUST_DRAIN_TIMEOUT_MS` (10 s by default), then drops what is left and exits. Write the client to reconnect on 1001 and 1006, with a delay and jitter.

`brust dev` is a proxy in front of the app; it relays upgrades under the actions prefix (base path, cookies and the `Origin` check as above) and closes sockets with **1012 "service restart"** when the app restarts.

## Not supported

- **Cloudflare Workers.** `brust build --target cloudflare` warns `cf-websocket` for a source that calls `.ws(`, and the app fails to start with `WebSocket (.ws()) is not supported on --target cloudflare` (the build's startup check stops with it). `--target static` has no actions.
- Per-message deflate and subprotocols (`Sec-WebSocket-Protocol` is not answered; the dev proxy does not forward it).
- HTTP/2: browsers open WebSockets over HTTP/1.1; an upgrade on an HTTP/2 connection (RFC 8441) is 400.
- Sockets in page routes and loaders.
- Server-sent events and endless streamed responses: a response body is read in full before it is sent (`max_response_bytes`, 30 s deadline), so a stream that never ends is a 504.
- `.ws()` relies on parts of Elysia 2 release candidates that are not public API; a test fails when an update changes them.
