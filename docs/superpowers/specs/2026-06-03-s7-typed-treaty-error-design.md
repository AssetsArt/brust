# S7 — typed domain-error ผ่าน treaty (`ActionError`)

> Status: design · 2026-06-03 · branch `feat/s7-typed-treaty-error`
> Gap: `example/pokedex/FRAMEWORK-GAPS.md` S7 (◆ CONFIRMED)

## Goal

ให้ action handler **throw** domain error ที่ส่งข้าม treaty boundary เป็น HTTP non-2xx
พร้อม body ที่มี `code` ใช้ระบุชนิด error ได้ — แทนการ encode domain error ลงใน success
payload (วันนี้ "ทีมเต็ม" เดินทางกลับเป็น `{ full: true }` ใน 200 แล้ว client เช็คสองที่:
transport `error` **และ** `data.full`).

หลังแก้:
```ts
// handler
if (!teamStore.add(body)) throw new ActionError(409, 'TEAM_FULL', { data: { max: MAX_TEAM } })
return { team: teamStore.list(), max: MAX_TEAM }

// client
const r = await api.team.post({ … })
if (r.data) teamStore.members.set(r.data.team)
else if ((r.error?.value as ActionErrorBody)?.code === 'TEAM_FULL') showFull()
```

## Non-goals (ดังๆ — out of scope)

- **per-endpoint typed error union ฝั่ง client.** ปัจจุบัน treaty proxy คืน
  `TreatyResponse<any, any>` — `data`/`error.value` เป็น `any` อยู่แล้ว (proxy ไม่ได้ใช้
  `EndpointEntry` ที่ accumulate ไว้เลย). การทำ proxy ให้ typed เต็มตาม path+method
  เป็น feature แยก กินขอบเขตกว่า S7 มาก. รอบนี้ให้ exported type `ActionErrorBody`
  ไว้ cast/assert เองฝั่ง client.
- **`opts.errors` declaration บน endpoint** (ประกาศ error codes ล่วงหน้าเพื่อ accumulate
  เข้า endpoint type) — เป็นครึ่งทางสู่ typed union, gate ด้วย proxy typing ข้างบน → defer.
- ไม่แตะ Rust. dispatch อยู่ใน `runtime/routes.ts` (TS); Rust แค่ forward action envelope
  แล้วเขียน `{status, body, headers}` ที่ `dispatchAction` คืน. 409 ไหลผ่านได้เลย.
- ไม่แตะ framework error envelope เดิม (422 validation, 404 unknown-action, 500 uncaught) —
  รูป `{ error: { … } }` คงเดิม.

## High-level architecture

3 ชั้น + dogfood:

1. **Primitive** — `runtime/action-error.ts` (ไฟล์ใหม่, single purpose): class `ActionError`
   + guard `isActionError` + type `ActionErrorBody`.
2. **Dispatch mapping** — `runtime/routes.ts` `dispatchAction` terminal `catch`: ถ้า
   `isActionError(err)` → คืน `{ status: err.status, body: flat-json, … }`; ไม่ใช่ → 500 เดิม.
3. **Exports** — `runtime/index.ts` re-export `ActionError`, `isActionError`, type `ActionErrorBody`.
4. **Dogfood** — `example/pokedex/actions.ts` + `components/AddToTeamButton.tsx`.

## API surface

### `runtime/action-error.ts` (ใหม่)

