// F153c (package source) started-server and Chromium checks: tests/server/package-source.chromium.test.ts.
import { defineRoutes } from '@brust/core/routes'
import Page from './page'

export const routes = defineRoutes([{ path: '/', Component: Page }])
