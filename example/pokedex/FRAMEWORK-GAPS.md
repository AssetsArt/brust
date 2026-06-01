# PokéDex — Framework gaps & "what native can't do"

> Deliverable ของ example นี้คือ **รายการ gap** ที่โผล่ออกมาตอน dogfood brust ด้วยการ
> สร้าง PokéDex โดยพยายามใช้ **`native: true` ให้มากที่สุด** (ทั้ง 3 route เป็น native).
>
> แต่ละข้อระบุ:
> - **สถานะ** — `CONFIRMED` = เจอจริงตอน build/run ครั้งนี้ · `BY-DESIGN` = ข้อจำกัดที่ตั้งใจ
> - **อาการ** ที่เจอ · **ทำไม** · **workaround ที่ใช้ในแอปนี้** · **proposal**
>
> ความรุนแรง: ★ บล็อกงานหลัก · ◆ ต้องตัดสินใจแทน framework · ○ DX/ergonomics

สแต็กที่ทดสอบ: macOS arm64 · Bun 1.4.0 · brust 0.1.12-alpha · `brust build` → `bun run`.

---

## สรุปสั้น (native เขียนยังไงให้ผ่าน)

จาก gap S1–S3 รวมกัน ได้ "กฎเหล็กของ native route" ที่บังคับทั้งแอป:

> **template ของ native route แสดงได้แค่ member-path + `.map()` เท่านั้น** — ห้าม
> `style={{…}}`, ห้าม conditional, ห้ามเรียก helper/format, ห้าม arithmetic/compare/
> template-literal **ทุกอย่างต้องคำนวณล่วงหน้าใน loader** แล้วส่งเป็น field ดิบ
> (string/number/array). ดูได้จาก `lib/loaders.ts` — มันยาวเพราะมันคือ "view layer"
> ตัวจริง ส่วน `pages/*.tsx` แทบเป็น HTML ล้วน.

---

## ★ S11 — native route ใช้ conditional ไม่ได้เลย · ✅ FIXED (แก้ framework แล้ว)

**fix:** ปลด gate `scope.inline.is_some()` ออกจากการ recognize `{cond && <X/>}` / `{a ? <A/> : <B/>}`
ใน `lower_child` ให้ native route body ใช้ได้ด้วย. test รับ member-path truthiness · `!path` ·
comparison (`x.n > 0`, `===`/`!==` → jinja `==`/`!=`) · logical (`&&`/`||`) ผ่าน `lower_cond_test`
+ `lower_cond_operand` (operand จำกัด member-path/literal — arithmetic/call ถูก reject). branch
รับ JSXElement/JSXFragment/`null`→Empty; per-item cond ใน `.map` ก็ได้. emit ใช้ `JsxNode::Cond`
เดิม (ไม่แตะ). ดู spec `docs/superpowers/specs/2026-06-01-native-compiler-expressiveness-design.md` S11.
**dogfood:** pokedex ทิ้ง `prevClass`/`nextClass`/`contentClass`/`notFoundClass`/`sepClassName`/
`levelClassName` แล้วใช้ conditional จริง.

**อาการเดิม:** `brust build` ล้มทันทีที่หน้ามี `{cond ? <a/> : <span/>}`:

```
native route "ListPage" failed to compile (pages/ListPage.tsx):
  ListPage.tsx:102:18: complex expression (binary/conditional/unary)
  not supported in Phase A1
```

**ทำไม:** ใน compiler (`crates/jsx-rust-compiler/src/lower.rs`) การ lower
`{cond && <X/>}` และ `{a ? b : c}` ให้เป็น `JsxNode::Cond` ถูก **gate ด้วย
`scope.inline.is_some()`** — คือทำงานเฉพาะตอน inline ขยาย `<Comp native/>` เท่านั้น
ส่วน body ของ native **route** component (ไม่ใช่ inline) มี `scope.inline == None`
→ ternary/`&&` ตกไปที่ `lower_expr` → `SwcExpr::Cond => ComplexExpressionNotSupported`.

