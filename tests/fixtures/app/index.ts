// Test fixture app — self-contained demo + variant superset used by
// tests/integration.test.ts and tests/cli-build.test.ts. Mounts the showcase
// routes PLUS all the failure-mode + middleware + action + variant routes that
// the suites depend on. Authors writing real apps should read example/pokedex/
// instead — this file is intentionally cluttered.
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'
import { actions } from './actions'

await brust.run({
  routes,
  entry: import.meta.url,
  actions,
  actionPrefix: process.env.BRUST_ACTION_PREFIX || undefined,
  // Opt-in CORS boot for tests/cors.integration.test.ts (own process — the
  // shared suites boot without the env and stay byte-identical, no-CORS).
  cors: process.env.BRUST_TEST_CORS
    ? { origins: ['http://allowed.test'], credentials: true, exposeHeaders: ['x-render-ms'] }
    : undefined,
})
