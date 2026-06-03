// Isolated TYPE TEST for the B2 typed treaty client. Not executed — every
// assertion is a pure type check inside an un-called async function. Run via:
//   bun run typecheck:treaty   →   tsc -p tsconfig.typecheck.json --noEmit
//
// It exercises: (1) static-path methods are fully typed (output + error union),
// (2) the discriminated error union narrows on `code`, (3) accessing a
// non-existent output field is a type error, (4) a wrong error code / field is a
// type error, (5) param paths stay permissive (no type error, the fallback).
import { z } from 'zod'
import { defineActions } from './define-actions.ts'
import { client } from './treaty.ts'

const actions = defineActions()
  .get('/team', () => ({ team: [{ id: 1 }], max: 6 }))
  .post('/team', ({ body }: { body: { id: number } }) => ({ team: [{ id: body.id }], max: 6 }), {
    body: z.object({ id: z.number() }),
    errors: {
      TEAM_FULL: z.object({ max: z.number() }),
      DUPLICATE: z.object({ existingId: z.number() }),
    },
  })
  .delete('/team/{id}', () => ({ ok: true }))

const api = client<typeof actions>()

// Never called — purely for type checking.
export async function _typeTest() {
  // (1) static POST → output typed.
  const r = await api.team.post({ id: 5 })
  if (r.data) {
    const max: number = r.data.max
    void max
    // (3) non-existent output field → must be a type error.
    // @ts-expect-error `nope` is not a field of the typed output
    void r.data.nope
  }

  // (2) error union narrows on the discriminant `code` to the SPECIFIC branch,
  // and that branch's `data` is typed (multi-member union: TEAM_FULL | DUPLICATE).
  if (r.error && r.error.value.code === 'TEAM_FULL') {
    const m: number = r.error.value.data.max
    void m
    // (4a) non-existent error-data field → must be a type error.
    // @ts-expect-error `min` is not a field of the TEAM_FULL error data
    void r.error.value.data.min
    // (4c) narrowing is per-branch: DUPLICATE's `existingId` is NOT on TEAM_FULL.
    // @ts-expect-error `existingId` belongs to the DUPLICATE branch, not TEAM_FULL
    void r.error.value.data.existingId
  }
  if (r.error && r.error.value.code === 'DUPLICATE') {
    const e: number = r.error.value.data.existingId
    void e
  }
  // (4b) comparing against an undeclared error code → must be a type error.
  if (r.error) {
    // @ts-expect-error 'NOPE' is not a declared error code
    void (r.error.value.code === 'NOPE')
  }

  // GET → output typed.
  const g = await api.team.get()
  if (g.data) {
    const max2: number = g.data.max
    void max2
  }

  // (5) param path stays permissive — MUST NOT error (locks the fallback).
  await api.team({ id: '5' }).delete()
}
