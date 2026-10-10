// A stand-in server for app.test.ts: binds any port, prints the 0.1.x-style listening line, serves one page.
const s = Bun.serve({
  port: Number.parseInt(process.env.FAKE_PORT ?? '0', 10),
  fetch: () => new Response('<html><body><main><h1>fake</h1></main></body></html>', { headers: { 'content-type': 'text/html' } }),
})
console.log(`[fake] listening on http://127.0.0.1:${s.port}`)
process.on('SIGINT', () => { s.stop(true); process.exit(0) })
