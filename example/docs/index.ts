import { brust } from 'brustjs'
import { routes } from './routes'

// Boot: register Home + the markdown doc pages, compile native templates,
// build island chunks, and serve. Port comes from brust.toml ([server]
// port = 1340) — discovered cwd-relative, so every command runs with
// cwd = example/docs (see the cwd contract in the design spec).
await brust.run({
  routes,
  entry: import.meta.url,
})
