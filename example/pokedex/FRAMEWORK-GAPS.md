# PokéDex — Framework gaps & "what native can't do"

> Deliverable ของ example นี้คือ **รายการ gap** ที่โผล่ออกมาตอน dogfood brust ด้วยการ
> สร้าง PokéDex โดยพยายามใช้ **`native: true` ให้มากที่สุด** (ทั้ง 3 route เป็น native).
>
> แต่ละข้อระบุ:
> - **สถานะ** — `✅ FIXED` = แก้ framework แล้ว · `CONFIRMED` = ยังเปิด, เจอจริงตอน build/run ·
>   `BY-DESIGN` = ข้อจำกัดที่ตั้งใจ
> - **อาการ** ที่เจอ · **ทำไม** · **workaround ที่ใช้ในแอปนี้** · **proposal**
>
> ความรุนแรง: ★ บล็อกงานหลัก · ◆ ต้องตัดสินใจแทน framework · ○ DX/ergonomics

สแต็กที่ทดสอบ: macOS arm64 · Bun 1.4.0 · brust 0.1.12-alpha · `brust build` → `bun run`.

---

## สถานะรวม (อัปเดต 2026-06-02)

**✅ FIXED แล้ว (9):** S11 conditionals · S1 `style={{…}}` · S8 dynamic head props ·
S13 SPA-nav (รอบก่อน) · **native layout (chrome ซ้ำ 3 หน้า)** (component-composition:
`<PageLayout native>` ที่ root ของ expansion เป็น `<BrustPage>` ถูก promote เป็น document shell) ·
**S12 (bodyless DELETE 411) — รอบนี้** (RFC 7230 §3.3.3: no CL + no TE = body length 0) ·
**S9 (native loader ตั้ง status ไม่ได้ → 404-as-200) — รอบนี้** (`notFound()`/`redirect()` sentinel)
— **S11/S1/S8 เป็น "Cluster A"**
([spec](../../docs/superpowers/specs/2026-06-01-native-compiler-expressiveness-design.md)),
พ่วง **XSS hardening** (`5a4c4ca`): dynamic HTML output ทุกจุด escape ด้วย `{{ (expr) | e }}`
แล้ว (เดิม verbatim = ช่อง XSS จริง — request param ไหลเข้า `<title>` ได้).

**ยังเปิด:** S2 (loader cache) ·
(**native Outlet/router-level layout injection — ✅ FIXED รอบนี้:** approach a build-time desugar —
nested native routes + `<Outlet/>`, synth wrapper reuse inline machinery, chain loader merge) ·
(**S7 typed treaty error — ✅ FIXED รอบนี้:** `ActionError` primitive + dispatch map flat body) ·
**BY-DESIGN:** S3 (Suspense). · **✅ static/public asset serving** (boot manifest, static-wins) ·
**✅ `<BrustPage head={[…]}>` typed head array + `dangerouslySetInnerHTML`**
(favicon auto-ref ปิดแล้ว: `head={[{tag:'link',rel:'icon',href:'/favicon.svg'}]}`) ·
**✅ S4/S6 (isomorphic store) — Spec A** (`signal`/`computed`/`defineStore`, window singleton + per-request ALS) ·
**✅ native interactivity (Spec B) — รอบนี้:** native page โต้ตอบได้โดยไม่ต้องมี React island ผ่าน **DOM directives**
(`x-data`/`x-props`/`x-text`/`x-show`/`x-bind-*`/`x-on-*`/`x-for`) + **single-file component** (`export const behavior`
ไฟล์เดียวกับ template; compiler `find_default_export` ผ่อนให้มี top-level statement อื่นได้). directive runtime
(`brustjs/native`, react-free, สร้างบน `effect`) bind DOM ผ่าน store เดียวกับ React island — **`AddToTeamButton`
เป็น native แล้ว** (เขียน `teamStore` → `TeamBuilder` island dock อัปเดต reactive ข้าม paradigm; TeamBuilder คง island
ไว้เป็น showcase). **ยังเลื่อน:** native store-snapshot SSR injection (store seed ผ่าน `init()` fetch), keyed `x-for` diff,
colon directive (`x-on:click` — compiler reject `:` ใช้ `x-on-click`).