**workaround ในแอปนี้:** ลบ conditional ออกจากทุกหน้า แล้วใช้ **hide-class ที่ loader
คำนวณ** + render เสมอ:
- pagination disabled → `prevClass`/`nextClass` (`…dex-pager__btn--off`, `pointer-events:none`) แทน `{hasPrev ? <a> : <span>}`
- detail notFound → render **ทั้ง** content และ 404 block เสมอ แล้วซ่อนอันหนึ่งด้วย `contentClass`/`notFoundClass` (`dex-hide`)
- evolution arrow/level ตัวแรก → `sepClassName`/`levelClassName` มี `dex-hide`
- abilities/evolution section ว่าง → ผูก `dex-hide` ผ่าน class

**proposal:** ปลด gate ให้ `{cond && …}` / ternary ทำงานใน native route body ด้วย
(operand จำกัดเป็น member-path truthiness ก็ยังดีกว่าไม่มี) — ไม่งั้นทุกหน้าจริงจะมี
loader ที่บวมด้วย `xxxClass` เต็มไปหมด.

---

## ★ S1 — `style={{…}}` object ใช้ใน native ไม่ได้ · ✅ FIXED (แก้ framework แล้ว)

**fix:** `lower_attr` intercept `style={{…}}` → serialize เป็น `style="…"` (all-literal → `AttrValue::Static`;
มี member-path → `AttrValue::Expr(Concat)`). key camelCase→kebab (รวม vendor `-webkit-`/`-moz-`/`-ms-`/`-o-`
+ custom prop); numeric literal ใส่ `px` อัตโนมัติ (ยกเว้น React unitless set); negative (`-8`) รองรับ.
ดู spec S1. **dogfood:** `barWidth`/`iconColor` เป็น bare value ป้อน `style={{…}}`; `heroStyle` (gradient
หลาย property) ยังเป็น precomputed string ผ่าน `style={heroStyle}` (member-path attr ปกติ).

**อาการเดิม:** attribute ที่ค่าเป็น object literal (`style={{ width: 62 }}`) ถูก reject
(`lower_expr` ไม่มีเคส `Object`). prototype ดีไซน์ทุกชิ้นพึ่ง inline style — ย้ายมา native
ไม่ได้เลยตรงๆ.

**ทำไม:** native attribute รับได้แค่ member-path / string-literal / int-literal
(`lower.rs` lower-attr). React style เป็น object → ไม่แปลเป็น HTML attribute.

**workaround:** ทุก style ที่ dynamic คำนวณเป็น **string** ใน loader แล้วส่ง member-path:
`style={st.barWidth}` (= `"width:62%"`), `style={heroStyle}` (= `"background:linear-gradient(…)"`),
`style={a.iconStyle}`. ที่เหลือเป็น `className` ทั้งหมด (เลยต้องเขียน `.dex-*` layer ใหญ่
ใน `app.css` แทน inline style ของ prototype).

**proposal:** รองรับ `style={{…}}` แบบ static-literal → serialize เป็น `style="…"` ตอน build
(อย่างน้อย object ที่ทุกค่าเป็น literal/​member-path).

---

## ★ S3 — native ↔ Suspense streaming ใช้ร่วมกันไม่ได้ · BY-DESIGN (ยืนยันแล้ว)

**อาการ:** อยากให้ evolution chain (fetch ช้า) stream เข้ามาทีหลังด้วย `<Suspense>` แต่
native route render ใน Rust/jinja **ไม่มี React tree** → ไม่มี `renderToPipeableStream`
→ stream ไม่ได้.

**การตัดสินใจ:** ตามคำสั่ง "native ให้มากที่สุด" → เลือก native ทั้ง 3 route แล้ว
**โหลด evolution แบบ blocking ใน loader** (ดู `detailLoader`). แลกกับการ **ไม่ได้ dogfood
Suspense streaming เลย** ในแอปนี้.

**proposal:** เอกสารระบุชัดว่า native = ไม่มี streaming; ให้ "hybrid route" (jinja shell +
React island ที่ stream เองได้) เป็นทางออกถ้าต้อง progressive.

---

## ★ S12 — bodyless DELETE action → HTTP 411 · CONFIRMED (เจอใน browser จริง)

**อาการ:** ปุ่ม Remove เรียก `api.team({id}).delete()` แล้ว console ขึ้น:

```
Failed to load resource: the server responded with a status of 411
(Length Required) @ /_brust/action/team/6
```

