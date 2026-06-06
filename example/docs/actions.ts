// Treaty actions — the docs JSON API. Wired into brust.run({ actions }).
// Each endpoint ALSO auto-becomes an MCP tool at /_brust/mcp (agent-first), so the
// docs are queryable by agents, not just humans.
//
//   GET  /_brust/action/docs   → the nav tree as JSON (docs-as-data)
//   POST /_brust/action/echo   → echoes the posted message (live playground target; T4)

import { z } from 'zod'
import { defineActions } from 'brustjs'
import { NAV } from './lib/nav'
import { version } from './lib/version'

export const actions = defineActions()
  .get('/docs', () => ({ nav: NAV, version: version() }))
  .post('/echo', ({ body }) => ({ youSent: body.message, length: body.message.length, ok: true }), {
    body: z.object({ message: z.string() }),
  })
