import { PageView, type Section } from './parts'

export default function SectionsPage({ sections }: { sections: Section[] }) {
  return <main><PageView sections={sections} /></main>
}