**ทำไม:** action dispatch ฝั่ง Rust (`server.rs`) บังคับ `Content-Length` บนทุก method
ที่ไม่ใช่ GET/HEAD → ไม่มีก็ตอบ 411. แต่ `fetch(url,{method:'DELETE'})` ของ browser
**ไม่ส่ง `Content-Length: 0`** เมื่อไม่มี body. treaty client ก็ส่ง DELETE แบบไม่มี body.

**workaround ในแอปนี้:** เรียก **`api.team({id}).delete({})`** — ส่ง body `{}` (เพราะ treaty
ถือว่า delete ไม่ใช่ bodyless) → มี `Content-Length: 2` → ผ่าน 200. (ยืนยันแล้ว: bodyless = 411,
มี `{}` = 200.)

**proposal:** ฝั่ง Rust ถ้า method มีได้-ไม่มีก็ได้ (DELETE) ให้ treat `Content-Length`
ที่หายเป็น 0 แทน 411; หรือ treaty ใส่ `Content-Length: 0` ให้ DELETE อัตโนมัติ.

---

## ★ S13 — SPA navigation พังบน native route → full reload ทุกครั้ง · ✅ FIXED (แก้ framework แล้ว)

**อาการ:** คลิก internal link ทุกครั้ง network tab ขึ้น `GET <name>` **500 (fetch)** ตามด้วย
`GET <name>` **200 (document)** — คือ SPA navigation fetch พัง แล้ว fallback ไป full document
load เสมอ (เสีย performance ของ SPA ทั้งหมด).

**root cause:** `navigationBranch` (`runtime/routes.ts`) React-render ทุก route ผ่าน
`buildRenderElement` + `renderToString` **เสมอ — ไม่มี native branch**. native component
destructure loader fields ตรงๆ (`{ types, items, cells }`) ซึ่ง navigation ส่งเป็น `data` prop
ไม่ได้ spread → `types` เป็น `undefined` → `.map()` throw → 500 → client เห็น non-2xx แล้ว
full-reload. (`TypeError: undefined is not an object (evaluating 'types.map')` ที่ `DetailPage`.)

**fix (TS-only, ไม่แตะ Rust):** เพิ่ม native branch ใน `navigationBranch` — ถ้า
`flat.nativeTemplate` ให้ render ผ่าน **minijinja ฝั่ง Rust** (helper `renderNativeRouteToHtml`
ใช้ `napiRenderJinja` ที่มีอยู่ ซึ่งเขียน `[meta_len][meta][body]` ลง SAB) แล้วอ่าน body กลับมา
extract `<main>` + `<title>` เหมือน React path. React route ใช้ path เดิม (ไม่กระทบ).

**verify:** `/_brust/page/{,pokemon/charizard,type-chart}` → 200 + `{html,title}` ครบ;
browser คลิก card → URL เปลี่ยน, content swap, **ไม่ full reload** (window flag รอด),
TeamBuilder island คงอยู่. regression test: `tests/native-island-ssr.test.ts` →
`nav: /_brust/page/<native route> returns {html,title}` (5/5 pass, nav tests เดิมไม่ regress).

---

## ◆ stale island chunk cache หลัง rebuild · CONFIRMED

**อาการ:** แก้โค้ด island, rebuild, refresh — browser ยังรันโค้ดเก่า (เจอตอน fix S12:
chunk ที่ cache ไว้ยังเป็น `delete()`, ตัว fresh เป็น `delete({})`).

**ทำไม:** island chunk เสิร์ฟด้วย `Cache-Control: max-age=3600` และ **filename ไม่ content-hash**
(`AddToTeamButton.js` คงเดิม) → browser cache ค้างได้ถึง 1 ชม. (architecture.md ก็ระบุว่า
"fingerprint at the CDN for prod").

**workaround:** ทดสอบบน origin ใหม่ (เปลี่ยน port) เพื่อล้าง cache. dev จริงควร hard-reload.

**proposal:** dev เสิร์ฟ island เป็น `no-store` (หรือ content-hash filename) เพื่อกัน stale.

---

## ◆ native route ต้อง `brust build` ก่อน — `bun run` ไม่ compile jinja ตอน boot · CONFIRMED

**อาการ:** `bun run example/pokedex/index.ts` ตรงๆ → boot warning + ทุก native route 500:

```
native: true route expects template "ListPage.jinja" but it's not registered
  (boot warning — request will 500)
```

