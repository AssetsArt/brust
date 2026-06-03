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
  ที่เป็น **`export default function`** (find_default_export match แค่ default export —
  `lower.rs:406`; bare `function` → `UnexpectedStatement`):
  ```tsx
  export default function ListPage__chain() {
    return <AppLayout native><Leaf native/></AppLayout>   // 3-level: <A native><Mid native><Leaf native/></Mid></A>
  }
  ```
  **ทุก level ต้องมี attr `native`** (probe ยืนยัน — ลืม `native` บน child = ตกเป็น SsrComponent/React-render).
- **B1 (load-bearing) — gather sources ทั้ง chain ไม่ใช่แค่ leaf:** `gatherComponentSources` (~`:71`)
  seed จาก import graph ของ **leaf เท่านั้น** (`scanImports(leafFile)`). โมเดลใหม่ leaf เป็น fragment ที่
  **ไม่ import layout แล้ว** → layout source จะ**หาย**จาก map → `<AppLayout native>` soft-fall เป็น
  SsrComponent (พัง native เงียบๆ). synth step ต้อง **union `gatherComponentSources()` ของ source-path
  ของ component ทุกตัวใน chain** (resolve แต่ละตัวจาก import map ของ `routes.tsx` ที่ `scanImports(entryFile)`
  ผลิตอยู่แล้ว ~`:342`) + ใส่ source ของ synth wrapper เอง.
- **F2:** widen type `flatRoutes` ใน 3 จุด (`native-routes-emit.ts:137`, `build.ts:331`, `dev.ts:85`) ให้
  expose `chain` (object จริงเป็น `FlatRoute` มี `chain` runtime อยู่แล้ว — `routes.ts:421`).
- ชื่อ template = leaf `nativeTemplate`. chain.length===1 → path เดิม (ไม่ synth, ไม่ regress).

### 3. Compiler (`crates/jsx-rust-compiler/`) — `<Outlet/>` builtin
- `lower.rs` `lower_element`: รับ `<Outlet/>` เป็น builtin **ก่อน** arm capitalized-tag→SsrComponent
  (~`:588-593`; วันนี้ `<Outlet/>` ตกที่ arm นั้น → SsrComponent ตาม probe) → emit `JsxNode::ChildrenSlot`
  (`ir.rs:112`) **unconditional** (ไม่ gate ด้วย `scope.inline`). หมายเหตุ: gate `{children}`→slot ที่
  `lower.rs:2530` เป็น **expr-path** ไม่กระทบ element-path; `splice_children_slots` (`:1558`) จัดการเคส
  zero call-site children ได้อยู่แล้ว.
- `<Outlet/>` ห้ามมี children/props (void) → error ใหม่ `OutletMustBeEmpty` (สำหรับ native compile path
  แม้ TS signature จะกันอยู่แล้ว).
- เก็บ `{children}` ให้ทำงานเหมือนเดิม (PageLayout composition ที่ ship แล้วต้องไม่ regress).

### 4. Exports — `runtime/index.ts`
- **Q2 resolved:** `Outlet` export อยู่แล้ว (`index.ts:732` → `routes.ts:437`, `Outlet(): ReactNode` ไม่มี
  props) — `<Outlet/>` type-check ผ่าน, `<Outlet prop/>`/`<Outlet>x</Outlet>` เป็น TS error อยู่แล้ว.
  **reuse ได้ ไม่ต้อง native-shim.** (native path เห็น `<Outlet/>` เป็น builtin tag ใน compiler; React path
  ใช้ฟังก์ชันเดิม.)

## Loader semantics (สำคัญ — the hard sub-problem)

native = flat jinja context เดียว. chain loaders รัน **top-down** (parent ก่อน leaf), ผลลัพธ์
**shallow-merge** เป็น object เดียว (`{...parentData, ...childData}`) — **child key ชนะ** เมื่อชื่อชน
(documented). เหตุผล: minijinja ไม่มี per-fragment scope; merge เป็นทางเดียวที่ template ทั้ง chain
อ้าง key ได้. inlined component ทุกตัว emit prop refs เป็น `Expr::Field(name)` → `{{ name }}` lookup จาก
flat context นี้ (`lower.rs:2958`) → merge เข้ากันได้. นี่ต่างจาก React "no merge"
(`2026-05-24-nested-routes-design.md`) โดยตั้งใจ — native constraint.
- **F3 (load-bearing):** chain loaders ต้องรันใน **`runInStoreContext` เดียวครอบทั้ง chain** (ไม่ใช่ per-loader).
  `runInStoreContext` alloc Map ใหม่ทุกครั้ง (`server-context.ts:12`); React chain path รันทุก loader ใน scope
  เดียว (`routes.ts:759`,`:1106`). ถ้า wrap แยก parent store-writes จะมองไม่เห็นใน child loader (diverge จาก React).