## สรุปสั้น (native เขียนยังไงให้ผ่าน — หลัง Cluster A)

> กฎเหล็กเดิม "member-path + `.map()` เท่านั้น" **ผ่อนแล้ว** — native route body **ทำได้แล้ว**:
> conditionals (`{cond && <X/>}`, `{a ? b : c}` + comparison/logical test), `style={{…}}`
> object (auto-px), และ `<BrustPage title={d.x}>` dynamic head. **ยังต้อง precompute ใน loader:**
> helper calls, template-literals, arithmetic *as text/operand*, multi-property style strings.
> ทุกค่า dynamic ที่ออก HTML จะถูก **HTML-escape อัตโนมัติ** (XSS-safe). `lib/loaders.ts` จึงสั้นลง
> (ทิ้ง `xxxClass`/style-string workaround) — เทียบกับ commit `b667dda` ที่ loader เคยเป็น view layer ทั้งก้อน.

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
ดู spec S1. **dogfood:** `barWidth`/`iconColor`/`heroBg` เป็น bare value ป้อน `style={{…}}`
(`style={{ background: heroBg }}` — gradient string ผ่าน `| e` ได้ไม่โดน escape เพราะไม่มี `<>"'/&`).
หมายเหตุ: React type ของ `style` คือ `CSSProperties` object → `style={someString}` เป็น ts(2559),
ต้องใช้ `style={{ prop: value }}` เสมอ (string ล้วนใช้ไม่ได้แม้ native compiler จะรับ).

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

## ★ S12 — bodyless DELETE action → HTTP 411 · ✅ FIXED (แก้ framework แล้ว)

**fix:** server ทำตาม RFC 7230 §3.3.3 แล้ว — request ที่ **ไม่มี `Content-Length` และไม่มี
`Transfer-Encoding`** ถือว่า **ไม่มี body (length 0)** สำหรับทุก method → bodyless DELETE
ไม่ตอบ 411 อีกต่อไป. ส่วน `Transfer-Encoding` (ยังไม่รองรับ) → ตอบ 411. **dogfood:**
`api.team({id}).delete()` (bodyless) ทำงานได้แล้ว → **`.delete({})` workaround เลิกจำเป็น**
(bodyless `.delete()` ผ่าน 200).

**อาการเดิม:** ปุ่ม Remove เรียก `api.team({id}).delete()` แล้ว console ขึ้น:

```
Failed to load resource: the server responded with a status of 411
(Length Required) @ /_brust/action/team/6
```

**ทำไมเดิม:** action dispatch ฝั่ง Rust (`server.rs`) บังคับ `Content-Length` บนทุก method
ที่ไม่ใช่ GET/HEAD → ไม่มีก็ตอบ 411. แต่ `fetch(url,{method:'DELETE'})` ของ browser
**ไม่ส่ง `Content-Length: 0`** เมื่อไม่มี body. treaty client ก็ส่ง DELETE แบบไม่มี body.

**workaround เดิม (เลิกจำเป็นแล้ว):** เรียก **`api.team({id}).delete({})`** — ส่ง body `{}` (เพราะ treaty
ถือว่า delete ไม่ใช่ bodyless) → มี `Content-Length: 2` → ผ่าน 200. (ยืนยันเดิม: bodyless = 411,
มี `{}` = 200.) ตอนนี้ bodyless = 200 แล้ว.

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

## ◆ S9 — ไม่มี notFound()/redirect() sentinel; native loader ตั้ง status ไม่ได้ · ✅ FIXED (แก้ framework แล้ว)

**fix:** native route loader คืน sentinel ได้แล้ว — `return notFound(data)` (render template
ของ route ตัวเอง พร้อม HTTP 404) หรือ `return redirect(url, status?)` (3xx + `Location`,
**ไม่** render). `napi_render_jinja` เพิ่ม optional status param เพื่อให้ Rust ตั้ง HTTP status
จาก loader ได้. sentinel เป็น **symbol-keyed** (`Symbol.for('brust.nativeVerdict')` — plain object
ที่มี field `status` ไม่ถูกเข้าใจผิดว่าเป็น verdict) และ export จาก `brustjs/routes`.
**dogfood:** `detailLoader` คืน `notFound(emptyDetail(name))` แล้ว → `/pokemon/<ชื่อมั่ว>`
เป็น **HTTP 404** (เดิม 200). flag `notFound: true` บน data ยังขับ template 404-block (S11);
sentinel ขับ HTTP status — เสริมกัน. **ข้อจำกัด:** SPA-nav ไปหน้า verdict (404/redirect)
fall back เป็น full reload (documented limitation).

