# B2 — typed treaty client (output + error union per endpoint, static paths)

> Status: design · 2026-06-03 · branch `feat/s7-typed-treaty-client`
> Gap: S7 follow-up (FRAMEWORK-GAPS S7 "out of scope → follow-up"): treaty proxy คืน
> `TreatyResponse<any,any>` — data + error untyped.

## Goal (descoped — see Non-goals)

ให้ treaty client typed **ต่อ endpoint** สำหรับ **static path** (ไม่มี `{param}`):
`api.team.post(body)` → `TreatyResponse<Output, ErrorUnion>` — data typed, **error union typed**
(discriminate `r.error.value.code === 'TEAM_FULL'` ได้). + `opts.errors` declaration ต่อ endpoint
เพื่อให้ error type รู้จัก.

## Non-goals (ดังๆ — descoped, มีหลักฐาน)

- **param-path tracking** (`api.team({id}).delete()`) — full Eden-Treaty-scale path-tracking proxy
  (callable × index-sig × methods intersection) **ไม่ converge หลัง 3 spike** (callable param node
  ชนกับ index sig). param-containing endpoint → **fall ไป permissive `any`** (runtime ยังทำงาน
  เหมือนเดิม — proxy runtime permissive อยู่แล้ว; แค่ types ไม่ครอบ). documented.
- **ไม่แตะ runtime proxy logic** — B2 เป็น **type-only** + `opts.errors` (type metadata). proxy
  runtime (`treaty.ts` `client()`) ทำงานครบทุก path อยู่แล้ว ไม่เปลี่ยน.
- **runtime validation ของ errors** — `opts.errors` เป็น type metadata เท่านั้นรอบนี้ (ActionError
  throw ผลิต body เองอยู่แล้ว — S7). อาจเพิ่ม runtime validate ทีหลัง.

## Verification constraint (สำคัญ)

repo **ไม่มี working tsc gate** (full-project tsc stack-overflows — React graph; CI = biome ไม่
typecheck). B2 เป็น type-only → validate ผ่าน **isolated type-test**: `bunx tsc --noEmit --strict
--skipLibCheck` บนไฟล์ type-test ที่ import **เฉพาะ** `treaty.ts`/`define-actions.ts` subgraph
(react-free → ไม่ overflow). ยืนยันแล้วว่า standalone spike tsc ผ่าน (EXIT=0). type-test เป็น
deliverable + รันได้ผ่าน script.

## Design

### 1. `opts.errors` + `EndpointEntry.error` (`runtime/define-actions.ts`)
- `EndpointOptions` เพิ่ม `errors?: Record<string, StandardSchemaV1>` (code → schema ของ `data`).
- `EndpointEntry` เพิ่ม `error: unknown` field.
- builder method generic ดึง error type จาก `O['errors']`:
  `ErrorOf<O> = O extends { errors: infer E } ? { [K in keyof E & string]: { code: K; message: string; data: E[K] extends StandardSchemaV1 ? InferOutput<E[K]> : unknown } }[keyof E & string] : never`
  accumulate `{ [K in P]: { POST: { input; output; error: ErrorOf<O> } } }`.
- runtime: เก็บ `errors` บน `EndpointDef` (optional, ไม่ใช้ตอนนี้) หรือ drop — type flows ผ่าน generic ไม่ใช่ runtime value.

### 2. typed `Treaty<App>` static-path node (`runtime/treaty.ts`)
แทน `Treaty<App> = {…PermissiveProxy} & PermissiveProxy` ด้วย proven static-only node:
- `Seg`, `Methods<E>` (GET/HEAD → `(opts?)=>...`, อื่น → `(body?, opts?)=>...`, คืน
  `TreatyResponse<output, error>`), `StaticAcc` (keys ไม่มี `{param}`), `ChildSegs<P>`,
  `ExactEntry<P>`, `TNode<P>` = `Methods<ExactEntry<P>> & { [Seg in ChildSegs<P>]: TNode<…> }`.
- **param paths + unknown segments fall to permissive** — `TNode<P> = Methods<ExactEntry<P>> &
  { [Seg in ChildSegs<P>]: TNode<…> } & PermissiveProxy`. **✅ spike5 ยืนยัน (EXIT=0):** static
  method `api.team.post(b)` → typed output + error union; `api.team({id}).delete()` (param call) →
  permissive (any) ไม่ error. อยู่ร่วมกันได้.
- **caveat (proven tradeoff):** intersect กับ `PermissiveProxy` ทำให้ **input (body) typing หลวม**
  (overload `(b?: any)` รับ body ผิดได้โดยไม่ error) — **แต่ output + error union ยัง typed** (อ่าน
  `r.data.*` / discriminate `r.error.value.code` typed). value หลักของ B2 = อ่าน response แบบ typed
  (typed domain error) → ยอม input หลวม. type-test negatives (`@ts-expect-error`) จึงเล็งที่
  **output/error access** (เช่น field ไม่มีบน `r.data`, code ผิด) ไม่ใช่ input.
- `App extends ActionsBuilder<infer Acc>` → `TNode<''>` over Acc; else PermissiveProxy.

### 3. Type-test (`runtime/treaty.type-test.ts` + isolated tsconfig)
- import จริง `client` + `defineActions` + `ActionError`. สร้าง actions ตัวอย่าง (get/post + `errors`),
  `const api = client<typeof actions>()`, assert: `api.x.post(body)` data typed, `r.error.value.code`
  discriminable, wrong body → `@ts-expect-error`.
- `runtime/tsconfig.typecheck.json` (extends runtime/tsconfig, `files: [treaty.ts, define-actions.ts,
  standard-schema.ts, treaty.type-test.ts]`, no react) → `bunx tsc -p` runs clean & fast.
- script `package.json` `"typecheck:treaty": "tsc -p runtime/tsconfig.typecheck.json --noEmit"` +
  add to CI? (CI gate decision — at least runnable + documented; wire into ci.yml as a fast isolated step if it doesn't overflow).

### 4. Dogfood
- `example/pokedex/actions.ts` POST `/team`: add `errors: { TEAM_FULL: z.object({ max: z.number() }) }`.
- `AddToTeamButton.tsx`: `(error?.value as ActionErrorBody)` cast เลิกจำเป็นสำหรับ static path —
  `error.value.code` typed (ถ้า `api.team` เป็น static → typed). ยืนยัน type ผ่าน type-test.

## Tests / acceptance
1. `bunx tsc -p runtime/tsconfig.typecheck.json --noEmit` → EXIT 0 (type-test compiles incl `@ts-expect-error` negatives).
2. `cd runtime && bun test` ไม่ regress (runtime proxy unchanged — type-only).
3. `bun run ci` (biome) clean.
4. dogfood: pokedex build ผ่าน; AddToTeamButton อ่าน typed `error.value.code` (static path).
5. param path (`api.team({id}).delete()`) ยัง runtime-work (permissive) — assert ใน type-test ว่าไม่ error (any).

## Open questions → Task 0 spike
- **static typed node + permissive fallback ร่วมกัน** — spike4 พิสูจน์ static typed; ต้อง spike เพิ่ม
  ว่า `api.team({id})` (param call) ไม่ทำให้ทั้ง node พังเป็น any / หรือ error. ถ้าผสมไม่ได้ →
  param path typed as `any` ผ่าน a union/fallback; ยืนยันก่อน implement.
- CI wiring ของ isolated tsc — ถ้า isolated subgraph ยัง overflow → type-test เป็น local/manual gate (documented), ไม่เข้า CI.