- **verdict:** loader แรกใน chain (top-down) ที่คืน `notFound()`/`redirect()` short-circuit ทันที
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
   - **F5 — chrome-prop migration (จำเป็นต่อ AC5):** วันนี้ leaf ส่ง `title/active/crumb/teamProps` เป็น
     **props** ให้ `<PageLayout>` (`ListPage.tsx:25`) แล้ว PageLayout branch บนมัน (`active==='list'`
     `PageLayout.tsx:47`; Island `props={teamProps}` `:91`). โมเดลใหม่ synth wrapper = `<AppLayout native>
     <Leaf native/></AppLayout>` **ไม่มี props บน AppLayout** → ค่าพวกนี้หาย. ต้อง: **แต่ละ leaf loader คืน
     `title/active/crumb/teamProps`** ลง merged context แล้ว **AppLayout อ่านเป็น member-path/conditional**
     (`{{ title }}`, `data.active === 'list'` (S11), `<TeamBuilder props={data.teamProps}/>`). ไม่งั้น
     active-nav/title/team-dock ใช้ไม่ได้.
6. chain.length===1 (route เดี่ยวไม่ nest) ทำงานเหมือนเดิม (ทั้ง pokedex ปัจจุบันถ้ายังไม่ย้าย).

## Known limitations (documented)
- layout duplicated ลง **แต่ละ leaf template** (build-time inline) — ไม่ share template ตอน runtime
  (นั่นคือ approach b). disk/template size โตตามจำนวน leaf × layout — ยอมรับ.
- loader **merge** (ไม่ใช่ per-level scope) → key collision **silent, child wins** (Q3). กับ propless
  layout, field refs ของ layout เองก็ alias เข้า shared loader namespace เดียวกัน — ชนกันเงียบ. documented.
- **`<main>` convention (Q1):** SPA-nav extract `<main>` ตัวแรกถึง `</main>` ตัวแรก (`routes.ts:991`).
  composed template มี `<main>` เดียวเพราะ **layout เป็นเจ้าของ `<main>`** (leaf เป็น fragment ใน slot).
  ถ้า leaf ใส่ `<main>` เองด้วย → extraction truncate ผิด. **convention: layout owns `<main>`, leaf ห้ามมี**
  → plan เพิ่ม build warning ถ้า leaf fragment มี `<main>` (nice-to-have).
- mixed native/non-native ใน chain เดียว = ไม่รองรับ (reject ด้วย error ชัด).

## Open questions → resolve at plan-time / Task 0 probe
- **`<Outlet/>` lowering ใน synth wrapper จริงๆ ผ่านไหม** (vs ต้องใช้ `{children}` + destructured prop)?
  → **Task 0 probe ตัดสิน** (reproduce-first; อาจเปลี่ยน scope เหมือน S7).
- TS JSX symbol สำหรับ native `<Outlet/>` — reuse React `Outlet` export หรือ native-shim? → Task 0.
- mixed chain (native parent + React child หรือกลับกัน) — reject ด้วย error ชัด หรือ allow? → reject (scope).
- parent layout มี island/`x-*` directives ใน chain ได้ไหม → ควรได้ (inline เดิมรองรับ); ยืนยันใน dogfood.

## Reproduce-first probe — ✅ DONE (2026-06-03, ก่อน review)

รันผ่าน throwaway test เรียก `compile_full(route, path, component_sources)` จริง (jsx-rustc CLI
ส่ง map ว่าง inline ไม่ได้ — same-file ไม่ resolve). **ผลยืนยัน core premise + ลด scope:**

1. **synth wrapper inline + splice ทำงานวันนี้ผ่าน `{children}`** — ไม่ต้องแตะ doc_root/splice เลย:
   - `<AppLayout native><Leaf native/></AppLayout>` (AppLayout มี `{children}`, Leaf = `<section>`)
     → `<html><head>…<title>x</title>…</head><body><nav>chrome</nav><main class="content"><section>leaf-content</section></main></body></html>` — **composed Document เต็ม, 0 React, content splice เข้า slot สะอาด**.
   - **3-level** `<A native><Mid native><Leaf native/></Mid></A>` → `<main class="content"><div class="mid"><section>leaf-content</section></div></main>` — recurse ถูก.
   - **เงื่อนไขสำคัญ:** child ทุก level ต้องมี attr `native` (synth wrapper ต้อง emit `<Leaf native/>`).
     ถ้าลืม → child ตกเป็น **SsrComponent** (`{{ comp_0_html | safe }}` = React-render, พัง native).
2. **`<Outlet/>` วันนี้ = SsrComponent** (`<BrustPage>…<Outlet/></>` → `{{ comp_0_html | safe }}`) →
   **ยืนยันต้องเพิ่ม `<Outlet/>` builtin** lower → `ChildrenSlot` (ไม่งั้น native React-render Outlet).
   `<Outlet/>` เป็น **sugar** เหนือ `{children}` — layout เขียน `{children}` ก็ทำงานได้แล้ว แต่ `<Outlet/>`
   idiomatic + ตรง React routes + ไม่ต้อง destructure `children` param.

**ผลต่อ scope (ลดลง):** compiler งานใหม่เหลือแค่ `<Outlet/>` → ChildrenSlot lowering (doc_root/splice/
inline-recursion reuse ได้หมด, ยืนยันแล้ว). TS: synth wrapper ต้อง **mark ทุก level เป็น `native`**
(ข้อ 1 ข้างบน — load-bearing). ban probe (`routes.ts:337`) ไม่ต้องรันซ้ำ — code อ่านชัดว่าเป็นกำแพง.
