// Test fixture app — superset of example/hello-world used by
// tests/integration.test.ts. Mounts demo's six showcase routes PLUS all the
// failure-mode + middleware + action + variant routes that the integration
// suite depends on. Authors writing real apps should read
// example/hello-world/ instead — this file is intentionally cluttered.
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

await brust.run({
  routes,
  entry: import.meta.url,
})
