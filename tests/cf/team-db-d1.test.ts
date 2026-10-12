// M4-CF-5: the TeamDb contract (examples/pokedex/test/team-db.contract.ts) against REAL D1, local workerd, through a harness Worker.
// Opt-in: BRUST_CF_E2E=1 (runs `bunx wrangler`).
import { afterAll, beforeAll, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teamDbContract } from '../../examples/pokedex/test/team-db.contract'
import { migrateLocal, remoteTeamDb, resetRemote, startWrangler, type Wrangler } from './pokedex-d1/remote'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const CONFIG = join(import.meta.dir, 'pokedex-d1/wrangler.jsonc')
let w: Wrangler | undefined
let state = ''

describe.skipIf(!ENABLED)('pokedex TeamDb on local D1', () => {
  beforeAll(async () => {
    state = mkdtempSync(join(tmpdir(), 'pokedex-d1-state-'))
    migrateLocal(CONFIG, state)
    w = await startWrangler({ config: CONFIG, state })
  }, 300_000)
  afterAll(async () => {
    await w?.stop()
    rmSync(state, { recursive: true, force: true })
  })
  teamDbContract('d1', async () => {
    await resetRemote(w!.base)
    return remoteTeamDb(w!.base)
  })
})