```ts
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

ออกแบบประเด็น:
- **brand ด้วย `Symbol.for('brust.actionError')` ไม่ใช่ `instanceof`** — กัน class identity
  แตกข้าม bundle/chunk (บทเรียน `napi-crossing-floor`/native-verdict ใช้ `Symbol.for`
  cross-chunk). handler (user code, import จาก `brustjs`) throw → `dispatchAction` (`brustjs`)
  check; การ brand ทำให้ทำงานแม้ class ถูก duplicate.
- **`message` default = `code`** ถ้าไม่ส่ง — error อ่านง่ายใน log โดยไม่บังคับเขียนซ้ำ.
- `status`/`code`/`data` เป็น `readonly`.

### `runtime/routes.ts` — `dispatchAction` terminal catch (แก้จุดเดียว ~line 1376)

เดิม:
```ts
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err))
  console.error(`[brust] action ${def.method} ${def.path} threw:`, err)
  return { status: 500, body: JSON.stringify({ error: { message: e.message, name: e.name } }),
    contentType: 'application/json; charset=utf-8' }
}
```

ใหม่ (เพิ่ม branch ActionError ก่อน fallback 500):
```ts
} catch (err) {
  if (isActionError(err)) {
    return {
      status: err.status,
      body: JSON.stringify({ code: err.code, message: err.message, data: err.data }),
      contentType: 'application/json; charset=utf-8',
    }
  }
  const e = err instanceof Error ? err : new Error(String(err))
  console.error(`[brust] action ${def.method} ${def.path} threw:`, err)
  return { status: 500, body: JSON.stringify({ error: { message: e.message, name: e.name } }),
    contentType: 'application/json; charset=utf-8' }
}
```

หมายเหตุ serialize: `JSON.stringify({ …, data: undefined })` จะ **ละ** key `data` เมื่อ
`data` เป็น `undefined` (พฤติกรรม JSON.stringify ปกติ) — body จึงเป็น `{code,message}` เมื่อไม่ส่ง data.

### `runtime/index.ts`

เพิ่มข้างๆ `defineActions`:
```ts
export { ActionError, isActionError } from './action-error.ts'
export type { ActionErrorBody } from './action-error.ts'
```

## Wire format

domain error (ActionError) → **flat body**:
```json
{ "code": "TEAM_FULL", "message": "TEAM_FULL", "data": { "max": 6 } }
```
treaty client (`treaty.ts`) เห็น `res.ok === false` → คืน
`{ data: null, error: { status: 409, value: { code, message, data } }, status: 409, … }`.
client อ่าน `r.error.value.code`.

`code` เป็น **discriminator** แยก domain error (flat, มี `code`) ออกจาก framework error
(enveloped `{ error: { message, … } }`, ไม่มี top-level `code`). ผู้ใช้แยกได้: ถ้า
`r.error.value.code` มี → domain ActionError; ไม่งั้น framework error (422/500).

## Dogfood — `example/pokedex/`

### `actions.ts` POST `/team`
- ลบ comment GAP S7 + `full` flag.
- `const ok = teamStore.add(body); if (!ok) throw new ActionError(409, 'TEAM_FULL', { data: { max: MAX_TEAM } })`
- คืน `{ team: teamStore.list(), max: MAX_TEAM }` (success ไม่มี `full`).
- import `ActionError` จาก `brustjs`.

### `components/AddToTeamButton.tsx` `toggle()`
- เดิม `if (data && !data?.full) { teamStore.members.set(data.team) }` — ตัด `full`.
- ใหม่: destructure ทั้ง `{ data, error }`; `if (data) teamStore.members.set(data.team)`
  `else if ((error?.value as ActionErrorBody)?.code === 'TEAM_FULL') { /* feedback */ }`.
- เพิ่ม feedback ขั้นต่ำ (เช่น set signal `full` แล้ว label/aria สะท้อน) — ดีกว่าเดิมที่
  เต็มแล้วเงียบสนิท. ขอบเขต feedback ให้ minimal (signal + button label), ไม่ทำ toast system.

## Tests

### `runtime/action-error.test.ts` (ใหม่ — unit)
- `new ActionError(409, 'TEAM_FULL')` → `.status===409`, `.code==='TEAM_FULL'`, `.message==='TEAM_FULL'` (default), `instanceof Error`.
- `new ActionError(400, 'X', { message: 'msg', data: { a: 1 } })` → `.message==='msg'`, `.data` deep-eq `{a:1}`.
- `isActionError(new ActionError(…))===true`.
- `isActionError({ status: 409, code: 'X' })===false` (plain object ไม่มี brand).
- `isActionError(new Error('x'))===false`, `isActionError(null)===false`, `isActionError('s')===false`.
- brand cross-realm sanity: object ที่ตั้ง `{ [Symbol.for('brust.actionError')]: true }` เอง → `isActionError`===true (ยอมรับ — brand คือ contract; ตรงกับ design intent ของ Symbol.for).

### `runtime/action-dispatch.test.ts` (เพิ่ม cases ในไฟล์เดิม)
- handler throw `ActionError(409,'TEAM_FULL',{data:{max:6}})` → `res.status===409`,
  `JSON.parse(res.body)` deep-eq `{ code:'TEAM_FULL', message:'TEAM_FULL', data:{max:6} }`.
- handler throw `ActionError(400,'BAD',{message:'nope'})` ไม่มี data → body `{code:'BAD',message:'nope'}` (ไม่มี key `data`).
- handler throw `new Error('boom')` ปกติ → ยัง `res.status===500`, body `{error:{message:'boom',name:'Error'}}` (regression: non-ActionError ไม่เปลี่ยน).
- ActionError ที่ throw จาก **middleware** (ผ่าน `composeChain`) → ก็ map เป็น typed body
  เช่นกัน (ยืนยัน catch ครอบ chain — ดู Open questions).

## Behavior invariants

- ActionError throw จากที่ไหนก็ได้ใน handler call-stack (รวม nested business logic) →
  ถูก catch ที่ `terminal` ใน `dispatchAction`.
- non-ActionError throw → 500 ไม่ leak (เปิด `{message,name}` เท่าเดิม — ไม่ถดถอย privacy).
- ไม่มี side-effect บน success path (return ปกติ ยัง 200).

## Acceptance criteria

1. `bun test runtime/action-error.test.ts` + `bun test runtime/action-dispatch.test.ts` เขียว.
2. `bun run ci` (biome) เขียว ทั้ง repo.
3. full `bun test` ใน `runtime/` ไม่ regress (เทียบ baseline ก่อนแก้).
4. pokedex `actions.ts` POST `/team` throw ActionError; `AddToTeamButton` อ่าน `error.value.code`;
   build pokedex ผ่าน (`bun run runtime/cli/index.ts build example/pokedex/index.ts`).
5. smoke: เติมทีมเกิน MAX_TEAM ผ่าน action → HTTP 409 + body `{code:'TEAM_FULL',…}` (curl หรือ dispatch test).
6. exports: `import { ActionError, isActionError, type ActionErrorBody } from 'brustjs'` resolve.

## Known limitations (documented)

- client `r.error.value` ยัง typed `any` — ต้อง `as ActionErrorBody` เอง (per-endpoint union = follow-up).
- ไม่มี registry/validation ของ `code` (free-form string) — typo ใน code ไม่ถูกจับตอน compile.

## Open questions → resolved at design time

- **Q: middleware ที่ throw ActionError จะถูก map ไหม?** `terminal` catch อยู่ชั้นใน;
  `chain()` มี outer try/catch ที่ map ทุก throw เป็น 500 generic. ถ้า middleware (ไม่ใช่ terminal)
  throw ActionError มันจะตกที่ outer catch → 500 (ไม่ map). **Resolution:** ย้าย/เพิ่ม
  `isActionError` check ที่ **outer** catch (`chain()` try/catch ~line 1391) ด้วย เพื่อให้
  ActionError จาก middleware ก็ map เป็น typed. plan task จะครอบทั้งสองจุด.
- **Q: brand `Symbol.for` vs local `Symbol`?** ใช้ `Symbol.for` (global registry) — robust ข้าม
  bundle/dual-module; ตรงบทเรียน cross-chunk ใน repo. (local `Symbol` แตกถ้า action-error.ts
  ถูก bundle สองชุด.)
