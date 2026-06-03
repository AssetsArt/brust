# native `<Outlet>` / router-level layout injection — Approach (a) build-time desugar

> Status: design · 2026-06-03 · branch `feat/native-outlet-router-layout`
> Gap: `example/pokedex/FRAMEWORK-GAPS.md` "native Outlet/router-level layout injection" (◆)
> Architecture map (this session): native render is leaf-only (`routes.ts:637`), `native+children`
> banned (`routes.ts:337`), compiler already has `ChildrenSlot`/`splice_children_slots`/`doc_root`.

## Goal

ให้ author ประกาศ **nested native routes** ใน route tree แล้วใช้ `<Outlet/>` ใน layout component
— framework ประกอบ parent-layout + child-content ให้ ตามโมเดล React nested routes ที่ repo มีอยู่แล้ว
(`docs/superpowers/specs/2026-05-24-nested-routes-design.md`) แต่สำหรับ native path.

วันนี้ (composition): ทุก route เขียน `<PageLayout native title=… active=…>{inner}</PageLayout>` ซ้ำ
ทุกไฟล์. หลังแก้ (router-level):
```tsx
// routes.tsx
defineRoutes([
  { native: true, Component: AppLayout, loader: shellLoader, children: [
    { path: '/', native: true, Component: ListPage, loader: listLoader },
    { path: '/pokemon/{name}', native: true, Component: DetailPage, loader: detailLoader },
  ]},
])
// AppLayout.tsx — layout เขียนครั้งเดียว
export default function AppLayout() {
  return <BrustPage title="PokéDex"><nav>…</nav><main className="aa-content"><Outlet/></main></BrustPage>
}
// ListPage.tsx — แค่ fragment เนื้อหา ไม่มี <BrustPage>
export default function ListPage() { return <section>…</section> }
```

## Approach (a): build-time desugar (chosen)

แทนที่จะทำ runtime composition (separate templates + minijinja block override — **deferred, approach b**),
**desugar เป็น per-leaf synthetic wrapper แล้ว compile ด้วย inline machinery ที่ ship แล้ว.** ต่อ
native leaf ที่มี chain `[AppLayout, ListPage]` build จะ synthesize source:
```tsx
function ListPage__chain() { return <AppLayout native><ListPage/></AppLayout> }
```
แล้วป้อน `compile_full` พร้อม component sources ของทั้ง chain. inline expansion เดิมจะ:
- promote `<BrustPage>` ที่ root ของ `AppLayout` expansion เป็น `Document` (`doc_root`, ship แล้ว)
- lower `<Outlet/>` ใน AppLayout → `ChildrenSlot`
- `splice_children_slots` แทน slot ด้วย call-site children (`<ListPage/>`) ซึ่งถูก inline-expand ต่อ
→ ได้ **1 template ต่อ leaf** (ชื่อ = leaf component name) = chain ประกอบเสร็จ. **Rust route table
ไม่เปลี่ยน** (ยัง 1 route_id → 1 template).

ข้อดี: reuse machinery ที่ test แล้ว (PageLayout composition ทำงานวันนี้); Rust แทบไม่แตะ;
multi-level ได้ (`<A><B><Leaf/></B></A>`).

## Non-goals (ดังๆ — out of scope, deferred to approach b)

- **Runtime separate-template composition** (compile layout + child แยก template, minijinja
  `{% block %}` override / TS splice, `native_templates: Vec<Vec<String>>` chain ใน Rust). ตัด.
- **Per-fragment loader scope.** native render = flat jinja context เดียว → chain loaders ถูก
  **shallow-merge** (ดู Loader semantics). ไม่ทำ per-level `data` prop แบบ React.
- **Layout route ที่ matchable เอง.** parent layout ไม่มี template ของตัวเอง — emit เฉพาะ leaf.
- React (non-native) nested routes — มีอยู่แล้ว (ship), ไม่แตะ.

## File-level changes

### 1. `runtime/routes.ts` — lift ban + native chain rendering
- `validateRoute` (~`:337`): ปลดเงื่อนไข "native + children ห้าม" → อนุญาต native parent ที่มี
  native children. (ยังห้าม mixed native/non-native ใน chain เดียว — ดู Open questions.)
