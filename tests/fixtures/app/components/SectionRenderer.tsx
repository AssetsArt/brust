import BannerSection from './BannerSection'
import HeroSection from './HeroSection'

// F3 (R3b) — component-map dispatch: a module-level (same-file) map of string
// keys → component idents, dispatched by a member-path expression. The compiler
// lowers this to a nested jinja if-chain with BOTH branches inlined; a key miss
// renders empty.
const SECTIONS = { hero: HeroSection, banner: BannerSection }

export default function SectionRenderer({
  sectionKey,
  title,
}: {
  sectionKey: string
  title: string
}) {
  const Comp = SECTIONS[sectionKey]
  return <Comp title={title} />
}
