import { PageView } from './PageView'
import type { Section } from './SectionView'

// F528: the route hands loader data to a chain of non-root components (PageView → SectionView → CustomSectionView →
// ElementView, which renders itself): fixed-props clones make every level static.
export default function SectionsPage({ page }: { page: { sections: Section[] } }) {
  return <PageView sections={page.sections} />
}