- `flattenRoutes` (~`:376`) ผลิต `FlatRoute.chain` อยู่แล้ว — ใช้ต่อ. leaf `nativeTemplate` ยัง = leaf name.
- **native full render** (`makeRenderer` ~`:635-752`): เดิมรันแค่ leaf loader (`:637`). เปลี่ยนเป็น
  **รัน chain loaders top-down** แล้ว merge (ดู Loader semantics) ก่อนเขียน SAB. template ยัง = leaf name
  (synth wrapper ใช้ชื่อ leaf).
- **SPA nav** (`navigationBranch`/`renderNativeRouteToHtml` ~`:1026`): เช่นกัน — รัน chain loaders
  merge. `<main>`/`<title>` extraction (`:991-997`) ไม่เปลี่ยน (template เดียวประกอบเสร็จ → มี
  `<main>` เดียว `<title>` เดียว).

### 2. `runtime/cli/native-routes-emit.ts` — synth wrapper
- `emitNativeTemplates` (~`:313`): ต่อ native leaf ที่ `chain.length > 1` synthesize wrapper source
  `<Parent native><...><Leaf/>...</Parent>` (nest ตาม chain order, parent → leaf).
- `gatherComponentSources` (~`:18`) เก็บ source ของทุก component ใน chain (parent layouts + leaf) ให้
  compiler inline ได้.
- ชื่อ template = leaf `nativeTemplate`. chain.length===1 → path เดิม (ไม่ synth, ไม่ regress).

### 3. Compiler (`crates/jsx-rust-compiler/`) — `<Outlet/>` builtin
- `lower.rs`: รับ `<Outlet/>` (และ `<Outlet />`) เป็น builtin → lower เป็น `JsxNode::ChildrenSlot`
  (`ir.rs:112`). ปัจจุบัน `{children}`→slot เฉพาะ inline mode (`lower.rs:2530`); `<Outlet/>` ควร
  lower เป็น slot ใน **layout component body** (ซึ่งถูก inline ในตอน synth) — ยืนยันด้วย probe (Task 0).
- `<Outlet/>` ห้ามมี children/props (void). ถ้ามี → error ใหม่ `OutletMustBeEmpty` (หรือ reuse existing).
- เก็บ `{children}` ให้ทำงานเหมือนเดิม (PageLayout composition ที่ ship แล้วต้องไม่ regress).

### 4. Exports — `runtime/index.ts`
- `Outlet` ฝั่ง native เป็น **compile-time builtin tag** (เหมือน `<BrustPage>`) — ต้องมี JSX symbol
  ให้ TS ยอม. ตรวจว่า React `Outlet` ที่ export อยู่แล้ว (`routes.ts:427-438`) ใช้ได้กับ native หรือ
  ต้องมี native-shim (probe).

## Loader semantics (สำคัญ — the hard sub-problem)

native = flat jinja context เดียว. chain loaders รัน **top-down** (parent ก่อน leaf), ผลลัพธ์
**shallow-merge** เป็น object เดียว (`{...parentData, ...childData}`) — **child key ชนะ** เมื่อชื่อชน
(documented). เหตุผล: minijinja ไม่มี per-fragment scope; merge เป็นทางเดียวที่ template ทั้ง chain
อ้าง key ได้. นี่ต่างจาก React "no merge" (`2026-05-24-nested-routes-design.md`) โดยตั้งใจ — native
constraint. **verdict:** loader แรกใน chain (top-down) ที่คืน `notFound()`/`redirect()` short-circuit ทันที
(parent verdict ชนะ; ไม่รัน loader ที่เหลือ). chain.length===1 → merge = leaf data เดิม (ไม่ regress).

## Tests

### Compiler (Rust — `crates/jsx-rust-compiler/src/lib.rs` golden tests)
- `outlet_lowers_to_children_slot`: layout body `<BrustPage>…<Outlet/>…</BrustPage>` ถูก inline ใน synth
  wrapper → emitted jinja มี child content ตรงตำแหน่ง Outlet.
- `outlet_empty_only`: `<Outlet>x</Outlet>` หรือ `<Outlet prop=…/>` → error.
- `synth_wrapper_two_level`: `<A native><Leaf/></A>` → Document (จาก A) + Leaf content ใน slot.
- `synth_wrapper_three_level`: `<A><B><Leaf/></B></A>`.
- `children_still_works`: PageLayout `{children}` composition เดิม byte-identical (regression).

