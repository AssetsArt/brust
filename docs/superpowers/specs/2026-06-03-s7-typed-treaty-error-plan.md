# Plan: S7 — typed treaty error (`ActionError`)

Spec: `2026-06-03-s7-typed-treaty-error-design.md`. Branch `feat/s7-typed-treaty-error`.
Baseline (parent `660c5fe`): `cd runtime && bun test` → **350 pass / 0 fail / 48 files**.

TS-only — no Rust, no napi rebuild. Gates: `bun run ci` (biome, from repo ROOT) + `cd runtime && bun test`.

## Spec coverage map
| Spec section | Task |
|---|---|
| Primitive `action-error.ts` + unit tests | T1 |
| Exports from index.ts | T1 |
| Dispatch mapping (both catches) + dispatch tests | T2 |
| Dogfood actions.ts + AddToTeamButton.tsx + build | T3 |

---

## T1 — `ActionError` primitive + exports (TDD)

**Files:** `runtime/action-error.ts` (new), `runtime/action-error.test.ts` (new), `runtime/index.ts` (edit).

### Step 1a — RED: write `runtime/action-error.test.ts`
```ts
import { test, expect } from 'bun:test'
import { ActionError, isActionError } from './action-error.ts'

test('ActionError: status/code/default message', () => {
  const e = new ActionError(409, 'TEAM_FULL')
  expect(e.status).toBe(409)
  expect(e.code).toBe('TEAM_FULL')
  expect(e.message).toBe('TEAM_FULL') // default = code
  expect(e.data).toBeUndefined()
  expect(e instanceof Error).toBe(true)
  expect(e.name).toBe('ActionError')
})

test('ActionError: explicit message + data', () => {
  const e = new ActionError(400, 'BAD', { message: 'nope', data: { a: 1 } })
  expect(e.message).toBe('nope')
  expect(e.data).toEqual({ a: 1 })
})

test('isActionError: true for instances', () => {
  expect(isActionError(new ActionError(400, 'X'))).toBe(true)
})

test('isActionError: false for non-branded', () => {
  expect(isActionError({ status: 409, code: 'X' })).toBe(false)
  expect(isActionError(new Error('x'))).toBe(false)
  expect(isActionError(null)).toBe(false)
  expect(isActionError('s')).toBe(false)
  expect(isActionError(undefined)).toBe(false)
})

test('isActionError: true for hand-branded object (Symbol.for contract)', () => {
  expect(isActionError({ [Symbol.for('brust.actionError')]: true })).toBe(true)
})
```
Run: `cd runtime && bun test action-error.test.ts` → MUST fail (module missing).

### Step 1b — GREEN: write `runtime/action-error.ts`
```ts
// Typed domain error for treaty actions. `throw new ActionError(status, code, { data })`
// from a handler (or nested business logic) → dispatchAction maps it to an HTTP
// non-2xx with a flat body `{ code, message, data }`. Branded with Symbol.for so the
// guard survives the class being duplicated across bundles (user code → framework).
const ACTION_ERROR: unique symbol = Symbol.for('brust.actionError')

export interface ActionErrorBody {
  code: string
  message: string
  data?: unknown
}

export class ActionError extends Error {
  readonly [ACTION_ERROR] = true as const
  readonly status: number
  readonly code: string
  readonly data?: unknown
  constructor(status: number, code: string, opts?: { message?: string; data?: unknown }) {
    super(opts?.message ?? code)
    this.name = 'ActionError'
    this.status = status
    this.code = code
    this.data = opts?.data
  }
}

export function isActionError(v: unknown): v is ActionError {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<symbol, unknown>)[ACTION_ERROR] === true
  )
}
```
Run: `cd runtime && bun test action-error.test.ts` → 5 pass.

### Step 1c — exports in `runtime/index.ts`
After line 755 (the `defineActions` export block), add:
```ts
export { ActionError, isActionError } from './action-error.ts'
export type { ActionErrorBody } from './action-error.ts'
```
Verify: `cd runtime && bun -e "import('./index.ts').then(m => console.log(typeof m.ActionError, typeof m.isActionError))"` → `function function`.

Commit: `feat(actions): ActionError typed domain-error primitive + exports`.

---

## T2 — dispatch mapping (both catches) (TDD)

**Files:** `runtime/routes.ts` (edit `dispatchAction`), `runtime/action-dispatch.test.ts` (append cases).

### Step 2a — RED: append to `runtime/action-dispatch.test.ts`
Add import at top: `import { ActionError } from './action-error.ts'`. Append:
```ts
test('handler throws ActionError → typed status + flat body', async () => {
  const a = defineActions().post('/t', () => {
    throw new ActionError(409, 'TEAM_FULL', { data: { max: 6 } })
  })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body)).toEqual({ code: 'TEAM_FULL', message: 'TEAM_FULL', data: { max: 6 } })
})

test('ActionError without data omits data key', async () => {
  const a = defineActions().post('/t', () => {
    throw new ActionError(400, 'BAD', { message: 'nope' })
  })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(400)
  expect(JSON.parse(res.body)).toEqual({ code: 'BAD', message: 'nope' })
})

test('non-ActionError throw → still 500 enveloped (regression)', async () => {
  const a = defineActions().post('/t', () => { throw new Error('boom') })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(500)
  expect(JSON.parse(res.body)).toEqual({ error: { message: 'boom', name: 'Error' } })
})

test('middleware throws ActionError → same typed body as terminal (outer catch)', async () => {
  const mw = async () => { throw new ActionError(403, 'FORBIDDEN', { data: { reason: 'x' } }) }
  const a = defineActions().post('/t', () => ({ ok: true }), { middleware: [mw] })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({ code: 'FORBIDDEN', message: 'FORBIDDEN', data: { reason: 'x' } })
})

test('respond() then throw ActionError → throw wins', async () => {
  const a = defineActions().post('/t', ({ respond }) => {
    respond({ ok: true }, { status: 201 }) // sentinel created but thrown-over
    throw new ActionError(409, 'TEAM_FULL')
  })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {},
      body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body)).toEqual({ code: 'TEAM_FULL', message: 'TEAM_FULL' })
})
```
**Middleware signature check:** before writing the mw test, confirm the `Middleware` type & how `composeChain` invokes it (read `runtime/routes.ts` `composeChain` + the `Middleware` type in `runtime/routes.ts`). Adjust `mw` signature to match (it receives `(req, next)` or similar). If a middleware that throws before `next()` is the right repro, keep as-is; else adapt.
Run: `cd runtime && bun test action-dispatch.test.ts` → new tests fail.