**อาการเดิม:** `/pokemon/<ชื่อมั่ว>` → PokeAPI 404 แต่หน้าเราตอบ **HTTP 200** พร้อม 404 body.

**ทำไมเดิม:** loader คืน data อย่างเดียว ไม่มี `notFound()`/`redirect()` และ native loader
ตั้ง HTTP status ไม่ได้ (status มาจาก render meta ฝั่ง React path).

**workaround เดิม (เลิกจำเป็นแล้ว):** loader คืน `notFound: true` + ผูก `notFoundClass`/`contentClass`
ให้ template สลับ block (ยัง 200). ตอนนี้ใช้ `return notFound(...)` ได้ → 404 จริง.

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

## ◆ `<BrustPage>` head ตั้ง tag เองไม่ได้ (link/meta/script/style) + ไม่มี raw-HTML escape hatch · ✅ FIXED

**fix (2 features):**
1. **`head={[…]}` typed array** — `<BrustPage head={[{ tag:'link', rel:'icon', href:'/favicon.svg' },
   { tag:'meta', property:'og:title', content: data.title }, { tag:'script', src:'/x.js', defer:true },
   { tag:'style', text:'.x{}' }]}>`. Allowlist `link|meta|base|style|script|noscript`; discriminated-union
   type คุม field per tag. **attr values = string literal หรือ member-path** (escape `{{ (p) | e }}` —
   dynamic ปลอดภัย); **`text` (style/script/noscript) = static literal เท่านั้น** emit raw
   (member-path ใน text ถูก reject กัน XSS); void tag (link/meta/base) self-close; camelCase→html
   (`crossOrigin`→`crossorigin`, `httpEquiv`→`http-equiv`). emit หลัง css link.
2. **`dangerouslySetInnerHTML={{ __html }}` บน host element** (div ฯลฯ) — raw-HTML escape hatch
   (= React semantics): literal → verbatim; member-path → `{{ (p) | safe }}`. element ห้ามมี children อื่น.
   **นี่คือทางทำ dynamic CSS/HTML** (trusted-data boundary — ห้ามต่อ user input, เหมือน React).

**dogfood:** minimal template + pokedex `PageLayout` ใช้ `head={[{tag:'link',rel:'icon',href:'/favicon.svg'}]}`
→ pokedex `/` view-source มี `<link rel="icon" href="/favicon.svg"/>` ใน `<head>` จริง. 14 compiler tests.
ดู spec `docs/superpowers/specs/2026-06-02-brustpage-head-array-design.md`.

**ยังเปิด:** `text` ของ style/script เป็น static-only (dynamic CSS/JS body ใช้ `dangerouslySetInnerHTML` แทน) ·
`<BrustPage>` ยังตั้ง `data-*` บน `<html>` ตามใจไม่ได้.

---

## ◆ S4 — ไม่มี cross-island shared-state primitive · ✅ FIXED (Spec A — isomorphic store)

**fix:** `brustjs/store` `defineStore(name, factory)` — บน client resolve เป็น instance เดียว
ต่อ `name` บน `window.__BRUST_STORES__` (island คนละ bundle เห็น instance เดียวกัน) แล้ว
`useStore(store)` (จาก `brustjs/client`, สร้างบน `useSyncExternalStore`) ให้ island re-render
ตาม store. **dogfood:** `stores/team.ts` = `defineStore('pokedex.team', …)`; `AddToTeamButton`
+ `TeamBuilder` เลิกใช้ event bus หันมา `useStore(teamStore)` + `teamStore.members.set(...)` ตอน
mutate → sync ข้าม island ผ่าน singleton. **ลบ `components/team-bus.ts` แล้ว.**