### Runtime (TS)
- `native-routes-emit` unit: chain `[A, Leaf]` → synth source ถูก, gatherComponentSources ครบ chain.
- `routes` unit: `validateRoute` ยอม native+native children; ยัง reject mixed native/non-native chain.
- loader merge: chain loaders top-down merge, child wins; parent `notFound()` short-circuits.
- `tests/jinja-route.test.ts`: route `/_test/outlet-*` (fixture nested native) render ผ่าน → มี
  `<main>` เดียว, content จาก leaf, shell จาก layout.
- SPA-nav (`tests/native-island-ssr.test.ts` หรือ `jinja-route`): `/_brust/page/<nested native>` →
  `{html,title}` ครบ.

## Acceptance criteria
1. Task 0 probe ยืนยัน synth-wrapper + `<Outlet/>` compiles (หรือเผย scope-change ก่อนสร้างจริง).
2. compiler golden tests + runtime tests เขียว; full `cd runtime && bun test` ไม่ regress (baseline ก่อนแก้).
3. `bun run ci` (biome) เขียว; `cargo fmt --check` + `cargo clippy --workspace --all-targets --locked -D warnings` เขียว; `cargo test --workspace` เขียว.
4. **rebuild napi** (`cd runtime && bun run build:debug`) หลังแก้ Rust ก่อน bun integration tests.
5. dogfood: pokedex routes.tsx เป็น nested (AppLayout + 3 leaf), layout เขียนครั้งเดียว ใช้ `<Outlet/>`;
   ทั้ง 3 หน้า build + render ฝั่ง Rust ได้ (view-source มี shell + content); SPA-nav ไม่ full-reload;
   pixel/structure เท่าเดิม (sidebar/topbar/team-dock + content).
6. chain.length===1 (route เดี่ยวไม่ nest) ทำงานเหมือนเดิม (ทั้ง pokedex ปัจจุบันถ้ายังไม่ย้าย).

## Known limitations (documented)
- layout duplicated ลง **แต่ละ leaf template** (build-time inline) — ไม่ share template ตอน runtime
  (นั่นคือ approach b). disk/template size โตตามจำนวน leaf × layout — ยอมรับ.
- loader **merge** (ไม่ใช่ per-level scope) → key collision ต้องระวัง (child wins, documented).
- mixed native/non-native ใน chain เดียว = ไม่รองรับ (reject).

## Open questions → resolve at plan-time / Task 0 probe
- **`<Outlet/>` lowering ใน synth wrapper จริงๆ ผ่านไหม** (vs ต้องใช้ `{children}` + destructured prop)?
  → **Task 0 probe ตัดสิน** (reproduce-first; อาจเปลี่ยน scope เหมือน S7).
- TS JSX symbol สำหรับ native `<Outlet/>` — reuse React `Outlet` export หรือ native-shim? → Task 0.
- mixed chain (native parent + React child หรือกลับกัน) — reject ด้วย error ชัด หรือ allow? → reject (scope).
- parent layout มี island/`x-*` directives ใน chain ได้ไหม → ควรได้ (inline เดิมรองรับ); ยืนยันใน dogfood.

## Reproduce-first probe (Task 0, ก่อนสร้างจริง)
Build `target/debug/jsx-rustc` แล้วลอง 2 อย่าง:
1. **synth wrapper compiles?** เขียน fixture `<AppLayout native><ListPage/></AppLayout>` (AppLayout ใช้
   `<Outlet/>` หรือ `{children}`; ListPage = fragment) → `jsx-rustc fixture.tsx -o out.jinja` → ดูว่าได้
   Document + content ใน slot ไหม, หรือ error อะไร.
2. **ban probe:** ใส่ native+children ใน `routes.tsx` ชั่วคราว → build → ยืนยัน `validateRoute` throw
   (`routes.ts:337`) เป็นกำแพงจริง.
ผลลัพธ์ probe → ปรับ plan ก่อนลงมือ task ถัดไป (ถ้า `<Outlet/>` ต้องเป็น `{children}` หรือ synth
ไม่ผ่าน → re-scope แล้ว escalate ผ่าน AskUserQuestion).