### Step 2b — GREEN: edit `runtime/routes.ts`
1. Add import near top (with other define-actions imports ~line 21-22):
   `import { isActionError, type ActionError } from './action-error.ts'`
2. Add a module-level helper (near `dispatchAction`, before it):
```ts
function actionErrorResponse(err: ActionError): RouteResponse {
  return {
    status: err.status,
    body: JSON.stringify({ code: err.code, message: err.message, data: err.data }),
    contentType: 'application/json; charset=utf-8',
  }
}
```
3. **terminal catch** (~1376): replace the catch body's first lines:
```ts
} catch (err) {
  if (isActionError(err)) return actionErrorResponse(err)
  const e = err instanceof Error ? err : new Error(String(err))
  console.error(`[brust] action ${def.method} ${def.path} threw:`, err)
  return { status: 500, body: JSON.stringify({ error: { message: e.message, name: e.name } }),
    contentType: 'application/json; charset=utf-8' }
}
```
4. **outer chain() catch** (~1391):
```ts
try {
  response = await chain()
} catch (err) {
  if (isActionError(err)) {
    response = actionErrorResponse(err)
  } else {
    console.error('[brust] action middleware uncaught:', err)
    response = { status: 500, body: '{"error":{"message":"internal error"}}',
      contentType: 'application/json; charset=utf-8' }
  }
}
```
Run: `cd runtime && bun test action-dispatch.test.ts` → all pass.

Commit: `feat(actions): map thrown ActionError to typed HTTP response (handler + middleware)`.

---

## T3 — dogfood pokedex (no new tests; build + biome are the gate)

**Files:** `example/pokedex/actions.ts`, `example/pokedex/components/AddToTeamButton.tsx`.

### Step 3a — `example/pokedex/actions.ts`
- Import: `import { defineActions, ActionError } from 'brustjs'`.
- POST `/team` handler — replace body (drop GAP S7 comment + `full`):
```ts
.post(
  '/team',
  ({ body }) => {
    if (!teamStore.add(body)) {
      throw new ActionError(409, 'TEAM_FULL', { data: { max: MAX_TEAM } })
    }
    return { team: teamStore.list(), max: MAX_TEAM }
  },
  { body: TeamMemberInput },
)
```

### Step 3b — `example/pokedex/components/AddToTeamButton.tsx`
- Import `ActionErrorBody`: `import { ActionError... }` → add `import type { ActionErrorBody } from 'brustjs'` (or combine).
- Add a `full` signal near other signals: `const full = signal(false)` (use existing signal import; check top of file).
- `toggle()` POST branch — replace lines ~47-57:
```ts
const { data, error } = await api.team.post({
  id: props.id, name: props.name, displayName: props.displayName,
  num: props.num, types: props.types, artwork: props.artwork,
})
if (data) {
  full.set(false)
  teamStore.members.set(data.team)
} else if ((error?.value as ActionErrorBody)?.code === 'TEAM_FULL') {
  full.set(true) // team full — surface to UI instead of silent no-op
}
```
- Wire `full` into the returned behavior + reflect in `label` or a small aria/text. Read the
  full file first; keep feedback minimal (signal + label/aria). Do NOT build a toast system.
- **same-commit:** ensure no remaining `data.full` reference (was line 55) — it no longer typechecks.

### Step 3c — verify
- `bun run ci` (from repo ROOT) → biome clean.
- Build pokedex: `cd /Users/detoro/code/brust && bun run runtime/cli/index.ts build example/pokedex/index.ts` → success, no native-route compile error.
- (If signal/label wiring needs the file shape, read `AddToTeamButton.tsx` fully before editing.)

Commit: `feat(pokedex): dogfood S7 — throw ActionError(TEAM_FULL) instead of full flag`.

---

## BLOCKED fallbacks
- **T2 middleware test signature mismatch:** if `Middleware` type doesn't match `() => { throw }`,
  read `composeChain` + `Middleware` def and adapt the test to the real signature. The invariant
  to prove is "ActionError thrown in a middleware (pre-next) → typed body via outer catch" — keep
  that assertion, fix only the mw shape.
- **T3 `signal` not imported in AddToTeamButton:** check the existing imports (`brustjs/native`?);
  if `signal` is from a different entry, match the file's existing reactive primitive. If wiring
  `full` into the view is non-trivial in native directive land, fall back to minimal: keep the
  `full.set(true)` state change and a `label` computed that reads it — no new directive.
- **T3 build fails on native compile:** S7 doesn't touch the compiler; a build failure = pre-existing
  or unrelated. Re-run baseline build on parent SHA to confirm before chasing.

## Final verification (Phase 6, orchestrator re-runs)
1. `cd runtime && bun test` → 350 + 10 new = 360 pass, 0 fail (re-run, don't trust subagent count).
2. `bun run ci` → clean.
3. Build pokedex → success.
4. Manual: dispatch test proves 409 + flat body (smoke covered by T2 tests).