**ข้อจำกัด (Spec A):** native page **ไม่** server-seed store snapshot ลง HTML (ไม่มี
`<script data-brust-store>` ใน native) — TeamBuilder (ssr island) จึง drive first paint จาก
prop `teamInitial` จนกว่าจะ mounted แล้วค่อยสลับมาใช้ store (กัน hydration mismatch). การ
server-seed native client state เต็มรูปแบบ = **Spec B** (separate Alpine-style client script).

**อาการเดิม:** คนละ bundle → module store ถูก duplicate → ไม่ sync.
**workaround เดิม (เลิกใช้แล้ว):** `components/team-bus.ts` ใช้ `window` CustomEvent.

---

## ◆ S6 — ไม่มี request/session context; team store เป็น global · CONFIRMED

team store เป็น module-scope Map = แชร์ข้ามทุก request/ทุก visitor. action handler รับ
`{req,body,params,query}` แต่ไม่มี session/cookie helper. สำหรับ dogfood นี่โอเค แต่ทำ
multi-user ไม่ได้ถ้าไม่มี context primitive.

---

## ◆ S7 — typed domain-error ผ่าน treaty · ✅ FIXED (แก้ framework แล้ว)

**fix:** เพิ่ม primitive `ActionError` (`brustjs` export) — `throw new ActionError(status, code,
{ message?, data? })` จาก handler (หรือ business logic ลึกๆ / middleware) → `dispatchAction`
map เป็น HTTP non-2xx พร้อม **flat body** `{ code, message, data? }`. brand ด้วย
`Symbol.for('brust.actionError')` (กัน class identity แตกข้าม bundle — `isActionError` เช็ค brand
ไม่ใช่ `instanceof`). map ทั้ง **terminal catch** (handler throw) และ **outer chain() catch**
(middleware throw ก่อน `next()`) ผ่าน helper เดียว `actionErrorResponse` (body เหมือนกันเป๊ะ).
non-ActionError throw → ยัง 500 envelope `{error:{message,name}}` เดิม (ไม่ leak). ActionError
ไม่ถูก `console.error` (domain signal ไม่ใช่ bug). `code` เป็น discriminator แยก domain error
(flat, มี `code`) ออกจาก framework error (enveloped `{error:{…}}`). ดู spec/plan
`docs/superpowers/specs/2026-06-03-s7-typed-treaty-error-{design,plan}.md`. **dogfood:**
POST `/team` `throw new ActionError(409,'TEAM_FULL',{data:{max:MAX_TEAM}})` แทน `full` flag;
`AddToTeamButton` อ่าน `(error?.value as ActionErrorBody)?.code === 'TEAM_FULL'` → set signal `full`
(เลิก silent no-op + เลิกเช็ค `data.full`). 10 tests (5 unit + 5 dispatch incl middleware/respond+throw).

**✅ follow-up FIXED (B2, รอบนี้):** treaty proxy typed ต่อ endpoint สำหรับ **static path** แล้ว —
`opts.errors: { CODE: schema }` declaration → `EndpointEntry.error` (discriminated `{code,message,data}`
union); `Treaty<App>` ใหม่ (static-path node ∩ `PermissiveProxy` fallback) ให้ `api.team.post(b)` คืน
`TreatyResponse<Output, ErrorUnion>` typed — `AddToTeamButton` เลิก `as ActionErrorBody` cast,
อ่าน `error.value.code` typed ตรงๆ. **ยังเปิด (approach รอง):** param-path tracking
(`api.team({id}).delete()` → permissive `any` — Eden-scale, descoped); input(body) typing หลวม
(permissive intersection — value อยู่ที่ typed output+error). type-only → verify ผ่าน isolated
`bun run typecheck:treaty` (full tsc stack-overflows; wired เข้า ci.yml). spec
`docs/superpowers/specs/2026-06-03-s7-typed-treaty-client-design.md`.
**known limitation (dogfood UI):** `full` signal เป็น local ต่อปุ่ม — ถ้าได้ TEAM_FULL แล้วทีม
ว่างผ่าน TeamBuilder ทีหลัง label ค้าง 'Team Full' จน add สำเร็จครั้งถัดไป (เกิดเฉพาะ multi-client
race; `disabled()` กันเคสปกติอยู่แล้ว).

