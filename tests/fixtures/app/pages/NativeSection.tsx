import { BrustPage } from 'brustjs'
import SectionRenderer from '../components/SectionRenderer'

// R2+R3 E2E page — exercises all three compiler inline relaxations at once:
//   F1: dynamic <style> head text from loader data (per-tenant tokens use-case),
//       emitted through the `style_safe` breakout guard (`</` → `<\/`).
//   F2: const-bound style object inside the inlined HeroSection.
//   F3: SECTIONS map dispatch inside SectionRenderer, keyed by loader data.
export default function NativeSection({
  css,
  sectionKey,
  title,
}: {
  css: string
  sectionKey: string
  title: string
}) {
  return (
    <BrustPage title="section" head={[{ tag: 'style', text: css }]}>
      <main>
        <SectionRenderer native sectionKey={sectionKey} title={title} />
      </main>
    </BrustPage>
  )
}
