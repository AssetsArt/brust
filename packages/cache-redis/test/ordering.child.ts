// The second process of the ordering test (N1): invalidates `count` times with a window of 20 in flight.
import { make } from './servers'

const [, , flavor, url, namespace, count, origin] = process.argv
const a = await make(flavor as 'redis' | 'dragonfly', url!, {}, namespace!)
let sent = 0
const n = Number(count)
while (sent < n) {
  const batch = Math.min(20, n - sent)
  await Promise.all(Array.from({ length: batch }, (_, i) => a.broadcast!.publish({ tags: [`t${(sent + i) % 5}`] }, origin!)))
  sent += batch
}
await a.close?.()
process.exit(0)