**อาการเดิม:** handler "ไม่ throw" ผ่าน boundary → "ทีมเต็ม" ต้อง encode ใน success payload เอง
(`{ team, max, full: true }`) แล้ว client เช็คสองที่ (`error` ของ transport + `data.full`).

---

## ○ S2 — ไม่มี loader batch/dedupe/request-cache · CONFIRMED

`typeChartLoader` ต้อง `Promise.all` 18 fetch เอง, ไม่มี request-scoped cache/dedupe.
list page เลี่ยง N+1 ด้วยการ derive artwork จาก id (ยิง PokeAPI ครั้งเดียว/หน้า) — workaround
ไม่ใช่ pattern ที่ framework เสนอ.

---

## ○ static/public asset serving · ✅ FIXED (แก้ framework แล้ว)

**fix:** server เสิร์ฟ `public/` ที่ root แล้ว — `public/favicon.svg` → `GET /favicon.svg`,
`public/img/x.png` → `/img/x.png`. boot เดิน `public/` ครั้งเดียวสร้าง manifest `URL→file`
(in-memory) แล้ว **static ชนะ app route** (ทุก `/_brust/*` handler ยัง `continue` ก่อน).
napi `configure_public_dir` ตั้ง dir per-mode (dev `<scanRoot>/public`, prebuilt `<dist>/public`);
`brust build` copy `public/`→`dist/public/`. Content-Type จาก extension; dev = `no-store`,
prod = `max-age=3600`. **Traversal-safe by construction** (request path เป็น map key ล้วน
ไม่ join กับ path), reserved `/_brust/` keys + symlink-escape ถูกตัดตอน build manifest.
**dogfood:** เพิ่ม `example/pokedex/public/favicon.svg` — `curl /favicon.svg` → 200 `image/svg+xml`.

**เดิม:** เสิร์ฟได้แค่ `/_brust/css/*` กับ `/_brust/islands/*` — ไม่มี public dir; `favicon.ico` 404.

**favicon auto-ref — ✅ ปิดแล้ว (รอบถัดมา):** `<BrustPage head={[{tag:'link',rel:'icon',
href:'/favicon.svg'}]}>` (typed head-entry array) → `<head>` emit `<link rel="icon" href="/favicon.svg"/>`
จริง (verify: pokedex `/` view-source). ทั้ง minimal template + pokedex ใช้แล้ว.

**ยังเปิด (related):**
- filename ต้อง URL-safe (ASCII, ไม่มี space) — request percent-encoded ไม่ match raw key
  (warn ตอน boot); percent-decode request path = deferred.
- ไม่มี hot-add ตอน dev run (manifest สร้างตอน boot — restart), GET-only, ไม่มี range/HEAD.

ดู spec `docs/superpowers/specs/2026-06-02-static-public-assets-design.md`.

---

## ○ native ใช้ component ใน body ลำบาก (chrome ซ้ำ 3 หน้า) · ✅ FIXED (component-composition)

**fix:** chrome (sidebar/topbar/team-dock) สกัดเป็น **`components/PageLayout.tsx`** อันเดียว แล้ว
แต่ละ route ใช้ root เป็น `<PageLayout native …>` — compiler **inline** ขยาย PageLayout ตอน build
แล้ว `<BrustPage>` ที่อยู่ root ของ expansion ถูก **promote เป็น document shell** (เหมือน route เขียน
`<BrustPage>` เอง). children (เนื้อหา native ของหน้า) ยัง compile เป็น jinja ตามปกติ — ไม่โดน
`renderToString`. PageLayout ต้อง **single-return ไม่มี local binding** (มี `const` = soft-fall-back
ไป SSR component = ไม่มี `<html>` shell) และ active-nav ใช้ conditional **elements** (S11) ไม่ใช่
className ternary. **dogfood:** ทั้ง 3 หน้าทิ้ง sidebar/topbar/Island ที่ซ้ำ เหลือแค่
`<PageLayout native title=… active=… crumb=… teamProps={…}>{inner}</PageLayout>`.

