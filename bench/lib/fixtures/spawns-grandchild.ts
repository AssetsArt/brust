// Leader that spawns a grandchild sleeper, reports both pids, then prints a ready line. stop() must end both.
const grandchild = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })
console.log(`[fake] grandchild ${grandchild.pid}`)
console.log('[fake] listening on http://127.0.0.1:1')
await new Promise(() => {})
export {}
