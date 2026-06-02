// Fixture store for the isomorphic-store integration test (T8). Defines a single
// `value` signal seeded per-request by the /store-demo loader. Imported from the
// runtime barrel (`runtime/store/index.ts`) the same way an app would import
// `brustjs/store` — the fixture is self-contained and uses relative paths.
import { defineStore, signal } from '../../../../runtime/store/index.ts'

export const counter = defineStore('counter', () => ({
  value: signal(0),
}))