**ทำไม:** boot build เฉพาะ CSS + island chunks; การ compile JSX→jinja อยู่ใน `brust build`
เท่านั้น (แล้ว mirror ไป `cwd/.brust/jinja` ให้ source-run เจอ).

**workaround:** รัน `bun run runtime/cli/index.ts build example/pokedex/index.ts` ก่อนเสมอ
แล้วค่อย `bun run example/pokedex/index.ts`. (ดู README.)

**proposal:** ให้ `bun run` (source mode) compile native route ตอน boot ถ้า `.brust/jinja`
ยังไม่มี/ล้าสมัย — ลด step + กัน "ลืม build แล้ว 500".

---

## ◆ S9 — ไม่มี notFound()/redirect() sentinel; native loader ตั้ง status ไม่ได้ · CONFIRMED

**อาการ:** `/pokemon/<ชื่อมั่ว>` → PokeAPI 404 แต่หน้าเราตอบ **HTTP 200** พร้อม 404 body.

**ทำไม:** loader คืน data อย่างเดียว ไม่มี `notFound()`/`redirect()` และ native loader
ตั้ง HTTP status ไม่ได้ (status มาจาก render meta ฝั่ง React path).

**workaround:** loader คืน `notFound: true` + ผูก `notFoundClass`/`contentClass` ให้ template
สลับ block (ยัง 200).

**proposal:** `return notFound()` / `return redirect('/x')` sentinel ที่ map เป็น 404/302 ได้
แม้บน native route.

---

## ◆ S8 — `<BrustPage>` head props เป็น string literal เท่านั้น → `<title>` dynamic ไม่ได้ · ✅ FIXED

**fix:** IR ใหม่ `HeadValue{Literal,Path}`; `<BrustPage>` head props (title/description/lang/className/
bodyClassName) รับ member-path → emit `{{ path }}` ลง slot ที่ตรง (`<title>{{ pageTitle }}</title>`).
non-path (call/arith) ยัง reject เป็น `BrustPageAttrMustBeStringLiteral`. dynamic value **HTML-escaped**
ด้วย `{{ (path) | e }}` (security fix `5a4c4ca` — `AutoEscape::None` จึงต้อง escape เอง; เดิมร่างไว้ verbatim
ซึ่งเป็น XSS). ดู spec S8. **dogfood:** detail ใช้ `<BrustPage title={pageTitle}>`,
loader ตั้ง `pageTitle = "<Name> · PokéDex"` (ครบทุก path รวม 404).

**อาการเดิม:** อยากได้ `<title>Charizard · PokéDex</title>` แต่ native บังคับ
`title="…"` เป็น literal → ทุกหน้า detail ใช้ title เดียว `"PokéDex · detail"`.

**ทำไม:** native path render `<head>` ฝั่ง Rust ตอน build → props ต้องเป็น compile-time literal
(`BrustPageAttrMustBeStringLiteral`).

**proposal:** ให้ `<BrustPage title={data.title}>` รับ member-path แล้ว interpolate ลง jinja
(เหมือน body) — `<title>{{ title }}</title>`.

---

## ◆ S4 — ไม่มี cross-island shared-state primitive · CONFIRMED (workaround ใช้ได้)

**อาการ:** `AddToTeamButton` กับ `TeamBuilder` เป็นคนละ island/คนละ bundle ต้องโชว์ทีมเดียวกัน.
import store กลางร่วมกัน = ถูก bundle ซ้ำเป็นคนละ instance → ไม่ sync.

**workaround:** `components/team-bus.ts` ใช้ `window` CustomEvent (สิ่งเดียวที่ทุก chunk แชร์จริง).
ยืนยันใน browser: กด Add ที่หน้า detail → dock count อัปเดตทันที.

**proposal:** `createIslandStore()` หรือ documented pattern + ตัวอย่าง optimistic+reconcile.

---

## ◆ S6 — ไม่มี request/session context; team store เป็น global · CONFIRMED

team store เป็น module-scope Map = แชร์ข้ามทุก request/ทุก visitor. action handler รับ
`{req,body,params,query}` แต่ไม่มี session/cookie helper. สำหรับ dogfood นี่โอเค แต่ทำ
multi-user ไม่ได้ถ้าไม่มี context primitive.

---

## ◆ S7 — ไม่มี typed domain-error ผ่าน treaty · CONFIRMED