**✅ router-level injection — FIXED รอบนี้ (approach a, build-time desugar):** native รองรับ
**nested routes + `<Outlet/>`** แล้ว. author ประกาศ nesting ใน route tree (parent layout +
native children) แล้วเขียน `<Outlet/>` ใน layout ครั้งเดียว — framework ประกอบให้ (ไม่ต้อง wrap
`<PageLayout native>{children}</>` ทุก route). กลไก: `defineRoutes` ยอม native+children (ทั้ง
subtree ต้อง native), `emitNativeTemplates` synthesize per-leaf wrapper `<Parent native><Leaf
native/></Parent>` แล้ว reuse inline+splice machinery เดิม (compiler งานใหม่แค่ `<Outlet/>` builtin →
`ChildrenSlot`), chain loaders รัน top-down merge เป็น flat context เดียว (child-wins). Rust route
table ไม่แตะ (1 leaf → 1 composed template). **dogfood:** pokedex เหลือ `AppLayout` เดียว
(propless, `<Outlet/>`), 3 หน้าเป็น fragment, chrome (`title/active/crumb/teamProps`) มาจาก leaf
loader. ดู spec/plan `docs/superpowers/specs/2026-06-03-native-outlet-router-layout-{design,plan}.md`.

**ยังเปิด (out of scope → approach b):** layout duplicated ลงแต่ละ leaf template (build-time inline,
ไม่ share runtime); runtime separate-template composition (minijinja block override / template chain
ใน Rust); per-level loader scope (ตอนนี้ merge child-wins, collision เงียบ). convention: layout owns
`<main>` (leaf ห้ามมี — จะทำ SPA-nav extraction พัง).

---

## ○ nested `.map()` บน native · ✅ FIXED (verified + dogfooded)

**fix:** nested `.map()` **ทำงานบน native path อยู่แล้ว** (compiler recurse เข้า
`lower_call_as_map` ต่อ child ที่เป็น `.map()`, clone scope + push iter binding → inner body
resolve outer binding ได้). gap จริงคือ "ไม่มี fixture ยืนยัน เลยเลี่ยง" ไม่ใช่ compiler พัง.
รอบนี้ lock ด้วย **5 golden tests** (`native_nested_map_*` ใน `jsx-rust-compiler/src/lib.rs`:
member source · inner refs outer binding · 3-level · binding-is-array · per-item conditional)
+ **runtime render test** (`tests/jinja-route.test.ts` route `/_test/nested-map` → nested
`{% for %}` render ถูกผ่าน loader→SAB→minijinja). **dogfood:** type chart เลิก flatten —
`TypeChartData.rows[].cells[]` render ด้วย `rows.map(r => r.cells.map(c => …))` (`.dex-tc__row
{ display: contents }` คง CSS grid พิกเซลเท่าเดิม). ดู spec/plan
`docs/superpowers/specs/2026-06-03-native-nested-map-verify-{design,plan}.md`.

**อาการเดิม:** type chart 18×18 `rows.map(r => …r.cells.map(c => …))` ไม่มี golden fixture
รับรอง เลย flatten เป็น array เดียว 19×19 ใน loader แล้ว `.map()` ชั้นเดียวลง CSS grid.

**ยังเปิด (unchanged):** two-arg `(item, idx)` map (`MapIndexParamNotSupported`),
bare-fragment map body (`MapShapeNotSupported`).

---

## ○ dark-mode only — `<BrustPage>` ตั้งได้แค่ html class · ✅ FIXED (data-* บน `<html>` ได้แล้ว)

design ใช้ `[data-mode="dark"]` toggle. `<BrustPage>` **ตอนนี้รับ arbitrary `data-*` บน `<html>` ได้แล้ว**
(literal + member-path, HTML-escaped, ชื่อ lowercase) — `[data-mode]`-style theming hooks ทำงานได้.
ตัวอย่าง: `<BrustPage data-mode="dark">` → `<html lang="en" data-mode="dark">`.

**FULL dark-mode toggle** (cookie round-trip + toggle control island) ยังเลื่อน (composite feature) —
แต่ฝั่ง framework unblocked แล้ว: `className={d.themeClass}` (member-path, S8) + `data-mode={d.mode}` ทำได้พร้อมกัน.

> workaround เดิม: rewrite CSS เป็น `.dark` แล้ว `<html class="dark">` (ตัด toggle). ตอนนี้ไม่จำเป็นแล้ว.

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
