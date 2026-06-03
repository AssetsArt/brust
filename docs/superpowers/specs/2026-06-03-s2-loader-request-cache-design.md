# S2 — loader request-scoped cache / dedupe

> Status: design · 2026-06-03 · branch `feat/s2-loader-request-cache`
> Gap: `example/pokedex/FRAMEWORK-GAPS.md` S2 (○ CONFIRMED)

## Goal

ให้ loader มี **request-scoped dedupe + cache** primitive — fetch URL เดียวกันซ้ำใน request
เดียว (เช่น parent+child chain, หรือหลาย helper เรียก endpoint เดียวกัน) share in-flight
promise + cache ผลลัพธ์ ตลอด request นั้น. แทนการที่ทุก loader fetch ดิบเองไม่มี dedupe.

วันนี้: `typeChartLoader` ทำ `Promise.all(ALL_TYPES.map(fetchTypeRelations))` มือ; ไม่มี dedupe —
ถ้า 2 loader (หรือ chain parent+leaf) fetch `/type/fire` พร้อมกัน = 2 hits.

หลังแก้:
```ts
import { cachedFetch } from 'brustjs'
const rel = await cachedFetch(`${API}/type/${t}`).then(r => r.json())   // dedupe + cache per request
// or dedupe an arbitrary async unit:
const data = await dedupe(`type:${t}`, () => fetchTypeRelations(t))
```

## Approach

**request-scoped memoization via a dedicated `AsyncLocalStorage<Map>`** (mirrors the store's
`server-context.ts` pattern — `runtime/store/server-context.ts:10`). NOT global fetch
monkey-patching (too magic), NOT a DataLoader batch-fn (overkill).

- New module `runtime/loader-cache.ts`: `AsyncLocalStorage<Map<string, Promise<unknown>>>`
  + `runInRequestCache(fn)` + `dedupe(key, fn)` + `cachedFetch(url, init?)`.
- `dedupe(key, fn)`: ถ้า key อยู่ใน map → คืน promise เดิม (share in-flight + cached result);
  ไม่งั้นเรียก `fn()`, เก็บ promise ลง map, คืน. **เก็บ promise (ไม่ใช่ resolved value)** →
  concurrent callers ก่อน resolve ก็ share. **ถ้า fn reject → ลบ key** (ไม่ cache error เพื่อให้
  retry ใน request เดียวกันได้; แต่ within one request rejection มักจบ — ลบกัน poisoned cache).
- `cachedFetch(url, init?)`: sugar = `dedupe('GET '+url, () => fetch(url, init))` — **เฉพาะ
  idempotent GET/HEAD** (มี init.method อื่น → bypass dedupe, fetch ตรง — กัน cache POST). คืน
  `Response` ที่ **clone** ได้ (เก็บ resolved Response แล้ว `.clone()` ต่อ caller เพราะ body
  อ่านได้ครั้งเดียว) — ดู Open questions.
- **No active scope → graceful passthrough:** `dedupe`/`cachedFetch` เรียกนอก request scope
  (เช่น test, script) → ทำงานเป็น no-cache passthrough (เรียก fn/fetch ตรง) ไม่ throw. (ต่างจาก
  store ที่ throw — loader cache เป็น optimization ไม่ใช่ correctness).

## Wiring

`runInRequestCache` ต้องครอบช่วงที่ loader รัน. จุดที่ loader รัน (เหมือน `runInStoreContext`):
- native chain loaders: `routes.ts` `runNativeChainLoaders` call sites (~`:726`, `:1122`)
- React loaders: `buildRenderElement` path (`routes.ts` ~`:759`/`:1106`)

แทนที่จะ wrap แยก ให้ **รวมกับ store context**: เพิ่ม `runInRequestCache` ซ้อน `runInStoreContext`
ที่ call sites เดิม (หรือทำ helper `runInRequestContext(fn)` = store ∘ cache). nested ALS สอง
ตัวซ้อนกันปลอดภัย. action handlers ไม่ wrap รอบนี้ (scope = loader/render; ขยายทีหลังได้).

## File-level changes
1. `runtime/loader-cache.ts` (ใหม่): ALS + `runInRequestCache` + `dedupe` + `cachedFetch`.
2. `runtime/routes.ts`: wrap loader call sites ด้วย `runInRequestCache` (ซ้อน store context).
3. `runtime/index.ts`: export `dedupe`, `cachedFetch` (value). (ไม่ export `runInRequestCache` —
   internal, เรียกจาก routes.)
4. dogfood `example/pokedex/lib/`: `typeChartLoader` ใช้ `cachedFetch`/`dedupe`; ถ้ามี same-URL
   ใน detail chain (species/evolution) ใช้ด้วย.

## Tests
### `runtime/loader-cache.test.ts` (ใหม่)
- `dedupe`: same key concurrent → fn เรียกครั้งเดียว (spy count===1), ทั้งคู่ได้ผลเดียวกัน.
- `dedupe`: different keys → fn ต่อ key.
- `dedupe`: fn reject → key ถูกลบ, เรียกซ้ำ key เดิม → fn เรียกใหม่ (ไม่ cache error).
- `dedupe`/`cachedFetch` นอก scope → passthrough (fn เรียกทุกครั้ง, ไม่ throw).
- `cachedFetch`: GET same url concurrent → fetch ครั้งเดียว (mock fetch), แต่ละ caller อ่าน body ได้ (clone).
- `cachedFetch`: non-GET (POST) → bypass (fetch ทุกครั้ง).
- scope isolation: สอง `runInRequestCache` แยก → ไม่ share cache.
### `runtime/routes.test.ts`
- loader call site wraps request-cache: loader ที่เรียก `dedupe` เห็น scope (ไม่ passthrough).

## Acceptance criteria
1. `cd runtime && bun test loader-cache.test.ts` เขียว; full `bun test` ไม่ regress (baseline 376/0... main).
2. `bun run ci` (biome) เขียว.
3. export `import { dedupe, cachedFetch } from 'brustjs'` resolve.
4. dogfood: typeChartLoader ใช้ `cachedFetch`/`dedupe`; pokedex build + type-chart render เท่าเดิม (361 cells).
5. dedupe พิสูจน์ได้: same-URL ใน request เดียว fetch ครั้งเดียว (unit + ถ้าเป็นไปได้ integration).

## Known limitations
- request-scoped เท่านั้น (ไม่ cross-request / ไม่ persistent — นั่นคือ ISR `cache` แยกกัน).
- cache ผูกกับ ALS scope → นอก loader/render (เช่น action) ไม่ active (passthrough) จนกว่าจะขยาย wrap.
- ไม่มี TTL/size-limit (request lifetime สั้น — ไม่จำเป็น).

## Open questions → resolved
- **Q: cache `Response` body อ่านได้ครั้งเดียว?** เก็บ resolved `Response`, คืน `.clone()` ต่อ caller
  (clone ได้ก่อนอ่าน). หรือเก็บ `dedupe` ที่ระดับ `.json()` แทน (caller เรียก `dedupe(url, ()=>fetch().then(r=>r.json()))`).
  **Resolution:** `cachedFetch` เก็บ Response, `.clone()` ต่อ caller; ถ้า caller จะ parse เอง ก็ใช้ `dedupe` กับ parsed value ตรงๆ (ยืดหยุ่นกว่า). doc ทั้งสอง pattern.
- **Q: รวม ALS กับ store หรือแยก?** แยก ALS (loader-cache.ts) — clean separation, store map พิมพ์เป็น StoreInstanceRecord อยู่แล้ว. wrap ซ้อนที่ call site.