handler "ไม่ throw" ผ่าน boundary → "ทีมเต็ม" ต้อง encode ใน success payload เอง
(`{ team, max, full: true }`) แล้ว client เช็คสองที่ (`error` ของ transport + `data.full`).
ดู `actions.ts`.

**proposal:** `throw new ActionError(status, code)` → treaty map เป็น typed discriminated union.

---

## ○ S2 — ไม่มี loader batch/dedupe/request-cache · CONFIRMED

`typeChartLoader` ต้อง `Promise.all` 18 fetch เอง, ไม่มี request-scoped cache/dedupe.
list page เลี่ยง N+1 ด้วยการ derive artwork จาก id (ยิง PokeAPI ครั้งเดียว/หน้า) — workaround
ไม่ใช่ pattern ที่ framework เสนอ.

---

## ○ ไม่มี static/public asset serving · CONFIRMED

เสิร์ฟได้แค่ `/_brust/css/*` กับ `/_brust/islands/*` — ไม่มี public dir. logo-mark ของ
prototype เลยใช้ไม่ได้ → แทนด้วย brand-mark gradient + ตัว "P" (CSS ล้วน). `favicon.ico`
ก็ 404 ใน console.

**proposal:** เสิร์ฟ `public/` (favicon, รูป, sprite cache) ผ่าน static route.

---

## ○ native ใช้ component ใน body ลำบาก (chrome ซ้ำ 3 หน้า) · CONFIRMED (เลี่ยงแล้ว)

native route ใช้ capitalized component ได้ก็จริง (SSR-component factory) แต่ component ที่
**รับ `children`** จะถูก worker `renderToString` → children (เนื้อหา native ของหน้า) จะกลาย
เป็น React ไม่ใช่ jinja = เสีย native. เลย **เขียน sidebar/topbar ซ้ำในทั้ง 3 หน้า** แทน
shared layout. (`<Outlet>`/nested route เป็นของ React path ไม่ใช่ native.)

**proposal:** layout/Outlet สำหรับ native route ที่ children ยัง compile เป็น jinja.

---

## ○ nested `.map()` บน native ไม่มี fixture ยืนยัน · เลี่ยงไว้ก่อน

type chart 18×18 ถ้าทำ `rows.map(r => …r.cells.map(c => …))` (map ซ้อน map) ไม่มี golden
fixture รับรอง เลย **flatten เป็น array เดียว 19×19 ใน loader** แล้ว `.map()` ชั้นเดียวลง CSS grid
(`TypeChartData.cells`). ปลอดภัยกว่า + ได้ผลสวย.

---

## ○ dark-mode only — `<BrustPage>` ตั้งได้แค่ html class · CONFIRMED (เลี่ยงแล้ว)

design ใช้ `[data-mode="dark"]` toggle. `<BrustPage>` ตั้งได้แค่ `lang`/`className` (html class)
ไม่ตั้ง `data-*` ตามใจ → rewrite CSS เป็น `.dark` แล้ว `<html class="dark">` (dark อย่างเดียว,
ตัด toggle). theme toggle จริงต้องเป็น island หรือ cookie round-trip.

---

## ✅ สิ่งที่ทำงานดี (เพื่อความเป็นธรรม)

- **native route ทั้ง 3 หน้า compile + render ฝั่ง Rust ได้จริง** — view-source เห็น HTML เต็ม, 0 React บน server สำหรับ shell.
- `.map()` → `{% for %}` member-path ทำงานเนียน (grid 20 cards, stats 6 bars, evolution, type-chart 361 cells).
- **island ใน native page** hydrate ได้ (TeamBuilder ssr + AddToTeamButton client) — verify ด้วย browser: add/remove/cross-island sync ครบ.
- **treaty actions** (GET/POST/DELETE) ทำงาน, zod validate body, team store persist ข้าม request.
- `app.css` เป็น **plain CSS (ไม่มี `@import "tailwindcss"`)** ก็ผ่าน `@tailwindcss/node` (passthrough) เสิร์ฟ 60KB ครบ token + `.aa-*` + `.dex-*`.
- `req.search` เป็น parsed object พร้อมใช้, zod validate offset ใน loader ได้.

---

*PokéDex · dogfooding brust 0.1.12-alpha · AssetsArt Design System · เก็บ gap จากการ build/run จริง*
